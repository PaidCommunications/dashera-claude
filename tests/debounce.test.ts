import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import { MIN_GAP_MS, WAKE_DEBOUNCE_MS, wakePrompt } from '../hooks/register'

// 0.3.2 (11 Nov 2026): one wake-up per burst. The first new addressed item
// starts a 20-second wait; everything in it gets one wake-up. Since 0.3.4 the
// prompt is a fixed template naming organizations by id only (names never).
// Quiet posts never wake.

const TOOL = 'mcp__dashera__wake_status'
type Answer = { pending: boolean; marker: string | null; organizations?: string[]; organizationIds?: string[] }

const ORG_A = '0b6f4a1e-6d2c-4c1b-9f43-2a7d8e5b1c01'
const ORG_B = '7c9e2d44-1a3b-4e5f-8a6b-9c0d1e2f3a4b'
const EXAMPLE = { organizations: ['Example Org'], organizationIds: [ORG_A] }
const WAKE_A = wakePrompt([ORG_A])

async function live($: Engine, on: On) {
  const clock = mock.clock(on)
  const state = { answer: { pending: false, marker: null } as Answer }
  const prompts: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-burst' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('tool.list', () => ({ value: [{ name: TOOL, description: 'Dashera wake', mcp: true }] }))
  on('tool.call', { tool: TOOL }, () => {
    const text = JSON.stringify({ ...state.answer, session: { code: 'S-B0057A', name: null }, pollSeconds: 15 })
    return { result: [{ type: 'text', text }], text }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.status', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // Past the first check, with nothing waiting.
  await clock.advance(6_000)
  return { clock, state, prompts }
}

test('waits about 20 seconds after the first item', () => {
  expect(WAKE_DEBOUNCE_MS).toBe(20_000)
})

test('a burst of 4 items within 20 s gives one wake-up', async ($, on) => {
  const { clock, state, prompts } = await live($, on)
  // Four posts, each a new marker, 5 s apart (checks run every 15 s, so
  // several land between two checks and several on their own).
  for (const [i, m] of ['p1', 'p2', 'p3', 'p4'].entries()) {
    state.answer = { pending: true, marker: m, ...EXAMPLE }
    await clock.advance(5_000)
    if (i < 3) expect(prompts).toHaveLength(0)
  }
  // The wait ends and the burst has its one wake-up.
  await clock.advance(30_000)
  expect(prompts).toEqual([WAKE_A])
  // Still pending (the turn hasn't run yet): no more wake-ups for it.
  await clock.advance(5 * 60_000)
  expect(prompts).toHaveLength(1)
})

test('items 30 s apart give two wake-ups', async ($, on) => {
  const { clock, state, prompts } = await live($, on)
  state.answer = { pending: true, marker: 'x1', ...EXAMPLE }
  await clock.advance(30_000)
  expect(prompts).toHaveLength(1)
  state.answer = { pending: true, marker: 'x2', ...EXAMPLE }
  await clock.advance(30_000)
  // A second item gets a wake-up of its own, still never closer than the
  // minimum gap to the last one.
  await clock.advance(MIN_GAP_MS)
  expect(prompts).toEqual([WAKE_A, WAKE_A])
})

test('one wake-up names every organization the burst touched, by id', async ($, on) => {
  const { clock, state, prompts } = await live($, on)
  state.answer = { pending: true, marker: 'o1', ...EXAMPLE }
  await clock.advance(15_000)
  state.answer = { pending: true, marker: 'o2', organizations: ['Other Org'], organizationIds: [ORG_B] }
  await clock.advance(30_000)
  expect(prompts).toEqual([
    `New activity in Dashera (organization ids ${ORG_A}, ${ORG_B}). Run check_in with brief: true in each, passing its id as organization.`,
  ])
  expect(prompts[0]).not.toContain('Example Org')
  expect(prompts[0]).not.toContain('Other Org')
})

test('quiet items never wake: Dashera leaves them out, so the answer is not pending', async ($, on) => {
  const { clock, state, prompts } = await live($, on)
  // A quiet post is listed at check_in but the answer stays pending: false,
  // with no marker.
  state.answer = { pending: false, marker: null, organizations: [] }
  await clock.advance(5 * 60_000)
  expect(prompts).toHaveLength(0)
})

test('work handled before the wait ends wakes nothing', async ($, on) => {
  const { clock, state, prompts } = await live($, on)
  state.answer = { pending: true, marker: 'h1', ...EXAMPLE }
  await clock.advance(10_000)
  // The agent was already in a turn and advanced its cursor.
  state.answer = { pending: false, marker: null }
  await clock.advance(60_000)
  expect(prompts).toHaveLength(0)
})

test("the first wake's prompt has no session code; check_in and advance_cursor still carry it", async ($, on) => {
  const seen: { tool: string; session: unknown }[] = []
  for (const tool of ['mcp__dashera__check_in', 'mcp__dashera__advance_cursor'] as const) {
    on('tool.call', { tool }, (_, e) => {
      seen.push({ tool, session: (e as unknown as Record<string, unknown>).session })
      return { result: [{ type: 'text', text: '{}' }], text: '{}' }
    })
  }
  const { clock, state, prompts } = await live($, on)
  state.answer = { pending: true, marker: 'c1', ...EXAMPLE }
  await clock.advance(40_000)
  // The very first wake-up is the short line, with no code in it.
  expect(prompts).toEqual([WAKE_A])
  expect(prompts[0]).not.toContain('S-B0057A')
  // The agent calls them as the line leaves it, without a code.
  await $.tool.call({ tool: 'mcp__dashera__check_in', organization: 'Example Org' } as never)
  await $.tool.call({ tool: 'mcp__dashera__advance_cursor', organization: 'Example Org', position: 'x' } as never)
  expect(seen).toEqual([
    { tool: 'mcp__dashera__check_in', session: 'S-B0057A' },
    { tool: 'mcp__dashera__advance_cursor', session: 'S-B0057A' },
  ])
})
