// A stand-in for a model server with an OpenAI-compatible API (Ollama, LM
// Studio, llama.cpp, ...), for the unit and end-to-end tests. It answers the
// way such servers do, with text that depends only on the question, and keeps
// every request it gets so that a test can look at what was sent.
//
//   const server = await startFakeLlm()
//   server.url        // http://127.0.0.1:<port>/v1
//   server.requests   // [{ method, path, headers, body }]
//   server.state      // knobs, see below
//   await server.close()

import http from 'node:http'

/** The mistakes it corrects when asked to proofread. */
export const CORRECTIONS = [
  ['teh', 'the'],
  ['recieve', 'receive'],
  ['wich', 'which'],
  ['a eror', 'an error']
]

/** Continuations it offers: the end of the text before the cursor, and the reply (which repeats the last word, as asked). */
export const CONTINUATIONS = [
  ['Our method is', 'is faster than every method before it.'],
  ['The results are summarised in', 'in Table 1.'],
  ['writing assistant suggests', 'suggests the rest of the sentence.']
]

const send = (res, status, body, headers = {}) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/html' : 'application/json', ...headers })
  res.end(text)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function continuation(before) {
  for (const [end, reply] of CONTINUATIONS) if (before.trimEnd().endsWith(end)) return reply
  const word = /[\p{L}\p{N}]+$/u.exec(before)?.[0]
  return word ? `${word} and so on.` : 'and so on.'
}

const capital = (word) => word[0].toUpperCase() + word.slice(1)

function corrected(text) {
  let out = text
  for (const [wrong, right] of CORRECTIONS) {
    out = out.replace(new RegExp(`\\b${wrong}\\b`, 'g'), right).replace(new RegExp(`\\b${capital(wrong)}\\b`, 'g'), capital(right))
  }
  return out
}

export async function startFakeLlm(options = {}) {
  const requests = []
  const state = {
    models: options.models ?? ['fake-writer', 'text-embedding-fake'],
    /** When set, requests need "Authorization: Bearer <key>". */
    key: options.key ?? null,
    /** Milliseconds before an answer starts. */
    delayMs: 0,
    /** Milliseconds between the parts of a streamed answer. */
    chunkDelayMs: 5,
    /**
     * Replies with reasoning first, the way reasoning models do: 'inline' (in
     * <think>), 'separate' (reasoning_content) or null. Unless the request
     * turns thinking off, as llama.cpp or Ollama take it.
     */
    think: null,
    /** Who runs the server, as its list of models says ("llamacpp", "library" for Ollama, ...). */
    owner: options.owner ?? 'fake',
    /** Refuses requests with fields it does not know, as a strict server does. */
    strict: false,
    /** The next chat request fails with this: { status, body }. */
    fail: null,
    /** Answers streamed requests all at once, like a server that does not stream. */
    noStreaming: false,
    /** Stops a streamed answer after this many characters, as if its length limit was reached. */
    cutAt: null,
    /** Closes a streamed answer after this many characters, without saying that it is over. */
    dropAt: null,
    /** Reports a failure in the middle of a streamed answer: 'field' (as llama.cpp does) or 'event'. */
    streamError: null,
    /** How the lines of a streamed answer end. */
    lineEnd: '\n',
    /** Keeps a streamed answer's connection open after its end, as a server with keep-alive pings may. */
    holdOpen: false,
    /** Requests that were cancelled by the client before they were answered. */
    aborted: 0,
    /** Connections that the client closed after it had the whole answer. */
    closedAfterEnd: 0
  }

  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    let body = null
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {
      return send(res, 400, { error: { message: 'Request body is not JSON', type: 'invalid_request_error' } })
    }
    const path = new URL(req.url, 'http://x').pathname
    const entry = { method: req.method, path, headers: req.headers, body }
    requests.push(entry)
    let closed = false
    res.on('close', () => {
      if (!res.writableEnded) {
        closed = true
        state.aborted++
      }
    })

    if (state.key && req.headers.authorization !== `Bearer ${state.key}`) {
      return send(res, 401, { error: { message: 'Invalid API key', type: 'invalid_request_error' } })
    }
    if (req.method === 'GET' && path === '/v1/models') {
      return send(res, 200, { object: 'list', data: state.models.map((id) => ({ id, object: 'model', owned_by: state.owner })) })
    }
    if (req.method !== 'POST' || path !== '/v1/chat/completions') {
      // As LM Studio does it: status 200, with an error.
      return send(res, 200, { error: `Unexpected endpoint or method. (${req.method} ${path})` })
    }
    if (state.fail) {
      const { status, body: failure } = state.fail
      state.fail = null
      return send(res, status, failure)
    }
    if (state.strict) {
      const known = new Set(['model', 'messages', 'max_tokens', 'temperature', 'top_p', 'stop', 'stream', 'seed'])
      const unknown = Object.keys(body ?? {}).find((field) => !known.has(field))
      if (unknown) {
        return send(res, 400, { error: { message: `Unrecognized request argument supplied: ${unknown}`, type: 'invalid_request_error' } })
      }
    }
    if (!state.models.includes(body?.model)) {
      return send(res, 404, { error: { message: `model "${body?.model}" not found, try pulling it first`, type: 'api_error' } })
    }
    const thinks = state.think && body.chat_template_kwargs?.enable_thinking !== false && body.reasoning_effort !== 'none'

    const system = body.messages?.find((m) => m.role === 'system')?.content ?? ''
    const last = body.messages?.at(-1)?.content ?? ''
    let reply = 'ready'
    if (system.includes('autocomplete')) {
      // The cursor is shown in front of the word that is being typed, which the request names.
      const excerpt = last.slice(last.indexOf('Excerpt:\n') + 'Excerpt:\n'.length)
      const typed = /At <CURSOR> the writer has typed "(.*)" so far\./.exec(last)?.[1] ?? ''
      reply = continuation(excerpt.slice(0, excerpt.indexOf('<CURSOR>')) + typed)
    } else if (system.includes('proofreader')) {
      reply = corrected(last)
    }

    if (state.delayMs) await sleep(state.delayMs)
    if (closed) return
    const thought = 'Let me think about what fits here.'
    const content = thinks && state.think === 'inline' ? `<think>${thought}</think>${reply}` : reply
    const finish = state.cutAt !== null && content.length > state.cutAt ? 'length' : 'stop'
    const text = finish === 'length' ? content.slice(0, state.cutAt) : content

    if (!body.stream || state.noStreaming) {
      const message = { role: 'assistant', content: text }
      if (thinks && state.think === 'separate') message.reasoning_content = thought
      return send(res, 200, {
        id: 'chatcmpl-fake',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message, finish_reason: finish }]
      })
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const nl = state.lineEnd
    const event = (data) => res.write(`data: ${JSON.stringify(data)}${nl}${nl}`)
    const chunk = (delta, finishReason = null) =>
      event({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finishReason }] })
    res.write(`: a comment, which clients ignore${nl}${nl}`)
    chunk({ role: 'assistant', content: '' })
    if (thinks && state.think === 'separate') chunk({ reasoning_content: thought })
    const upTo = state.dropAt ?? text.length
    for (let i = 0; i < upTo; i += 7) {
      if (closed) return
      chunk({ content: text.slice(i, Math.min(i + 7, upTo)) })
      if (state.chunkDelayMs) await sleep(state.chunkDelayMs)
    }
    if (state.dropAt !== null) return res.end()
    if (state.streamError === 'field') {
      res.write(`error: ${JSON.stringify({ code: 500, message: 'context shift is disabled', type: 'server_error' })}${nl}${nl}`)
      return res.end()
    }
    if (state.streamError === 'event') {
      res.write(`event: error${nl}data: ${JSON.stringify({ error: { message: 'the model crashed' } })}${nl}${nl}`)
      return res.end()
    }
    chunk({}, finish)
    res.write(`data: [DONE]${nl}${nl}`)
    if (!state.holdOpen) return res.end()
    const ping = setInterval(() => res.write(`: ping${nl}${nl}`), 100)
    res.on('close', () => {
      clearInterval(ping)
      state.closedAfterEnd++
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    state,
    /** The chat requests, newest last. */
    chats: () => requests.filter((r) => r.path === '/v1/chat/completions'),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
  }
}
