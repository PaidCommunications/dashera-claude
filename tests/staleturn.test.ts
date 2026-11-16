import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import { STUCK_NOTE, STUCK_TURN_MS, TURN_IDLE_MS, turnIsLive, wakePrompt } from '../hooks/register'

// 0.3.8 (Wake test 3, 16 Nov 2026): after a clean app restart a task
// notification was dequeued as a turn at 16:33:30Z, but the model ran only
// when the person typed at 16:36:32Z. A turn.start with no turn.complete kept
// the session "busy" and held a wake-up for STUCK_TURN_MS (30 min). Now a
// turn with no sign of life (its start or a tool call) for TURN_IDLE_MS
// holds nothing, and a new turn after such a gap clears it.

const TOOL = 'mcp__dashera__wake_status'
const DESCRIPTION = 'Dashera wake. Each copy sends instance. The plugin reports turnStartedAt and deliveredMarker.'
type Args = Record<string, unknown>

async function live($: Engine, on: On, opts: { queue?: () => boolean } = {}) {
  const clock = mock.clock(on)
  const state = { answer: { pending: false, marker: null } as Record<string, unknown> }
  const calls: Args[] = []
  const prompts: string[] = []
  const statuses: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-stale' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('tool.list', () => ({ value: [{ name: TOOL, description: DESCRIPTION, mcp: true }] }))
  on('tool.call', (_, e) => {
    if (e.tool === TOOL) {
      calls.push({ ...(e as unknown as Args) })
      const text = JSON.stringify({ ...state.answer, session: { code: 'S-5A1E00', name: null }, pollSeconds: 15 })
      return { result: [{ type: 'text', text }], text }
    }
    return { result: [{ type: 'text', text: 'ok' }], text: 'ok' }
  })
  on('prompt.submit', async (_, e) => {
    prompts.push(e.text)
    // Queued behind a running turn: no answer for longer than the plugin waits.
    if (opts.queue?.()) await clock.sleep(40_000)
    return { text: e.text }
  })
  on('ui.status', (_, e) => {
    statuses.push(String(e.text))
    return { value: undefined }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000)
  return { clock, state, calls, prompts, statuses }
}

const done = (turnId: string) => ({ answer: 'done', durationMs: 1000, isAborted: false, turnId, reason: 'answer' as const })

test('turnIsLive: open, a sign of life under 5 min ago, started under 30 min ago', () => {
  expect(turnIsLive(false, 0, 0, 1000)).toBe(false)
  expect(turnIsLive(true, 0, 0, TURN_IDLE_MS - 1)).toBe(true)
  expect(turnIsLive(true, 0, 0, TURN_IDLE_MS)).toBe(false)
  expect(turnIsLive(true, 0, STUCK_TURN_MS - 1000, STUCK_TURN_MS - 500)).toBe(true)
  expect(turnIsLive(true, 0, STUCK_TURN_MS, STUCK_TURN_MS)).toBe(false)
})

test('a turn that started and never ran: the wake-up goes after 5 idle minutes, not 30', async ($, on) => {
  const r = await live($, on)
  await $.turn.start({ text: 'task notification', turnId: 'dequeued-1' })
  r.state.answer = { pending: true, marker: 'w1' }
  await r.clock.advance(TURN_IDLE_MS - 30_000)
  expect(r.prompts).toHaveLength(0)
  await r.clock.advance(60_000)
  expect(r.prompts).toEqual([wakePrompt()])
  expect(r.statuses.some(s => s.includes(STUCK_NOTE))).toBe(true)
  expect(r.statuses.some(s => s.includes('a turn looked stuck; wake-up'))).toBe(true)
})

test('a new turn after the idle gap clears the stale one', async ($, on) => {
  const r = await live($, on)
  await $.turn.start({ text: 'task notification', turnId: 'stale-1' })
  await r.clock.advance(TURN_IDLE_MS + 10_000)
  // The person types: a new turn, which then ends.
  await $.turn.start({ text: 'hello', turnId: 'typed-1' })
  await r.clock.advance(20_000)
  await $.turn.complete(done('typed-1'))
  // The session is idle now: a wake-up goes at once.
  r.state.answer = { pending: true, marker: 'w2' }
  await r.clock.advance(45_000)
  expect(r.prompts).toEqual([wakePrompt()])
})

test('a turn with recent tool calls still holds the wake-up', async ($, on) => {
  const r = await live($, on)
  await $.turn.start({ text: 'build', turnId: 'busy-1' })
  r.state.answer = { pending: true, marker: 'w3' }
  for (let i = 0; i < 6; i++) {
    await $.tool.call({ tool: 'Read', file_path: '/w/a.ts' })
    await r.clock.advance(2 * 60_000)
  }
  expect(r.prompts).toHaveLength(0)
  await $.turn.complete(done('busy-1'))
  await r.clock.advance(20_000)
  expect(r.prompts).toEqual([wakePrompt()])
})

test('turnStartedAt is not reported for a stale turn', async ($, on) => {
  const r = await live($, on)
  await $.turn.start({ text: 'task notification', turnId: 'stale-2' })
  await r.clock.advance(60_000)
  expect(typeof r.calls.at(-1)!.turnStartedAt).toBe('string')
  expect(r.calls.at(-1)!.turnStartedAt).not.toBe('none')
  await r.clock.advance(TURN_IDLE_MS)
  // Said once as over, then nothing.
  expect(r.calls.some(c => c.turnStartedAt === 'none')).toBe(true)
  const last = r.calls.slice(-3)
  expect(last.every(c => c.turnStartedAt === undefined)).toBe(true)
})

test('a wake-up queued behind a long command is marked delivered when its turn starts', async ($, on) => {
  let queue = true
  const r = await live($, on, { queue: () => queue })
  await $.turn.start({ text: 'long build', turnId: 'long-1' })
  await $.tool.call({ tool: 'Bash', command: 'make', description: 'build' })
  r.state.answer = { pending: true, marker: 'w4' }
  // One command runs past 5 minutes: the wake-up goes and the engine queues it.
  await r.clock.advance(TURN_IDLE_MS + 60_000)
  expect(r.prompts).toEqual([wakePrompt()])
  r.state.answer = { pending: false, marker: null }
  await r.clock.advance(60_000)
  expect(r.calls.every(c => c.deliveredMarker === undefined)).toBe(true)
  // The command and its turn end; the queued prompt's turn starts.
  queue = false
  await $.turn.complete(done('long-1'))
  await $.turn.start({ text: wakePrompt(), turnId: 'wake-1' })
  await r.clock.advance(15_000)
  expect(r.calls.filter(c => c.deliveredMarker === 'w4')).toHaveLength(1)
})

test('past a stale turn, a submit that answers at once still waits for its own turn to count', async ($, on) => {
  const r = await live($, on)
  await $.turn.start({ text: 'long build', turnId: 'long-2' })
  r.state.answer = { pending: true, marker: 'w5' }
  await r.clock.advance(TURN_IDLE_MS + 60_000)
  expect(r.prompts).toEqual([wakePrompt()])
  r.state.answer = { pending: false, marker: null }
  await r.clock.advance(30_000)
  expect(r.calls.every(c => c.deliveredMarker === undefined)).toBe(true)
  await $.turn.start({ text: wakePrompt(), turnId: 'wake-2' })
  await r.clock.advance(15_000)
  expect(r.calls.filter(c => c.deliveredMarker === 'w5')).toHaveLength(1)
})
