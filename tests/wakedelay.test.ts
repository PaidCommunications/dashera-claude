import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import { MIN_GAP_MS, STUCK_TURN_MS, WAKE_MAX_WAIT_MS, wakePrompt } from '../hooks/register'

// 0.3.3 (12 Nov 2026): a mention that addressed a live session woke it 23
// minutes late once and never another time (found 3h44m later). 0.3.2 marked
// a wake delivered the moment it asked for the prompt: a submit the engine
// dropped (or one lost while the session was mid-turn) used up that item, and
// nothing raised it again. A new item after a wake also waited out a 2-minute
// gap. Now a wake is delivered only when its prompt enters, waits for the
// session to be idle, and comes at most WAKE_MAX_WAIT_MS after the first new
// item of a burst.

const TOOL = 'mcp__dashera__wake_status'
type Answer = { pending: boolean; marker: string | null; organizations?: string[]; organizationIds?: string[] }

async function live($: Engine, on: On, opts: { drop?: () => boolean } = {}) {
  const clock = mock.clock(on)
  const state = { answer: { pending: false, marker: null } as Answer }
  const prompts: string[] = []
  const dropped: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-delay' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('tool.list', () => ({ value: [{ name: TOOL, description: 'Dashera wake', mcp: true }] }))
  on('tool.call', { tool: TOOL }, () => {
    const text = JSON.stringify({ ...state.answer, session: { code: 'S-C0721A', name: null }, pollSeconds: 15 })
    return { result: [{ type: 'text', text }], text }
  })
  on('prompt.submit', (_, e) => {
    if (opts.drop?.()) {
      dropped.push(e.text)
      return { drop: 'the engine refused it' }
    }
    prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.status', () => ({ value: undefined }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000)
  return { clock, state, prompts, dropped }
}

const ORG = '0b6f4a1e-6d2c-4c1b-9f43-2a7d8e5b1c01'
const WAKE = wakePrompt([ORG])

test('a burst never waits more than 30 s from its first item', () => {
  expect(WAKE_MAX_WAIT_MS).toBe(30_000)
  expect(MIN_GAP_MS).toBeLessThanOrEqual(WAKE_MAX_WAIT_MS)
})

test('a dropped wake-up is not used up: it is asked again and enters', async ($, on) => {
  let drops = 1
  const { clock, state, prompts, dropped } = await live($, on, { drop: () => drops-- > 0 })
  state.answer = { pending: true, marker: 'm1', organizations: ['Example Org'], organizationIds: [ORG] }
  await clock.advance(45_000)
  expect(dropped).toEqual([WAKE])
  expect(prompts).toHaveLength(0)
  // Still pending: the next checks ask again, and this time it enters.
  await clock.advance(90_000)
  expect(prompts).toEqual([WAKE])
  // Once in, the same item never wakes again.
  await clock.advance(5 * 60_000)
  expect(prompts).toHaveLength(1)
})

test('a mention while the session is mid-turn wakes it at its next idle check', async ($, on) => {
  const { clock, state, prompts } = await live($, on)
  await $.turn.start({ text: 'build the thing', turnId: 'long-1' })
  state.answer = { pending: true, marker: 'mt1', organizations: ['Example Org'], organizationIds: [ORG] }
  // A long turn: nothing is pushed into it.
  await clock.advance(10 * 60_000)
  expect(prompts).toHaveLength(0)
  await $.turn.complete({ answer: 'done', durationMs: 600_000, isAborted: false, turnId: 'long-1', reason: 'answer' })
  // The next check finds it still pending and the session idle.
  await clock.advance(20_000)
  expect(prompts).toEqual([WAKE])
})

test('a mention the running turn handled itself wakes nothing after it', async ($, on) => {
  const { clock, state, prompts } = await live($, on)
  await $.turn.start({ text: 'working', turnId: 'long-2' })
  state.answer = { pending: true, marker: 'mt2', organizations: ['Example Org'], organizationIds: [ORG] }
  await clock.advance(2 * 60_000)
  // The turn ran check_in and advance_cursor itself.
  state.answer = { pending: false, marker: null }
  await clock.advance(30_000)
  await $.turn.complete({ answer: 'done', durationMs: 150_000, isAborted: false, turnId: 'long-2', reason: 'answer' })
  await clock.advance(60_000)
  expect(prompts).toHaveLength(0)
})

test('a subagent turn does not hold the wake-up', async ($, on) => {
  const { clock, state, prompts } = await live($, on)
  await $.turn.start({ text: 'sub', turnId: 'sub-1', agentId: 'agent-1' })
  state.answer = { pending: true, marker: 'sa1', organizations: ['Example Org'], organizationIds: [ORG] }
  await clock.advance(50_000)
  expect(prompts).toEqual([WAKE])
})

test('a turn that never reports its end holds the wake-up at most STUCK_TURN_MS', async ($, on) => {
  const { clock, state, prompts } = await live($, on)
  await $.turn.start({ text: 'stuck', turnId: 'stuck-1' })
  state.answer = { pending: true, marker: 'st1', organizations: ['Example Org'], organizationIds: [ORG] }
  await clock.advance(STUCK_TURN_MS - 60_000)
  expect(prompts).toHaveLength(0)
  await clock.advance(2 * 60_000)
  expect(prompts).toEqual([WAKE])
})

test('a burst of 10 items over 2 minutes plus a mention still wakes within 60 s', async ($, on) => {
  const { clock, state, prompts } = await live($, on)
  // An earlier wake-up, just handled.
  state.answer = { pending: true, marker: 'e0', organizations: ['Example Org'], organizationIds: [ORG] }
  await clock.advance(40_000)
  expect(prompts).toHaveLength(1)
  // Ten more items, 12 s apart, the mention among the first: each check
  // sees a new marker, and the debounce never restarts.
  for (let i = 1; i <= 10; i++) {
    state.answer = { pending: true, marker: `b${i}`, organizations: ['Example Org'], organizationIds: [ORG] }
    await clock.advance(12_000)
    if (i === 5) {
      // 60 s after the first of them.
      expect(prompts.length).toBeGreaterThanOrEqual(2)
    }
  }
  await clock.advance(60_000)
  // One per burst window, never a storm.
  expect(prompts.length).toBeLessThanOrEqual(6)
})
