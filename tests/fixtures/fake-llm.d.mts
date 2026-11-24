import type { IncomingHttpHeaders } from 'node:http'

export declare const CORRECTIONS: Array<[string, string]>
export declare const CONTINUATIONS: Array<[string, string]>

export interface FakeRequest {
  method: string
  path: string
  headers: IncomingHttpHeaders
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any
}

export interface FakeState {
  models: string[]
  key: string | null
  delayMs: number
  chunkDelayMs: number
  think: 'inline' | 'separate' | null
  owner: string
  strict: boolean
  fail: { status: number; body: unknown } | null
  noStreaming: boolean
  cutAt: number | null
  dropAt: number | null
  streamError: 'field' | 'event' | null
  lineEnd: string
  holdOpen: boolean
  aborted: number
  closedAfterEnd: number
}

export interface FakeLlm {
  url: string
  port: number
  requests: FakeRequest[]
  state: FakeState
  chats(): FakeRequest[]
  close(): Promise<void>
}

export declare function startFakeLlm(options?: { models?: string[]; key?: string | null; owner?: string }): Promise<FakeLlm>
