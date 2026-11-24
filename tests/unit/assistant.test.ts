import net from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AssistantClient,
  AssistantError,
  cleanCompletion,
  cleanProofread,
  isLocalAddress,
  serverBase,
  stripThinking
} from '../../src/main/assistant'
import type { AssistantSettings } from '../../src/shared/types'
import { startFakeLlm, type FakeLlm } from '../fixtures/fake-llm.mjs'

/** A port on which nothing listens (it was free a moment ago). */
async function closedPort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as net.AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function failure(promise: Promise<unknown>): Promise<AssistantError> {
  try {
    await promise
  } catch (err) {
    if (err instanceof AssistantError) return err
    throw err
  }
  throw new Error('expected the promise to fail')
}

describe('the address of the server', () => {
  it('is completed and cut back to the base of the API', () => {
    expect(serverBase('localhost:11434').href).toBe('http://localhost:11434/v1')
    expect(serverBase(' http://127.0.0.1:1234 ').href).toBe('http://127.0.0.1:1234/v1')
    expect(serverBase('http://127.0.0.1:1234/v1/').href).toBe('http://127.0.0.1:1234/v1')
    expect(serverBase('http://host:8080/v1/chat/completions').href).toBe('http://host:8080/v1')
    expect(serverBase('https://example.org/api/openai/v1/models?x=1#y').href).toBe('https://example.org/api/openai/v1')
    expect(serverBase('http://host/custom').href).toBe('http://host/custom')
  })

  it('must be a web address, without a password in it', () => {
    expect(() => serverBase('')).toThrow(/Enter the address/)
    expect(() => serverBase('ftp://host/v1')).toThrow(/http:\/\/ or https:\/\//)
    expect(() => serverBase('http://user:secret@host/v1')).toThrow(/API key field/)
    expect(() => serverBase('http://exa mple')).toThrow(/not a web address/)
  })

  it('is on this computer only when it is a loopback address', () => {
    for (const local of ['localhost:11434', 'http://127.0.0.1:1234/v1', 'http://[::1]:8080', 'http://app.localhost/v1', '0.0.0.0:8080']) {
      expect(isLocalAddress(local), local).toBe(true)
    }
    for (const remote of ['http://192.168.1.20:11434', 'https://api.example.com/v1', 'http://my-desktop:1234']) {
      expect(isLocalAddress(remote), remote).toBe(false)
    }
  })
})

describe('what a model replies', () => {
  it('loses the thinking of a reasoning model', () => {
    expect(stripThinking('<think>Hmm, maybe.</think>\nThe answer.')).toEqual({ text: 'The answer.', unfinished: false })
    expect(stripThinking('Hmm, maybe.</think>The answer.')).toEqual({ text: 'The answer.', unfinished: false })
    expect(stripThinking('<think>Still thinking when the answer ran out')).toEqual({ text: '', unfinished: true })
    expect(stripThinking('Plain answer')).toEqual({ text: 'Plain answer', unfinished: false })
  })

  it('becomes exactly the text to insert at the cursor', () => {
    const cases: Array<[raw: string, before: string, after: string, expected: string]> = [
      // As asked, the reply begins with what is typed of the word at the
      // cursor, and so says whether it goes on with that word or starts a new one.
      ['the method works well.', 'The results show that the', '', ' method works well.'],
      ['theoretical framework.', 'We studied the', '', 'oretical framework.'],
      ['experimental results agree.', 'The experi', '', 'mental results agree.'],
      ['a good example.', 'This is a', '', ' good example.'],
      ['propose a new method.', 'In this paper, we propo', '', 'se a new method.'],
      ['is $\\frac{1}{3}$.', 'The integral of $x^2$ from $0$ to $1$ is', '\n', ' $\\frac{1}{3}$.'],
      ['section{Results}', '\\section', '', '{Results}'],
      ['f(x) for all x.', 'Let f', '', '(x) for all x.'],
      // A reply that does not begin with them leaves that open: no suggestion.
      ['properties of light.', 'We studied the', '', ''],
      ['pose a new method.', 'In this paper, we propo', '', ''],
      // After a space, the reply is what follows.
      ['properties of light.', 'We studied the ', '', 'properties of light.'],
      ['the properties', 'We studied the ', '', 'properties'],
      // After a full stop, a comma or a formula, a new word needs a space ...
      ['The next one.', 'This is the end.', '', ' The next one.'],
      ['is the input.', 'where $x$', '', ' is the input.'],
      // A full stop that is there already is not suggested again.
      ['.', 'The noise was reduced by 40\\%.', '\n', ''],
      ['. Then more.', 'It ends here.', '', ' Then more.'],
      // ... but not inside braces, where it is part of a key or a file name.
      ['error', 'As shown in Figure~\\ref{fig:', '}', 'error'],
      ['lamport94', '\\cite{knuth84,', '}', 'lamport94'],
      // A longer repeat of what is there, in other capitals.
      ['As shown in Table 1, the accuracy improves.', 'prior work. As shown in Table 1, the', '', ' accuracy improves.'],
      // Wrapped in Markdown or quotation marks.
      ['```latex\n\\frac{1}{2}\n```', 'is $', '$.', '\\frac{1}{2}'],
      ['"method is faster than before."', 'Our method', '', ' is faster than before.'],
      // Going on into what follows the cursor.
      ['the referees for their help.', 'We thank ', ' for their help.', 'the referees'],
      ['are important results.', 'These are', '.', ' important results'],
      ['important}', '\\textbf{', '}', 'important'],
      // At most a sentence: no new paragraph, and inside a line no new line.
      ['sentence ends here.\n\nA new paragraph.', 'The sentence', '', ' ends here.'],
      ['The first line\nsecond line', 'The', ' rest of the line', ' first line'],
      // At the start of a line, the indentation stays.
      ['    \\item First point', '\\begin{itemize}\n', '\n\\end{itemize}', '    \\item First point'],
      // Nothing left.
      ['', 'Some text', '', ''],
      ['the', 'In the', '', ''],
      ['<CURSOR>', 'Text', '', '']
    ]
    for (const [raw, before, after, expected] of cases) {
      expect(cleanCompletion(raw, before, after), JSON.stringify({ raw, before, after })).toBe(expected)
    }
  })

  it('keeps the brackets and dollar signs that it opens itself', () => {
    // The editor puts in a closing bracket with the opening one, so the cursor
    // often sits right in front of one.
    const cases: Array<[raw: string, before: string, after: string, expected: string]> = [
      ['Section~\\ref{sec:setup}', '\\section{Results for ', '}', 'Section~\\ref{sec:setup}'],
      ['the survey by Knuth~\\cite{knuth84}', '\\footnote{See also ', '}', 'the survey by Knuth~\\cite{knuth84}'],
      ['f(x)', 'the value (of the function ', ') is', 'f(x)'],
      ['x^{2}', '$\\sqrt{', '}$', 'x^{2}'],
      ['$f(x)$', '(see ', ')', '$f(x)$'],
      // ... but not the one that closes what was opened before the cursor.
      ['important}', '\\textbf{', '}', 'important'],
      ['y + 1$', '$x = ', '$', 'y + 1'],
      ['a \\{set\\}}', '\\emph{', '}', 'a \\{set\\}'],
      ['(see above))', 'as before (', ')', '(see above)']
    ]
    for (const [raw, before, after, expected] of cases) {
      expect(cleanCompletion(raw, before, after), JSON.stringify({ raw, before, after })).toBe(expected)
    }
  })

  it('copes with letters whose lower case is longer than they are', () => {
    // Turkish "İ" becomes two characters in lower case.
    expect(cleanCompletion("İstanbul'da yapıldı.", 'Bu çalışma İstan', '')).toBe("bul'da yapıldı.")
    expect(cleanCompletion('İzmir ve İstanbul arasında.', 'Deneyler İzm', '')).toBe('ir ve İstanbul arasında.')
    expect(cleanCompletion('works well.', 'The method İ works', '')).toBe(' well.')
    expect(cleanCompletion("Ankara ve İstanbul'da", 'Toplantılar Ankara', " ve İstanbul'da yapıldı.")).toBe('')
  })

  it('is cut down to a reasonable length', () => {
    const long = Array.from({ length: 200 }, () => 'word').join(' ')
    const text = cleanCompletion(long, 'Start ', '')
    expect(text.length).toBeLessThanOrEqual(400)
    expect(text.endsWith('word')).toBe(true)
  })

  it('becomes the corrected passage, without what the model said around it', () => {
    expect(cleanProofread('The results are good.', 'Teh results are good.\n')).toBe('The results are good.\n')
    expect(cleanProofread('Here is the corrected text:\n\nThe results are good.', 'Teh results are good.')).toBe('The results are good.')
    expect(cleanProofread('```latex\nThe results.\n```', 'Teh results.')).toBe('The results.')
    expect(cleanProofread('The results.\n\nChanges: corrected "Teh".', 'Teh results.')).toBe('The results.')
    // The line breaks and the indentation around the passage are those of the original.
    expect(cleanProofread('A line.\nAnother.', '  A lien.\nAnother.\n\n')).toBe('  A line.\nAnother.\n\n')
    // A passage that itself says "Notes" keeps it.
    expect(cleanProofread('Intro.\n\nNotes on the method follow.', 'Intro.\n\nNotes on teh method follow.')).toBe(
      'Intro.\n\nNotes on the method follow.'
    )
  })

  it('keeps the lines of the passage that look like what models say around it', () => {
    // A first line of the passage that ends with a colon, corrected.
    const notation = 'We fix teh following notation:\n\\begin{itemize}\n\\item $n$ samples.\n\\end{itemize}'
    expect(cleanProofread(notation.replace('teh', 'the'), notation)).toBe(notation.replace('teh', 'the'))
    const here = 'Teh results are shown here:\n\\begin{table}\n\\end{table}'
    expect(cleanProofread(here.replace('Teh', 'The'), here)).toBe(here.replace('Teh', 'The'))
    // Even when the correction leaves hardly a word of that line as it was.
    const garbled = 'Teh resluts ar heer:\n\\begin{table}\n\\end{table}'
    expect(cleanProofread('The results are here:\n\\begin{table}\n\\end{table}', garbled)).toBe(
      'The results are here:\n\\begin{table}\n\\end{table}'
    )
    // A paragraph of the passage that starts with "Changes" or "Note" once corrected.
    const rain = 'Temperatures rose.\n\nChnages in rainfall were smaller.\n\nA third paragraph.'
    expect(cleanProofread(rain.replace('Chnages', 'Changes'), rain)).toBe(rain.replace('Chnages', 'Changes'))
    expect(cleanProofread('First.\n\nNote that the bound is tight.', 'First.\n\nNot that the bound is tight.')).toBe(
      'First.\n\nNote that the bound is tight.'
    )
  })

  it('is taken as it is when the passage itself is about thinking tags', () => {
    const passage = 'The model closes its reasoning with \\texttt{</think>}; teh answer follows.'
    const answer = 'The model closes its reasoning with \\texttt{</think>}; the answer follows.'
    expect(stripThinking(answer, passage)).toEqual({ text: answer, unfinished: false })
    const opening = 'Reasoning is wrapped in \\verb|<think>| tags, wich the client hides.'
    expect(stripThinking(opening.replace('wich', 'which'), opening).text).toBe(opening.replace('wich', 'which'))
    // Without such tags in the passage, a reasoning block in front of the answer still goes.
    expect(stripThinking('<think>Fix the typo.</think>The answer.', 'Teh answer.').text).toBe('The answer.')
  })
})

describe('the client, with a server', () => {
  let server: FakeLlm
  let settings: AssistantSettings
  let key: string | null
  let client: AssistantClient

  beforeEach(async () => {
    server = await startFakeLlm()
    settings = { enabled: true, url: server.url, model: 'fake-writer', inline: 'auto' }
    key = null
    client = new AssistantClient({
      settings: () => settings,
      apiKey: async () => key,
      timeouts: { inline: 3000, models: 3000, check: 3000, firstByte: 3000, idle: 3000, probe: 500 }
    })
  })

  afterEach(async () => {
    await server.close()
  })

  it('lists the text models of the server', async () => {
    server.state.models = ['zeta', 'Alpha', 'nomic-embed-text', 'beta', 'bge-reranker']
    expect(await client.models()).toEqual(['Alpha', 'beta', 'zeta'])
    expect(server.requests.at(-1)).toMatchObject({ method: 'GET', path: '/v1/models' })
    expect(server.requests.at(-1)?.headers.authorization).toBeUndefined()
  })

  it('sends the API key, and says so when the server refuses it', async () => {
    server.state.key = 'secret-key'
    expect((await failure(client.models())).message).toMatch(/refused the request \(401\): Invalid API key\. If it needs an API key/)
    key = 'secret-key'
    expect(await client.models()).toEqual(['fake-writer'])
    expect(server.requests.at(-1)?.headers.authorization).toBe('Bearer secret-key')
  })

  it('asks for the key of the server it talks to, by its origin', async () => {
    const asked: string[] = []
    const keyed = new AssistantClient({
      settings: () => settings,
      // A key that was entered for another server is not handed out for this one.
      apiKey: async (origin) => {
        asked.push(origin)
        return origin === 'https://other.example' ? 'not-for-this-server' : null
      }
    })
    await keyed.models()
    await keyed.complete({ id: 'k', path: 'a.tex', before: 'Our method is', after: '', trigger: 'auto' })
    expect(asked).toEqual([new URL(server.url).origin, new URL(server.url).origin])
    expect(server.requests.every((r) => r.headers.authorization === undefined)).toBe(true)
  })

  it('finds servers on this computer, without handing them the key', async () => {
    key = 'not-for-them'
    const nobody = await closedPort()
    const detecting = new AssistantClient({
      settings: () => settings,
      apiKey: async () => key,
      probes: [
        { name: 'Fake', port: server.port },
        { name: 'Nobody', port: nobody }
      ]
    })
    expect(await detecting.detect()).toEqual([{ name: 'Fake', url: `http://127.0.0.1:${server.port}/v1`, models: ['fake-writer'] }])
    expect(server.requests.every((r) => r.headers.authorization === undefined)).toBe(true)
  })

  it('tries the configured model', async () => {
    const check = await client.check()
    expect(check).toMatchObject({ models: ['fake-writer'], model: 'fake-writer' })
    expect(check.ms).toBeGreaterThanOrEqual(0)
    expect(server.chats().at(-1)?.body).toMatchObject({ model: 'fake-writer', max_tokens: 8, stream: false })

    settings.model = 'llama-9000'
    expect((await failure(client.check())).message).toBe('The model server says: model "llama-9000" not found, try pulling it first.')
    settings.model = ''
    expect((await failure(client.check())).message).toMatch(/Choose a model first/)
  })

  it('asks for the continuation in a way that any chat model understands', async () => {
    const result = await client.complete({
      id: 'r1',
      path: 'chapters/intro.tex',
      before: '\\section{Speed}\nOur method is',
      after: '\n\nMore text.',
      trigger: 'auto'
    })
    expect(result).toEqual({ text: ' faster than every method before it.' })
    const body = server.chats().at(-1)?.body
    expect(body).toMatchObject({ model: 'fake-writer', max_tokens: 48, temperature: 0.2, stop: ['\n\n'], stream: false })
    expect(body.messages[0]).toMatchObject({ role: 'system' })
    // The cursor is shown in front of the word that is being typed.
    expect(body.messages.at(-1)).toEqual({
      role: 'user',
      content:
        'File: chapters/intro.tex\nExcerpt:\n\\section{Speed}\nOur method <CURSOR>\n\nMore text.\n\nAt <CURSOR> the writer has typed "is" so far. Begin your reply with "is".'
    })
    // Within a line, the answer must not go on to the next one.
    await client.complete({ id: 'r2', path: 'a.tex', before: 'Our method is', after: ' really fast.', trigger: 'auto' })
    expect(server.chats().at(-1)?.body.stop).toEqual(['\n'])
  })

  it('suggests only as often as the settings allow, and nothing while it is off', async () => {
    const request = { id: 'r', path: 'a.tex', before: 'Our method is', after: '', trigger: 'auto' as const }
    settings.inline = 'manual'
    expect(await client.complete(request)).toBeNull()
    expect(await client.complete({ ...request, trigger: 'manual' })).toEqual({ text: ' faster than every method before it.' })
    settings.inline = 'off'
    expect(await client.complete({ ...request, trigger: 'manual' })).toBeNull()
    settings.enabled = false
    expect((await failure(client.complete(request))).kind).toBe('off')
    expect((await failure(client.proofread({ id: 'p', path: 'a.tex', text: 'Teh end.' }))).kind).toBe('off')
    expect(server.chats()).toHaveLength(1)
  })

  it('drops a question that a newer one replaced, and one that was cancelled', async () => {
    server.state.delayMs = 400
    const first = client.complete({ id: 'old', path: 'a.tex', before: 'Our method is', after: '', trigger: 'auto' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const second = client.complete({ id: 'new', path: 'a.tex', before: 'The results are summarised in', after: '', trigger: 'auto' })
    expect(await first).toBeNull()
    expect(await second).toEqual({ text: ' Table 1.' })

    const third = client.complete({ id: 'gone', path: 'a.tex', before: 'Our method is', after: '', trigger: 'manual' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    client.cancel('gone')
    expect(await third).toBeNull()
    // The server learns of it: it can stop working on the answer.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(server.state.aborted).toBe(2)
  })

  it('asks llama.cpp and Ollama to leave out the thinking of a reasoning model', async () => {
    server.state.think = 'separate'
    const fields = [
      ['llamacpp', { chat_template_kwargs: { enable_thinking: false } }],
      ['library', { reasoning_effort: 'none' }]
    ] as const
    for (const [owner, field] of fields) {
      server.state.owner = owner
      const fresh = new AssistantClient({ settings: () => settings, apiKey: async () => null })
      expect(await fresh.complete({ id: owner, path: 'a.tex', before: 'Our method is', after: '', trigger: 'auto' }), owner).toEqual({
        text: ' faster than every method before it.'
      })
      expect(server.chats().at(-1)?.body).toMatchObject(field)
      expect(await fresh.proofread({ id: 'p', path: 'a.tex', text: 'Teh end.' })).toEqual({ text: 'The end.', truncated: false })
      expect(server.chats().at(-1)?.body).toMatchObject(field)
    }
    // A server that does not say who runs it is sent no such field.
    server.state.owner = 'fake'
    await new AssistantClient({ settings: () => settings, apiKey: async () => null }).check()
    expect(Object.keys(server.chats().at(-1)?.body)).not.toContain('chat_template_kwargs')
    expect(Object.keys(server.chats().at(-1)?.body)).not.toContain('reasoning_effort')
  })

  it('asks again without those fields when the server refuses them, and leaves them out from then on', async () => {
    server.state.owner = 'llamacpp'
    server.state.strict = true
    const fresh = new AssistantClient({ settings: () => settings, apiKey: async () => null })
    expect(await fresh.complete({ id: 'a', path: 'a.tex', before: 'Our method is', after: '', trigger: 'auto' })).toEqual({
      text: ' faster than every method before it.'
    })
    expect(server.chats().at(-2)?.body.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(server.chats().at(-1)?.body.chat_template_kwargs).toBeUndefined()
    const asked = server.chats().length
    expect(await fresh.proofread({ id: 'p', path: 'a.tex', text: 'Teh end.' })).toEqual({ text: 'The end.', truncated: false })
    expect(server.chats().length).toBe(asked + 1)
    expect(server.chats().at(-1)?.body.chat_template_kwargs).toBeUndefined()
  })

  it('says when a reasoning model used its whole answer for thinking', async () => {
    server.state.think = 'inline'
    expect(await client.complete({ id: 'a', path: 'a.tex', before: 'Our method is', after: '', trigger: 'auto' })).toEqual({
      text: ' faster than every method before it.'
    })
    server.state.cutAt = 20 // within the thinking
    expect(await client.complete({ id: 'b', path: 'a.tex', before: 'Our method is', after: '', trigger: 'auto' })).toEqual({
      text: '',
      thinking: true
    })
  })

  it('streams the corrected passage', async () => {
    const progress: string[] = []
    const original = 'We recieve teh data, wich is noisy.\n'
    const result = await client.proofread({ id: 'p1', path: 'a.tex', text: original }, (text) => progress.push(text))
    expect(result).toEqual({ text: 'We receive the data, which is noisy.\n', truncated: false })
    const body = server.chats().at(-1)?.body
    expect(body).toMatchObject({ model: 'fake-writer', temperature: 0, stream: true })
    // No limit of its own on the answer's length: the server knows its model's.
    expect(body.max_tokens).toBeUndefined()
    expect(body.messages).toEqual([
      { role: 'system', content: expect.stringContaining('proofreader') },
      { role: 'user', content: original }
    ])
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.at(-1)).toBe('We receive the data, which is noisy.\n')
  })

  it('takes an answer that is not streamed, and says when one was cut off', async () => {
    server.state.noStreaming = true
    expect(await client.proofread({ id: 'p', path: 'a.tex', text: 'Teh end.' })).toEqual({ text: 'The end.', truncated: false })
    server.state.noStreaming = false
    server.state.cutAt = 10
    expect(await client.proofread({ id: 'p', path: 'a.tex', text: 'We recieve teh data.' })).toEqual({ text: 'We receive', truncated: true })
  })

  it('takes the corrected passage from a reasoning model', async () => {
    for (const think of ['inline', 'separate'] as const) {
      server.state.think = think
      const thinking: boolean[] = []
      const result = await client.proofread({ id: 'p', path: 'a.tex', text: 'Teh end.' }, (_t, busy) => thinking.push(busy))
      expect(result, think).toEqual({ text: 'The end.', truncated: false })
    }
    server.state.think = 'inline'
    server.state.cutAt = 15
    expect((await failure(client.proofread({ id: 'p', path: 'a.tex', text: 'Teh end.' }))).message).toMatch(/spent its whole answer on thinking/)
  })

  it('says that an answer is cut off when its connection closes before the end', async () => {
    server.state.dropAt = 14
    const result = await client.proofread({ id: 'p', path: 'a.tex', text: 'We recieve teh data, wich is noisy.' })
    expect(result).toEqual({ text: 'We receive the', truncated: true })
  })

  it('reports a failure in the middle of a streamed answer', async () => {
    server.state.streamError = 'field'
    expect((await failure(client.proofread({ id: 'p', path: 'a.tex', text: 'Teh end.' }))).message).toBe(
      'The model server says: context shift is disabled.'
    )
    server.state.streamError = 'event'
    expect((await failure(client.proofread({ id: 'p', path: 'a.tex', text: 'Teh end.' }))).message).toBe(
      'The model server says: the model crashed.'
    )
  })

  it('reads streams whose lines end with CR or CRLF', async () => {
    for (const lineEnd of ['\r', '\r\n']) {
      server.state.lineEnd = lineEnd
      expect(await client.proofread({ id: 'p', path: 'a.tex', text: 'We recieve teh data.' }), JSON.stringify(lineEnd)).toEqual({
        text: 'We receive the data.',
        truncated: false
      })
    }
  })

  it('closes the connection once the answer is complete', async () => {
    server.state.holdOpen = true
    expect(await client.proofread({ id: 'p', path: 'a.tex', text: 'Teh end.' })).toEqual({ text: 'The end.', truncated: false })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(server.state.closedAfterEnd).toBe(1)
  })

  it('refuses passages that are too long or empty, and stops when cancelled', async () => {
    expect((await failure(client.proofread({ id: 'p', path: 'a.tex', text: 'x'.repeat(6001) }))).message).toMatch(/too long/)
    expect((await failure(client.proofread({ id: 'p', path: 'a.tex', text: '  \n' }))).message).toMatch(/no text/)
    server.state.chunkDelayMs = 50
    let seen = false
    const running = client.proofread({ id: 'stop-me', path: 'a.tex', text: 'Teh '.repeat(40) }, () => {
      if (!seen) {
        seen = true
        client.cancel('stop-me')
      }
    })
    expect(await running).toBeNull()
  })

  it('explains what went wrong', async () => {
    // Nobody there.
    settings.url = `http://127.0.0.1:${await closedPort()}/v1`
    expect((await failure(client.models())).message).toMatch(/^No model server answers at 127\.0\.0\.1:\d+\. Is it running\?$/)
    // A server, but not at that path: LM Studio answers that with status 200 and an error.
    settings.url = `http://127.0.0.1:${server.port}/api`
    expect((await failure(client.models())).message).toBe(
      'The model server says: Unexpected endpoint or method. (GET /api/models). Check the address: for most servers it ends in /v1.'
    )
    settings.url = server.url
    server.state.fail = { status: 500, body: { error: { message: 'out of memory' } } }
    expect((await failure(client.check())).message).toBe('The model server ran into a problem (500): out of memory')
    server.state.fail = { status: 404, body: '<html><body><h1>Not Found</h1></body></html>' }
    expect((await failure(client.check())).message).toMatch(/has nothing at \/v1\/chat\/completions \(404\)/)
    server.state.fail = { status: 200, body: '<html>a web page</html>' }
    expect((await failure(client.check())).message).toMatch(/not one of an OpenAI-compatible server/)
    // Too slow.
    server.state.delayMs = 3500
    expect((await failure(client.complete({ id: 'x', path: 'a.tex', before: 'a', after: '', trigger: 'auto' }))).kind).toBe('timeout')
  })
})

// ------------------------------------------------- with real model servers
//
// UNDERLEAF_TEST_LLM="<name>|<address>|<model>;..." runs these against real
// servers, for instance Ollama and llama.cpp with a small model (as the CI
// workflow does). The answers of a model cannot be predicted, so what is
// checked is that they arrive, in the expected form.

const servers = (process.env['UNDERLEAF_TEST_LLM'] ?? '')
  .split(';')
  .filter((s) => s.trim())
  .map((s) => {
    const [name, url, model] = s.split('|').map((p) => p.trim())
    return { name, url, model }
  })

describe.skipIf(servers.length === 0).each(servers)('a real server: $name', ({ url, model }) => {
  const settings: AssistantSettings = { enabled: true, url, model, inline: 'auto' }
  const client = new AssistantClient({ settings: () => settings, apiKey: async () => null })
  const show = (label: string, value: unknown): void => console.log(`[${model}] ${label}: ${JSON.stringify(value)}`)

  it('lists the model and answers', async () => {
    const models = await client.models()
    show('models', models)
    expect(models.some((m) => m === model || m.startsWith(`${model}:`) || model.startsWith(m))).toBe(true)
    const check = await client.check()
    show('check', check)
    expect(check.ms).toBeGreaterThan(0)
  }, 300_000)

  it('suggests a continuation', async () => {
    for (const [before, after] of [
      ['\\section{Introduction}\nNeural networks have become a standard tool for', '\n'],
      ['We thank the anonymous ', ' for their comments.'],
      ['The integral of $x^2$ from $0$ to $1$ is', '\n\n\\end{document}']
    ]) {
      const result = await client.complete({ id: `r-${before.length}`, path: 'main.tex', before, after, trigger: 'auto' })
      show('suggestion', { before: before.slice(-40), result })
      expect(result).not.toBeNull()
      expect(result?.text).not.toMatch(/<\/?think>|```|<CURSOR>/)
      expect(result?.text.includes('\n\n')).toBe(false)
    }
  }, 300_000)

  it('proofreads a passage, streamed', async () => {
    const progress: string[] = []
    const original = 'This sentense has a eror in it, and \\emph{teh} rest is fine.\n'
    const result = await client.proofread({ id: 'p', path: 'main.tex', text: original }, (text) => progress.push(text))
    show('proofread', result)
    expect(result?.text.trim()).not.toBe('')
    expect(result?.text.endsWith('\n')).toBe(true)
    expect(progress.length).toBeGreaterThan(0)
  }, 300_000)

  it('stops when cancelled', async () => {
    const original = Array.from({ length: 30 }, (_, i) => `Sentense number ${i} has a eror.`).join(' ')
    let cancelled = false
    const result = await client.proofread({ id: 'c', path: 'main.tex', text: original }, () => {
      if (!cancelled) {
        cancelled = true
        client.cancel('c')
      }
    })
    expect(result).toBeNull()
  }, 300_000)
})
