import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import { STUCK_TURN_MS, turnStartedAtToSend, wakePrompt } from '../hooks/register'

// 0.3.6 (Who gets it receipts, 12 Nov 2026): the checks already running
// carry the turn report: turnStartedAt while a main-loop turn runs, "none"
// once after it ends, and deliveredMarker once after a wake-up's prompt
// entered. Never a request of its own; never from a copy that stands down.

const TOOL = 'mcp__dashera__wake_status'
const DESCRIPTION =
  'Dashera wake. Each copy sends instance. From 0.3.6 the plugin also reports turnStartedAt and deliveredMarker.'
type Args = Record<string, unknown>

async function live($: Engine, on: On, opts: { description?: string } = {}) {
  const clock = mock.clock(on)
  const state = { answer: { pending: false, marker: null } as Record<string, unknown> }
  const calls: Args[] = []
  const times: number[] = []
  const prompts: string[] = []
  const promptAt: number[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-turns' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('tool.list', () => ({ value: [{ name: TOOL, description: opts.description ?? DESCRIPTION, mcp: true }] }))
  on('tool.call', { tool: TOOL }, (_, e) => {
    calls.push({ ...(e as unknown as Args) })
    times.push(clock.now())
    const text = JSON.stringify({ ...state.answer, session: { code: 'S-C0721A', name: null }, pollSeconds: 15 })
    return { result: [{ type: 'text', text }], text }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    promptAt.push(calls.length)
    return { text: e.text }
  })
  on('ui.status', () => ({ value: undefined }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000)
  return { clock, state, calls, times, prompts, promptAt }
}

const done = (turnId: string) => ({ answer: 'done', durationMs: 1000, isAborted: false, turnId, reason: 'answer' as const })

test('turnStartedAtToSend: the start while busy, "none" once after, nothing when idle', () => {
  expect(turnStartedAtToSend(true, 0, 1000, null)).toBe(new Date(0).toISOString())
  expect(turnStartedAtToSend(true, 0, 1000, new Date(0).toISOString())).toBe(new Date(0).toISOString())
  expect(turnStartedAtToSend(false, 0, 1000, new Date(0).toISOString())).toBe('none')
  expect(turnStartedAtToSend(false, 0, 1000, 'none')).toBeNull()
  expect(turnStartedAtToSend(false, 0, 1000, null)).toBeNull()
  // A turn that never reported its end counts as over.
  expect(turnStartedAtToSend(true, 0, STUCK_TURN_MS + 1, new Date(0).toISOString())).toBe('none')
})

test("a turn's start goes with the next check, on every check while it runs, and none once after", async ($, on) => {
  const { clock, calls } = await live($, on)
  expect(calls.at(-1)!.turnStartedAt).toBeUndefined()
  const startedAt = clock.now()
  await $.turn.start({ text: 'my own question', turnId: 't1' })
  await clock.advance(15_000)
  const iso = new Date(startedAt).toISOString()
  expect(calls.at(-1)!.turnStartedAt).toBe(iso)
  // Still running: every check says so (Dashera forgets a turn after 90 s).
  await clock.advance(15_000)
  expect(calls.at(-1)!.turnStartedAt).toBe(iso)
  await $.turn.complete(done('t1'))
  await clock.advance(2_000)
  expect(calls.at(-1)!.turnStartedAt).toBe('none')
  // Said once: later idle checks carry nothing.
  await clock.advance(30_000)
  expect(calls.at(-1)!.turnStartedAt).toBeUndefined()
})

test("a subagent's run is not a turn of its own", async ($, on) => {
  const { clock, calls } = await live($, on)
  await $.turn.start({ text: 'sub', turnId: 's1', agentId: 'agent-1' })
  await clock.advance(30_000)
  expect(calls.every(c => c.turnStartedAt === undefined)).toBe(true)
})

test("a wake-up whose prompt entered is reported once as deliveredMarker", async ($, on) => {
  const { clock, state, calls, prompts, promptAt } = await live($, on)
  state.answer = { pending: true, marker: '0123456789abcdef' }
  await clock.advance(45_000)
  expect(prompts).toEqual([wakePrompt()])
  state.answer = { pending: false, marker: null }
  await clock.advance(60_000)
  // Nothing before the prompt entered; the very next check; once.
  expect(calls.slice(0, promptAt[0]).every(c => c.deliveredMarker === undefined)).toBe(true)
  expect(calls[promptAt[0]!]!.deliveredMarker).toBe('0123456789abcdef')
  expect(calls.filter(c => c.deliveredMarker !== undefined)).toHaveLength(1)
})

// The same three turns against a Dashera that takes the report and one that
// doesn't: the same number of checks, each at its own moment.
const checksFor: Record<string, number> = {}
async function threeTurns($: Engine, on: On, description: string) {
  const r = await live($, on, { description })
  const before = r.calls.length
  for (const id of ['a', 'b', 'c']) {
    await $.turn.start({ text: id, turnId: id })
    await r.clock.advance(40_000)
    await $.turn.complete(done(id))
    await r.clock.advance(20_000)
  }
  return { ...r, count: r.calls.length - before }
}

test('no extra request per turn (without the report)', async ($, on) => {
  const r = await threeTurns($, on, 'Dashera wake. Each copy sends instance.')
  checksFor.without = r.count
  expect(r.calls.every(c => c.turnStartedAt === undefined)).toBe(true)
})

test('no extra request per turn: the report rides on the regular checks', async ($, on) => {
  const r = await threeTurns($, on, DESCRIPTION)
  expect(r.calls.filter(c => typeof c.turnStartedAt === 'string' && c.turnStartedAt !== 'none').length).toBeGreaterThan(0)
  expect(r.calls.filter(c => c.turnStartedAt === 'none')).toHaveLength(3)
  expect(checksFor.without).toBeGreaterThan(0)
  expect(r.count).toBe(checksFor.without)
  // Never two checks at one moment.
  expect(new Set(r.times).size).toBe(r.times.length)
})

test('a Dashera whose tool predates the report gets neither field', async ($, on) => {
  const { clock, state, calls } = await live($, on, { description: 'Dashera wake. Each copy sends instance.' })
  await $.turn.start({ text: 'q', turnId: 'old-1' })
  state.answer = { pending: true, marker: 'aaaaaaaaaaaaaaaa' }
  await clock.advance(30_000)
  await $.turn.complete(done('old-1'))
  await clock.advance(60_000)
  expect(calls.every(c => c.turnStartedAt === undefined && c.deliveredMarker === undefined)).toBe(true)
})

test('a copy that stands down sends no turn report', async ($, on) => {
  const { clock, state, calls } = await live($, on)
  state.answer = { pending: false, marker: null, standDown: true }
  await clock.advance(15_000)
  const at = calls.length
  await $.turn.start({ text: 'q', turnId: 'sd-1' })
  // The occasional check, 10 minutes on, carries nothing either.
  await clock.advance(11 * 60_000)
  expect(calls.length).toBeGreaterThan(at)
  expect(calls.slice(at).every(c => c.turnStartedAt === undefined && c.deliveredMarker === undefined)).toBe(true)
})
