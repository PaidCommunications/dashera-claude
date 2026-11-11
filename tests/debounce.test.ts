import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import { MIN_GAP_MS, WAKE_DEBOUNCE_MS } from '../hooks/register'

// 0.3.2 (11 Nov 2026): one wake-up per burst. The first new addressed item
// starts a 20-second wait; everything in it gets one wake-up, whose prompt is
// exactly "New activity in Dashera: <org>". Quiet posts never wake.

const TOOL = 'mcp__dashera__wake_status'
type Answer = { pending: boolean; marker: string | null; organizations?: string[] }

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
    state.answer = { pending: true, marker: m, organizations: ['Example Org'] }
    await clock.advance(5_000)
    if (i < 3) expect(prompts).toHaveLength(0)
  }
  // The wait ends and the burst has its one wake-up.
  await clock.advance(30_000)
  expect(prompts).toEqual(['New activity in Dashera: Example Org'])
  // Still pending (the turn hasn't run yet): no more wake-ups for it.
  await clock.advance(5 * 60_000)
  expect(prompts).toHaveLength(1)
})

test('items 30 s apart give two wake-ups', async ($, on) => {
  const { clock, state, prompts } = await live($, on)
  state.answer = { pending: true, marker: 'x1', organizations: ['Example Org'] }
  await clock.advance(30_000)
  expect(prompts).toHaveLength(1)
  state.answer = { pending: true, marker: 'x2', organizations: ['Example Org'] }
  await clock.advance(30_000)
  // A second item gets a wake-up of its own, still never closer than the
  // minimum gap to the last one.
  await clock.advance(MIN_GAP_MS)
  expect(prompts).toEqual(['New activity in Dashera: Example Org', 'New activity in Dashera: Example Org'])
})

test('one wake-up names every organization the burst touched', async ($, on) => {
  const { clock, state, prompts } = await live($, on)
  state.answer = { pending: true, marker: 'o1', organizations: ['Example Org'] }
  await clock.advance(15_000)
  state.answer = { pending: true, marker: 'o2', organizations: ['Other Org'] }
  await clock.advance(30_000)
  expect(prompts).toEqual(['New activity in Dashera: Example Org, Other Org'])
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
  state.answer = { pending: true, marker: 'h1', organizations: ['Example Org'] }
  await clock.advance(10_000)
  // The agent was already in a turn and advanced its cursor.
  state.answer = { pending: false, marker: null }
  await clock.advance(60_000)
  expect(prompts).toHaveLength(0)
})
