// The writing assistant: suggestions from a language model that runs on a
// server of the user's choosing (Ollama, LM Studio, llama.cpp, ...), through
// the OpenAI-compatible HTTP API that all of them offer. Underleaf ships no
// model. It sends text only while the assistant is turned on, and only to the
// address that the user gave.
//
// Two things are asked of the model:
// - the words that continue the text at the cursor (shown as a suggestion in
//   the editor), and
// - a corrected version of a passage (shown as changes to accept or reject).
//
// No Electron imports: the module is unit-tested under plain Node.

import {
  MAX_PROOFREAD_CHARS,
  type AssistantCheck,
  type AssistantSettings,
  type DetectedServer,
  type InlineRequest,
  type InlineResult,
  type ProofreadRequest,
  type ProofreadResult
} from '@shared/types'

export type AssistantErrorKind =
  /** The assistant is turned off. */
  | 'off'
  /** Something is missing or wrong in the settings. */
  | 'setup'
  /** The server could not be reached. */
  | 'unreachable'
  /** The server answered with an error. */
  | 'server'
  /** The answer is not what an OpenAI-compatible server sends. */
  | 'answer'
  | 'timeout'
  | 'cancelled'

export class AssistantError extends Error {
  constructor(
    message: string,
    readonly kind: AssistantErrorKind,
    /** For an error that the server answered with: its HTTP status and what it said. */
    readonly http?: { status: number; said: string }
  ) {
    super(message)
    this.name = 'AssistantError'
  }
}

/**
 * How to ask a server to leave out a reasoning model's thinking (Qwen 3, for
 * one, thinks before it answers unless told not to), by who runs the server
 * as its list of models says. Servers that are not known here get nothing:
 * one that checks its requests strictly would refuse a field it does not know.
 */
export function noThinkingFields(owner: string | null): Record<string, unknown> | null {
  switch (owner) {
    case 'llamacpp':
    case 'vllm':
    case 'sglang':
      // Passed on to the model's chat template, which has this switch.
      return { chat_template_kwargs: { enable_thinking: false } }
    case 'library': // Ollama
    case 'ollama':
      return { reasoning_effort: 'none' }
    default:
      return null
  }
}

/** The server refused a request because of a field in it. */
function refusesField(err: unknown): boolean {
  return (
    err instanceof AssistantError &&
    (err.http?.status === 400 || err.http?.status === 422) &&
    /think|reason|chat_template|unrecogni[sz]ed|unknown|unsupported|extra|not permitted|invalid/i.test(err.http.said)
  )
}

export interface Probe {
  name: string
  port: number
}

export interface AssistantDeps {
  settings(): AssistantSettings
  /**
   * The API key for the server at this origin (scheme, host and port), if one
   * was entered for it. A key belongs to the server it was entered for, and is
   * sent to no other.
   */
  apiKey(origin: string): Promise<string | null>
  /** Where `detect` looks for servers; the ports that the usual ones listen on by default. */
  probes?: Probe[]
  fetch?: typeof fetch
  /** Shorter waits, for the tests. */
  timeouts?: Partial<Timeouts>
}

interface Timeouts {
  models: number
  probe: number
  /** A server may have to load the model first, which can take a while. */
  inline: number
  check: number
  /** Until a streamed answer starts. */
  firstByte: number
  /** Between the parts of a streamed answer. */
  idle: number
}

const TIMEOUTS: Timeouts = {
  models: 10_000,
  probe: 1500,
  inline: 60_000,
  check: 180_000,
  firstByte: 180_000,
  idle: 60_000
}

/** The ports that model servers listen on unless told otherwise. */
export const DEFAULT_PROBES: Probe[] = [
  { name: 'Ollama', port: 11434 },
  { name: 'LM Studio', port: 1234 },
  { name: 'llama.cpp', port: 9931 },
  { name: 'llama.cpp', port: 8080 },
  { name: 'Jan', port: 1337 },
  { name: 'vLLM', port: 8000 },
  { name: 'KoboldCpp', port: 5001 }
]

/** At most this much text around the cursor is sent for a suggestion. */
export const MAX_BEFORE = 6000
export const MAX_AFTER = 2000
const MAX_PROOFREAD = MAX_PROOFREAD_CHARS

const MAX_JSON_BYTES = 1024 * 1024
const PROGRESS_EVERY_MS = 120

const OFF = 'The writing assistant is turned off. Turn it on in Settings → Writing assistant.'

// ------------------------------------------------------------- addresses

/**
 * The base address of the API, from what the user typed: "localhost:11434"
 * becomes http://localhost:11434/v1, and a full endpoint such as
 * .../v1/chat/completions is cut back to .../v1.
 */
export function serverBase(raw: string): URL {
  const text = String(raw ?? '').trim()
  if (!text) {
    throw new AssistantError('Enter the address of the model server first (Settings → Writing assistant).', 'setup')
  }
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`)
  } catch {
    throw new AssistantError(`"${text}" is not a web address.`, 'setup')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AssistantError(`The address of a model server starts with http:// or https://, not ${url.protocol}//.`, 'setup')
  }
  if (url.username || url.password) {
    throw new AssistantError('Put the password in the API key field instead of in the address.', 'setup')
  }
  url.search = ''
  url.hash = ''
  let pathname = url.pathname.replace(/\/+$/, '')
  pathname = pathname.replace(/\/(chat\/completions|completions|models)$/i, '')
  url.pathname = pathname === '' ? '/v1' : pathname
  return url
}

function endpoint(base: URL, path: string): string {
  return `${base.href.replace(/\/+$/, '')}/${path}`
}

/** True when the server runs on this computer, so that what is sent to it stays here. */
export function isLocalAddress(raw: string): boolean {
  let host: string
  try {
    host = serverBase(raw).hostname.toLowerCase()
  } catch {
    return true // nothing is sent to an address that is not one
  }
  host = host.replace(/^\[|\]$/g, '')
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host === '::'
  )
}

// ---------------------------------------------------------------- prompts

type Message = { role: 'system' | 'user' | 'assistant'; content: string }

const INLINE_SYSTEM = [
  'You are the autocomplete of a LaTeX editor. You are shown an excerpt of a document in which <CURSOR> marks where the writer is typing.',
  'Reply with the text that the writer most likely types at <CURSOR>: the rest of the sentence, or of the line of LaTeX code.',
  'Rules:',
  '- Reply with that text only: no explanation, no quotation marks, no Markdown.',
  '- When the writer has already typed part of a word at <CURSOR>, begin your reply with those letters, and complete the word.',
  '- Do not write what comes after <CURSOR> already.',
  '- Stop at the end of the sentence or line. Never write more than one sentence.',
  "- Use the document's language, notation and LaTeX conventions."
].join('\n')

/** The word that the cursor is at the end of: what is typed of it so far. */
const typedWord = (before: string): string => /[\p{L}\p{N}_]+$/u.exec(before)?.[0] ?? ''

/**
 * Whether the writer is about to start a new word after a pause right behind
 * a word, or is still typing that word ("the" or "theory"), cannot be told
 * from the text. So the cursor is shown in front of that word, and the model
 * is asked to begin its reply with what is typed of it: its reply then says
 * which it is, space and all ("the theory", "theory").
 */
function inlinePrompt(path: string, before: string, after: string): string {
  const word = typedWord(before)
  const head = `File: ${path || 'document.tex'}\nExcerpt:\n${before.slice(0, before.length - word.length)}<CURSOR>${after}`
  return word ? `${head}\n\nAt <CURSOR> the writer has typed "${word}" so far. Begin your reply with "${word}".` : head
}

// Two worked examples: they show the form of an answer better than rules do.
const INLINE_EXAMPLES: Message[] = [
  {
    role: 'user',
    content: inlinePrompt(
      'notes.tex',
      'The kinetic energy of a body of mass $m$ moving at speed $v$ is giv',
      '\n\n\\section{Momentum}'
    )
  },
  { role: 'assistant', content: 'given by $E_k = \\frac{1}{2} m v^2$.' },
  { role: 'user', content: inlinePrompt('paper.tex', 'We thank ', ' for their helpful comments.') },
  { role: 'assistant', content: 'the anonymous referees' }
]

function inlineMessages(path: string, before: string, after: string): Message[] {
  return [{ role: 'system', content: INLINE_SYSTEM }, ...INLINE_EXAMPLES, { role: 'user', content: inlinePrompt(path, before, after) }]
}

const PROOFREAD_SYSTEM = [
  'You are a careful proofreader of LaTeX documents. The user sends a passage of LaTeX source.',
  'Correct mistakes of spelling, grammar and punctuation, and words that are plainly wrong.',
  'Keep everything else exactly as it is: LaTeX commands and environments, mathematics, labels, citations, references, comments, line breaks and indentation, and the wording and style of the author. Do not rephrase what is correct, and do not add or leave out anything.',
  'Reply with the corrected passage only, without any explanation and without Markdown. If there is nothing to correct, reply with the passage unchanged.'
].join('\n')

// --------------------------------------------------------------- answers

/**
 * Reasoning models write out their deliberation between <think> and </think>
 * before the answer, and some servers pass it on as part of the answer.
 * `unfinished`: the answer ended while the model was still thinking.
 * `context` is the text that the model was given: when that has such tags
 * itself (a paper about reasoning models), the answer is left as it is.
 */
export function stripThinking(text: string, context = ''): { text: string; unfinished: boolean } {
  if (/<\/?think>/i.test(context)) return { text, unfinished: false }
  let out = text
  const block = /^\s*<think>[\s\S]*?<\/think>\s*/i.exec(out)
  if (block) {
    out = out.slice(block[0].length)
  } else {
    // The opening tag can be part of the prompt template, so that only the closing one shows.
    const close = /<\/think>\s*/i.exec(out)
    if (close) out = out.slice(close.index + close[0].length)
  }
  if (/^\s*<think>/i.test(out)) return { text: '', unfinished: true }
  return { text: out, unfinished: false }
}

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch)
const CLOSERS = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', '$'])
const OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
/** A suggestion is cut down to this many characters. */
const MAX_SUGGESTION = 400

/** The same letter, whatever its case. */
const sameLetter = (a: string, b: string): boolean => a === b || a.toLowerCase() === b.toLowerCase()

/**
 * `text` ends with `end`, letter case aside. Compared character by character,
 * so that positions stay right where a letter changes its length with its
 * case (the Turkish "İ").
 */
function endsWithLoosely(text: string, end: string): boolean {
  if (end.length > text.length) return false
  const offset = text.length - end.length
  for (let i = 0; i < end.length; i++) if (!sameLetter(text[offset + i], end[i])) return false
  return true
}

/**
 * The text before the cursor ends with a mark that a new word follows with a
 * space: the end of a sentence or clause, a closing parenthesis, or the "$"
 * that closes a formula on the current line.
 */
function endsClause(before: string): boolean {
  const last = before.at(-1)
  const line = before.slice(before.lastIndexOf('\n') + 1)
  // Inside braces it is a key or a file name: \ref{fig:a}, \cite{a,b}, {plot.png}.
  if (last === undefined || /\{[^{}]*$/.test(line)) return false
  if ('.,;:!?)'.includes(last)) return true
  if (last === '$') return (line.replace(/\\\$/g, '').split('$').length - 1) % 2 === 0
  return false
}

/**
 * Whether the last character of a suggestion closes something that was opened
 * before the cursor, rather than something opened in the suggestion itself.
 */
function closesOutside(text: string, ch: string): boolean {
  const plain = text.replace(/\\[{}$]/g, '') // \{ \} \$ are characters, not groups
  const count = (c: string): number => plain.split(c).length - 1
  if (ch === '$') return count('$') % 2 === 1
  const opener = OPENER[ch]
  return opener === undefined || count(ch) > count(opener)
}

/**
 * Turns what a model replied into the text to insert at the cursor. Chat
 * models do not keep to the letter of the instructions: they repeat what is
 * there already, wrap the answer in quotation marks or Markdown, and go on
 * past the cursor into the text that follows it.
 */
export function cleanCompletion(raw: string, before: string, after: string): string {
  let text = raw.replace(/\r\n?/g, '\n')
  const fenced = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text)
  if (fenced) text = fenced[1]
  text = text.replace(/<\/?CURSOR>/g, '')
  const quoted = /^\s*(["“])([\s\S]+)(["”])\s*$/.exec(text)
  if (quoted && !/["“]\s*$/.test(before) && !/["“”]/.test(quoted[2])) text = quoted[2]

  // What is there already, said again: the end of the text before the cursor.
  // As asked, the reply begins with what is typed of the word at the cursor:
  // "experi" comes back as "experimental", "the" as "the theory". Longer
  // repeats are only taken for repeats when they start at the start of a
  // word, or are long enough not to be a coincidence.
  const word = typedWord(before)
  if (word) text = text.replace(/^\s+/, '')
  const tail = before.slice(-500)
  let overlap = 0
  for (let k = Math.min(text.length, tail.length); k > 0; k--) {
    if (!endsWithLoosely(tail, text.slice(0, k))) continue
    const startsWord = !isWordChar(tail[tail.length - k - 1]) || tail.length === k
    if (k >= 12 || (startsWord && isWordChar(text[0]))) overlap = k
    break
  }
  // A reply that does not begin with the typed letters leaves it open whether
  // it continues that word or starts a new one. Better no suggestion than
  // "propo pose" or "theproblem".
  if (word && overlap < word.length) return ''
  text = text.slice(overlap)
  if (/[ \t]$/.test(before)) text = text.replace(/^[ \t]+/, '')
  // The punctuation mark that is there already, once more: "40%." + ".".
  const mark = before.at(-1)
  if (mark && '.,;:!?'.includes(mark) && text.startsWith(mark)) text = text.slice(1)
  // A new word after a full stop, a comma or a formula, which the model began
  // without a space (chat models drop the space at the start of an answer).
  if (!word && /^[\p{L}\p{N}\\]/u.test(text) && endsClause(before)) text = ` ${text}`

  // What follows the cursor, written as well.
  const rest = after.split('\n')[0]
  if (rest.trim()) {
    for (let k = Math.min(text.length, rest.length); k >= 4; k--) {
      if (endsWithLoosely(text, rest.slice(0, k))) {
        text = text.slice(0, text.length - k)
        break
      }
    }
    // The bracket or $ that closes what was opened before the cursor is there
    // already (the editor puts it in with the opening one); one that the
    // suggestion opened itself belongs to it.
    const trimmed = text.trimEnd()
    const last = trimmed.at(-1)
    if (last && CLOSERS.has(last) && rest.startsWith(last) && closesOutside(trimmed, last)) text = trimmed.slice(0, -1)
  }

  // One sentence or line: never a new paragraph, and inside a line not a new line.
  const blank = text.search(/\n[ \t]*\n/)
  if (blank >= 0) text = text.slice(0, blank)
  if (rest.trim()) text = text.split('\n')[0]
  if (text.length > MAX_SUGGESTION) {
    const cut = text.lastIndexOf(' ', MAX_SUGGESTION)
    text = text.slice(0, cut > MAX_SUGGESTION / 2 ? cut : MAX_SUGGESTION)
  }
  text = text.replace(/\s+$/, '')
  return text.trim() ? text : ''
}

const wordsOf = (line: string): string[] => line.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

/** Most words of `a` are in `b`: a line and its corrected version. */
function similar(a: string, b: string): boolean {
  const words = wordsOf(a)
  const there = new Set(wordsOf(b))
  return words.length > 0 && words.filter((w) => there.has(w)).length / words.length >= 0.5
}

/** Where the paragraph with the given number starts (paragraphs are set apart by empty lines). */
function paragraphStart(text: string, index: number): number {
  const gap = /\n[ \t]*\n/g
  let seen = 0
  for (let m = gap.exec(text); m; m = gap.exec(text)) {
    if (++seen === index) return m.index
  }
  return text.length
}

const PARAGRAPHS = /\n[ \t]*\n/

/**
 * Turns what a model replied into the corrected passage. What the model said
 * around the passage is only recognised as such when the answer has more to
 * it than the passage had: a line more in front, a paragraph more after.
 */
export function cleanProofread(raw: string, original: string): string {
  let text = raw.replace(/\r\n?/g, '\n')
  const fenced = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text)
  if (fenced && !original.trimStart().startsWith('```')) text = fenced[1]
  // A line in front of the passage: "Here is the corrected text:".
  const lines = text.trim().split('\n')
  const originalLines = original.trim().split('\n')
  const first = lines[0].trim()
  if (
    lines.length > originalLines.length &&
    first.endsWith(':') &&
    /\b(correct|proofread|revis|fix|here|sure)/i.test(first) &&
    !similar(first, originalLines[0])
  ) {
    lines.shift()
    while (lines.length > 0 && !lines[0].trim()) lines.shift()
    text = lines.join('\n')
  }
  // Remarks after it, in a paragraph of their own: "Changes: ...".
  const paragraphs = text.trim().split(PARAGRAPHS)
  const originalParagraphs = original.trim().split(PARAGRAPHS)
  if (
    paragraphs.length > originalParagraphs.length &&
    /^\s*(?:\*\*|#+\s*)?(notes?|changes|corrections|explanation|i (have )?(corrected|fixed|changed))\b/i.test(
      paragraphs[originalParagraphs.length]
    )
  ) {
    const trimmed = text.trim()
    text = trimmed.slice(0, paragraphStart(trimmed, originalParagraphs.length))
  }
  const lead = /^\s*/.exec(original)?.[0] ?? ''
  const trail = /\s*$/.exec(original)?.[0] ?? ''
  return lead + text.trim() + trail
}

// ------------------------------------------------------------------- HTTP

/** One request: its cancellation and its clock. */
class Exchange {
  readonly controller = new AbortController()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(readonly kind: 'inline' | 'proofread' | 'other') {}

  get signal(): AbortSignal {
    return this.controller.signal
  }

  /** (Re)starts the clock: the request fails when nothing happens for so long. */
  deadline(ms: number, message: string): void {
    this.clear()
    this.timer = setTimeout(() => this.controller.abort(new AssistantError(message, 'timeout')), ms)
    this.timer.unref?.()
  }

  cancel(): void {
    this.controller.abort(new AssistantError('Cancelled', 'cancelled'))
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

/** What a server said about an error, from a body that may or may not be JSON. */
function serverMessage(body: string): string {
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    const error = data?.error as unknown
    if (typeof error === 'string') return error.trim()
    if (error && typeof (error as { message?: unknown }).message === 'string') {
      return String((error as { message: string }).message).trim()
    }
    if (typeof data?.message === 'string') return data.message.trim()
    if (typeof data?.detail === 'string') return data.detail.trim()
  } catch {
    /* not JSON */
  }
  return body
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

function httpError(status: number, body: string, base: URL, path: string): AssistantError {
  const said = serverMessage(body)
  const detail = said ? `: ${said}` : ''
  const http = { status, said }
  if (status === 401 || status === 403) {
    return new AssistantError(
      `The model server refused the request (${status})${detail}. If it needs an API key, enter it in the settings.`,
      'server',
      http
    )
  }
  if (status === 404 && !/model/i.test(said)) {
    return new AssistantError(
      `The server at ${base.host} has nothing at ${base.pathname}/${path} (404). Check the address: for most servers it ends in /v1.`,
      'setup',
      http
    )
  }
  if (status >= 500) return new AssistantError(`The model server ran into a problem (${status})${detail}`, 'server', http)
  return new AssistantError(said ? serverSays(said) : `The model server did not accept the request (${status}).`, 'server', http)
}

/** An error message of the server, with advice when it means that the address is wrong. */
function serverSays(said: string): string {
  const advice = /endpoint|route|no such|unknown (path|url)/i.test(said) ? ' Check the address: for most servers it ends in /v1.' : ''
  return `The model server says: ${said.replace(/\.?$/, '.')}${advice}`
}

/** A failed request, told in words that say what to do about it. */
function failure(err: unknown, ex: Exchange, base: URL): AssistantError {
  if (err instanceof AssistantError) return err
  const reason = ex.signal.reason as unknown
  if (ex.signal.aborted && reason instanceof AssistantError) return reason
  const cause = (err as { cause?: unknown })?.cause
  const code = String((cause as { code?: unknown })?.code ?? (err as { code?: unknown })?.code ?? '')
  const where = base.host
  switch (code) {
    case 'ECONNREFUSED':
      return new AssistantError(`No model server answers at ${where}. Is it running?`, 'unreachable')
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new AssistantError(`The address ${base.hostname} cannot be found.`, 'unreachable')
    case 'ECONNRESET':
    case 'EPIPE':
    case 'UND_ERR_SOCKET':
      return new AssistantError(`The model server at ${where} closed the connection.`, 'unreachable')
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
      return new AssistantError(`The model server at ${where} did not answer in time.`, 'timeout')
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'CERT_HAS_EXPIRED':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return new AssistantError(`The certificate of ${where} is not trusted (${code}).`, 'unreachable')
  }
  const message = cause instanceof Error ? cause.message : err instanceof Error ? err.message : String(err)
  return new AssistantError(`The model server at ${where} could not be reached (${code || message}).`, 'unreachable')
}

async function readText(res: Response, ex: Exchange, base: URL, max: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      if (text.length > max) {
        ex.cancel()
        throw new AssistantError(`The answer of ${base.host} is far longer than any answer to this question.`, 'answer')
      }
    }
  } catch (err) {
    throw failure(err, ex, base)
  }
  return text + decoder.decode()
}

const notOpenAi = (base: URL): string =>
  `The answer of ${base.host} is not one of an OpenAI-compatible server. Check the address: for most servers it ends in /v1.`

interface ServerEvent {
  /** "message", unless the server named it ("error", for one). */
  event: string
  data: string
}

/**
 * The events of a stream of server-sent events, as Ollama, LM Studio and the
 * others send them. When the caller stops early, the connection is closed.
 */
async function* serverSentEvents(res: Response, ex: Exchange, base: URL, idleMs: number): AsyncGenerator<ServerEvent> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  let event = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      ex.deadline(idleMs, 'The model server stopped answering.')
      buffer += done ? decoder.decode() + '\n\n' : decoder.decode(value, { stream: true })
      // Lines end with CRLF, LF or CR alone.
      for (let end = /\r\n|\r|\n/.exec(buffer); end; end = /\r\n|\r|\n/.exec(buffer)) {
        // A CR at the very end may be the first half of a CRLF that is still on its way.
        if (end[0] === '\r' && end.index === buffer.length - 1 && !done) break
        const line = buffer.slice(0, end.index)
        buffer = buffer.slice(end.index + end[0].length)
        if (line === '') {
          if (data.length > 0) yield { event: event || 'message', data: data.join('\n') }
          data = []
          event = ''
        } else if (line.startsWith('data:')) {
          data.push(line.slice(line[5] === ' ' ? 6 : 5))
        } else if (line.startsWith('event:')) {
          event = line.slice(6).trim()
        } else if (line.startsWith('error:')) {
          // Not a field of the standard, but how llama.cpp's server reports a failure mid-stream.
          event = 'error'
          data.push(line.slice(6).trim())
        }
        // Comments (":") and the other fields ("id:", "retry:") carry nothing needed here.
      }
      if (done) return
    }
  } catch (err) {
    throw failure(err, ex, base)
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

interface ChatReply {
  content: string
  /** The server reported reasoning apart from the answer. */
  reasoning: boolean
  finish: string | null
}

function choiceOf(data: Record<string, unknown>): Record<string, unknown> | null {
  const choices = data.choices
  return Array.isArray(choices) && choices.length > 0 && choices[0] && typeof choices[0] === 'object'
    ? (choices[0] as Record<string, unknown>)
    : null
}

function reasoningOf(part: Record<string, unknown> | undefined): boolean {
  const thought = part?.reasoning_content ?? part?.reasoning
  return typeof thought === 'string' && thought.length > 0
}

// ----------------------------------------------------------------- client

export class AssistantClient {
  private readonly fetchImpl: typeof fetch
  private readonly timeouts: Timeouts
  private readonly active = new Map<string, Exchange>()
  /** Who runs the server at each address (as its list of models says); null: it does not say. */
  private readonly owners = new Map<string, string | null>()
  /** Addresses whose server refused the fields that turn thinking off. */
  private readonly refused = new Set<string>()

  constructor(private readonly deps: AssistantDeps) {
    this.fetchImpl = deps.fetch ?? fetch
    this.timeouts = { ...TIMEOUTS, ...deps.timeouts }
  }

  private base(): URL {
    return serverBase(this.deps.settings().url)
  }

  private model(): string {
    const model = this.deps.settings().model.trim()
    if (!model) throw new AssistantError('Choose a model first (Settings → Writing assistant).', 'setup')
    return model
  }

  private requireOn(): void {
    if (!this.deps.settings().enabled) throw new AssistantError(OFF, 'off')
  }

  /** Starts a request; one of the same kind that is still running is pointless now. */
  private begin(id: string | null, kind: Exchange['kind']): Exchange {
    if (kind !== 'other') for (const ex of this.active.values()) if (ex.kind === kind) ex.cancel()
    const ex = new Exchange(kind)
    if (id) this.active.set(id, ex)
    return ex
  }

  private end(id: string | null, ex: Exchange): void {
    ex.clear()
    if (id && this.active.get(id) === ex) this.active.delete(id)
  }

  /** Stops a request. Its caller is answered with null. */
  cancel(id: string): void {
    this.active.get(id)?.cancel()
  }

  cancelAll(): void {
    for (const ex of this.active.values()) ex.cancel()
  }

  private async send(
    base: URL,
    path: string,
    ex: Exchange,
    body?: unknown,
    key: string | null = null
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json, text/event-stream' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (key) headers.authorization = `Bearer ${key}`
    try {
      return await this.fetchImpl(endpoint(base, path), {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ex.signal
      })
    } catch (err) {
      throw failure(err, ex, base)
    }
  }

  /** The body of a successful answer, as JSON. */
  private async json(res: Response, ex: Exchange, base: URL, path: string): Promise<Record<string, unknown>> {
    const body = await readText(res, ex, base, MAX_JSON_BYTES)
    if (!res.ok) throw httpError(res.status, body, base, path)
    let data: unknown
    try {
      data = JSON.parse(body)
    } catch {
      throw new AssistantError(notOpenAi(base), 'answer')
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AssistantError(notOpenAi(base), 'answer')
    const error = (data as { error?: unknown }).error
    // LM Studio, for one, answers some failures with status 200 and an error.
    if (error) throw new AssistantError(serverSays(serverMessage(JSON.stringify(data))), 'server')
    return data as Record<string, unknown>
  }

  private async listModels(base: URL, key: string | null, ex: Exchange): Promise<string[]> {
    const data = await this.json(await this.send(base, 'models', ex, undefined, key), ex, base, 'models')
    const list = data.data ?? data.models
    if (!Array.isArray(list)) throw new AssistantError(notOpenAi(base), 'answer')
    const owner = list
      .map((m: unknown) => (m as { owned_by?: unknown })?.owned_by)
      .find((o): o is string => typeof o === 'string' && o !== '')
    this.owners.set(base.href, owner?.toLowerCase() ?? null)
    const ids = list
      .map((m: unknown) =>
        typeof m === 'string' ? m : typeof (m as { id?: unknown })?.id === 'string' ? (m as { id: string }).id : null
      )
      .filter((id): id is string => !!id && !/embed|rerank/i.test(id))
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  }

  /** The text models that the configured server offers. */
  async models(): Promise<string[]> {
    const base = this.base()
    const ex = this.begin(null, 'other')
    try {
      ex.deadline(this.timeouts.models, `The model server at ${base.host} did not answer in time.`)
      return await this.listModels(base, await this.deps.apiKey(base.origin), ex)
    } finally {
      this.end(null, ex)
    }
  }

  /** Model servers that answer on this computer, at the ports they use by default. */
  async detect(): Promise<DetectedServer[]> {
    const probes = this.deps.probes ?? DEFAULT_PROBES
    const found = await Promise.all(
      probes.map(async (probe): Promise<DetectedServer | null> => {
        const base = new URL(`http://127.0.0.1:${probe.port}/v1`)
        const ex = this.begin(null, 'other')
        try {
          ex.deadline(this.timeouts.probe, 'no answer')
          // Never with the API key: it is not for whatever listens on these ports.
          const models = await this.listModels(base, null, ex)
          return { name: probe.name, url: base.href, models }
        } catch {
          return null
        } finally {
          this.end(null, ex)
        }
      })
    )
    return found.filter((s): s is DetectedServer => s !== null)
  }

  /**
   * The fields that ask this server to leave out a reasoning model's thinking,
   * if it takes any. What the server is comes from its list of models, which
   * is asked for once.
   */
  private async thinkingOff(base: URL, key: string | null, ex: Exchange): Promise<Record<string, unknown> | null> {
    if (this.refused.has(base.href)) return null
    if (!this.owners.has(base.href)) {
      try {
        await this.listModels(base, key, ex)
      } catch (err) {
        if (failure(err, ex, base).kind === 'cancelled') throw err
        this.owners.set(base.href, null)
      }
    }
    return noThinkingFields(this.owners.get(base.href) ?? null)
  }

  /**
   * Makes a chat request with the fields that turn thinking off; a server
   * that refuses them gets the request again without them, from then on.
   */
  private async withThinkingOff<T>(
    base: URL,
    key: string | null,
    ex: Exchange,
    body: Record<string, unknown>,
    run: (body: Record<string, unknown>) => Promise<T>
  ): Promise<T> {
    const extra = await this.thinkingOff(base, key, ex)
    if (!extra) return run(body)
    try {
      return await run({ ...body, ...extra })
    } catch (err) {
      if (!refusesField(err)) throw err
      this.refused.add(base.href)
      return run(body)
    }
  }

  private async chat(
    base: URL,
    key: string | null,
    body: Record<string, unknown>,
    ex: Exchange
  ): Promise<ChatReply> {
    const data = await this.withThinkingOff(base, key, ex, { ...body, stream: false }, async (request) =>
      this.json(await this.send(base, 'chat/completions', ex, request, key), ex, base, 'chat/completions')
    )
    const choice = choiceOf(data)
    if (!choice) throw new AssistantError(notOpenAi(base), 'answer')
    const message = (choice.message ?? {}) as Record<string, unknown>
    const content = typeof message.content === 'string' ? message.content : typeof choice.text === 'string' ? choice.text : ''
    return { content, reasoning: reasoningOf(message), finish: typeof choice.finish_reason === 'string' ? choice.finish_reason : null }
  }

  /** Tries the server and the model: the models it has, and how quickly the model answers. */
  async check(): Promise<AssistantCheck> {
    const base = this.base()
    const key = await this.deps.apiKey(base.origin)
    const ex = this.begin(null, 'other')
    try {
      ex.deadline(this.timeouts.models, `The model server at ${base.host} did not answer in time.`)
      const models = await this.listModels(base, key, ex)
      const model = this.model()
      ex.deadline(this.timeouts.check, `The model ${model} did not answer within three minutes.`)
      const started = Date.now()
      await this.chat(base, key, { model, messages: [{ role: 'user', content: 'Reply with the word: ready' }], max_tokens: 8, temperature: 0 }, ex)
      return { models, model, ms: Date.now() - started }
    } finally {
      this.end(null, ex)
    }
  }

  /** The words that continue the text at the cursor. Null: the request was replaced or cancelled. */
  async complete(request: InlineRequest): Promise<InlineResult | null> {
    this.requireOn()
    const settings = this.deps.settings()
    if (settings.inline === 'off' || (request.trigger === 'auto' && settings.inline !== 'auto')) return null
    const base = this.base()
    const model = this.model()
    const key = await this.deps.apiKey(base.origin)
    const before = request.before.slice(-MAX_BEFORE)
    const after = request.after.slice(0, MAX_AFTER)
    const midLine = after.split('\n')[0].trim() !== ''
    const ex = this.begin(request.id, 'inline')
    try {
      ex.deadline(this.timeouts.inline, `The model ${model} did not answer within a minute.`)
      const reply = await this.chat(
        base,
        key,
        {
          model,
          messages: inlineMessages(request.path, before, after),
          max_tokens: 48,
          temperature: 0.2,
          stop: midLine ? ['\n'] : ['\n\n']
        },
        ex
      )
      const visible = stripThinking(reply.content, before + after)
      const text = cleanCompletion(visible.text, before, after)
      return text ? { text } : { text: '', thinking: visible.unfinished || reply.reasoning || undefined }
    } catch (err) {
      const e = failure(err, ex, base)
      if (e.kind === 'cancelled') return null
      throw e
    } finally {
      this.end(request.id, ex)
    }
  }

  /**
   * A corrected version of a passage. `onProgress` is told the answer so far
   * as it comes in. Null: the request was cancelled.
   */
  async proofread(
    request: ProofreadRequest,
    onProgress: (text: string, thinking: boolean) => void = () => undefined
  ): Promise<ProofreadResult | null> {
    this.requireOn()
    const original = request.text
    if (!original.trim()) throw new AssistantError('There is no text to proofread.', 'setup')
    if (original.length > MAX_PROOFREAD) {
      throw new AssistantError(
        `The passage is too long to proofread in one go (at most ${MAX_PROOFREAD.toLocaleString('en-US')} characters). Select a shorter part.`,
        'setup'
      )
    }
    const base = this.base()
    const model = this.model()
    const key = await this.deps.apiKey(base.origin)
    const ex = this.begin(request.id, 'proofread')
    const limit = original.length * 4 + 4000
    try {
      ex.deadline(this.timeouts.firstByte, `The model ${model} did not start to answer within three minutes.`)
      const body = {
        model,
        messages: [
          { role: 'system', content: PROOFREAD_SYSTEM },
          { role: 'user', content: original }
        ],
        temperature: 0,
        stream: true
      }
      const res = await this.withThinkingOff(base, key, ex, body, async (request) => {
        const answer = await this.send(base, 'chat/completions', ex, request, key)
        if (!answer.ok) throw httpError(answer.status, await readText(answer, ex, base, MAX_JSON_BYTES), base, 'chat/completions')
        return answer
      })

      let content = ''
      let reasoning = false
      let finish: string | null = null
      /** The answer came to its end, as opposed to a connection that just closed. */
      let ended = false
      let reported = 0
      const report = (force: boolean): void => {
        const now = Date.now()
        if (!force && now - reported < PROGRESS_EVERY_MS) return
        reported = now
        const visible = stripThinking(content, original)
        onProgress(visible.text, visible.unfinished || (reasoning && !visible.text))
      }

      if (/json/i.test(res.headers.get('content-type') ?? '') && !/event-stream/i.test(res.headers.get('content-type') ?? '')) {
        // A server that does not stream answers all at once.
        const data = await this.json(res, ex, base, 'chat/completions')
        const choice = choiceOf(data)
        if (!choice) throw new AssistantError(notOpenAi(base), 'answer')
        const message = (choice.message ?? {}) as Record<string, unknown>
        content = typeof message.content === 'string' ? message.content : ''
        reasoning = reasoningOf(message)
        finish = typeof choice.finish_reason === 'string' ? choice.finish_reason : null
        ended = true
      } else {
        for await (const { event, data: raw } of serverSentEvents(res, ex, base, this.timeouts.idle)) {
          if (event === 'error') throw new AssistantError(serverSays(serverMessage(raw)), 'server')
          if (raw.trim() === '[DONE]') {
            ended = true
            break
          }
          let data: Record<string, unknown>
          try {
            data = JSON.parse(raw) as Record<string, unknown>
          } catch {
            throw new AssistantError(notOpenAi(base), 'answer')
          }
          if (data.error) throw new AssistantError(serverSays(serverMessage(raw)), 'server')
          const choice = choiceOf(data)
          const part = (choice?.delta ?? choice?.message ?? undefined) as Record<string, unknown> | undefined
          if (typeof part?.content === 'string') content += part.content
          if (reasoningOf(part)) reasoning = true
          if (typeof choice?.finish_reason === 'string') finish = choice.finish_reason
          if (content.length > limit) {
            ex.cancel()
            throw new AssistantError('The model kept on writing far beyond the passage, so its answer was not used.', 'answer')
          }
          report(false)
        }
      }
      report(true)

      const visible = stripThinking(content, original)
      if (!visible.text.trim()) {
        throw new AssistantError(
          visible.unfinished || reasoning
            ? 'The model spent its whole answer on thinking and wrote no corrected text. Try a model without a reasoning phase.'
            : 'The model sent back no text.',
          'answer'
        )
      }
      return {
        text: cleanProofread(visible.text, original),
        // Cut off by a limit, or by a connection that closed before the end.
        truncated: finish === 'length' || visible.unfinished || !(ended || (finish !== null && finish !== 'length'))
      }
    } catch (err) {
      const e = failure(err, ex, base)
      if (e.kind === 'cancelled') return null
      throw e
    } finally {
      this.end(request.id, ex)
    }
  }
}
