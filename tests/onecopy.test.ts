import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import {
  claimStep,
  CLAIM_STALE_MS,
  LIVE_COPIES_KEY,
  newerCopy,
  STAND_DOWN_RECHECK_MS,
  SUBMIT_SHOWN_MS,
  wakePrompt,
  withClaim,
  type Claim,
} from '../hooks/register'

// 0.3.8 (16 Nov 2026): one live copy per conversation. A conversation had
// two copies of the plugin checking in from one process, and the copy
// Dashera kept never started a turn. The newest copy now claims the
// conversation before its first check and the older one stops for good;
// each wake-up's submit result shows on the status line for 60 s and goes
// to a Dashera that takes it.

const TOOL = 'mcp__dashera__wake_status'
const SESSION = 'sess-one'
type Args = Record<string, unknown>

/** The plugin's store, shared by every copy, readable and writable. */
function storeOf(on: On, initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial }
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  return store
}

async function live(
  $: Engine,
  on: On,
  opts: { description?: string; store?: Record<string, unknown> | null; drop?: boolean } = {},
) {
  const clock = mock.clock(on)
  const store = opts.store === null ? null : storeOf(on, opts.store ?? {})
  const state = { answer: { pending: false, marker: null } as Record<string, unknown> }
  const calls: Args[] = []
  const claimAtCall: (string | undefined)[] = []
  const prompts: string[] = []
  const statuses: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SESSION }))
  on('session.cwd', () => ({ value: '/w' }))
  on('tool.list', () => ({ value: [{ name: TOOL, description: opts.description ?? 'Dashera wake. Each copy sends instance.', mcp: true }] }))
  on('tool.call', { tool: TOOL }, (_, e) => {
    calls.push({ ...(e as unknown as Args) })
    const claims = (store?.[LIVE_COPIES_KEY] ?? {}) as Record<string, Claim>
    claimAtCall.push(claims[SESSION]?.instance)
    const text = JSON.stringify({ ...state.answer, session: { code: 'S-0C0FFE', name: null }, pollSeconds: 15 })
    return { result: [{ type: 'text', text }], text }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return opts.drop ? { drop: 'busy' } : { text: e.text }
  })
  on('ui.status', (_, e) => {
    statuses.push(String(e.text))
    return { value: undefined }
  })
  return { clock, store, state, calls, claimAtCall, prompts, statuses }
}

const start = ($: Engine) => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
const claimOf = (store: Record<string, unknown> | null, id = SESSION) =>
  ((store?.[LIVE_COPIES_KEY] ?? {}) as Record<string, Claim>)[id]

test('newerCopy and claimStep: the newest copy wins; a claim nobody renews is taken', () => {
  const old = { instance: 'a', at: 1000, seq: 1 }
  const fresh = { instance: 'b', at: 2000, seq: 1 }
  expect(newerCopy(fresh, old)).toBe(true)
  expect(newerCopy(old, fresh)).toBe(false)
  // Same millisecond: the order in the environment decides.
  expect(newerCopy({ instance: 'a', at: 5, seq: 2 }, { instance: 'b', at: 5, seq: 1 })).toBe(true)
  const now = 10_000
  expect(claimStep(undefined, old, now)).toBe('take')
  expect(claimStep({ ...old, seenAt: now }, old, now)).toBe('mine')
  // An older copy's claim is taken; a newer one's is left to it.
  expect(claimStep({ ...old, seenAt: now }, fresh, now)).toBe('take')
  expect(claimStep({ ...fresh, seenAt: now }, old, now)).toBe('yield')
  // A newer copy that stopped renewing its claim went away.
  expect(claimStep({ ...fresh, seenAt: now - CLAIM_STALE_MS - 1 }, old, now)).toBe('take')
  // Claims a day old are dropped when another is written.
  const kept = withClaim({ gone: { ...old, seenAt: 0 }, near: { ...old, seenAt: now } }, 'x', { ...fresh, seenAt: 25 * 3600_000 })
  expect(Object.keys(kept).sort()).toEqual(['x'])
})

test('the newest copy takes the conversation from an older one before its first check', async ($, on) => {
  const older: Claim = { instance: 'older-copy', at: Date.now() - 60_000, seq: 1, seenAt: Date.now() }
  const r = await live($, on, { store: { [LIVE_COPIES_KEY]: { [SESSION]: older } } })
  await start($)
  await r.clock.advance(6_000)
  expect(r.calls).toHaveLength(1)
  // The claim was this copy's before the check went out.
  expect(r.claimAtCall[0]).toBeDefined()
  expect(r.claimAtCall[0]).not.toBe('older-copy')
  expect(r.claimAtCall[0]).toBe(r.calls[0]!.instance as string)
  await r.clock.advance(60_000)
  expect(r.calls.length).toBeGreaterThanOrEqual(5)
})

test('two copies for one conversation: once a newer copy claims it, the older sends nothing more', async ($, on) => {
  const r = await live($, on)
  await start($)
  await r.clock.advance(6_000 + 15_000)
  expect(r.calls).toHaveLength(2)
  const mine = claimOf(r.store)!
  expect(mine).toBeDefined()
  const statusesBefore = r.statuses.length
  // A reload loads a fresh copy: it claims the conversation and keeps
  // renewing the claim.
  r.store![LIVE_COPIES_KEY] = {
    [SESSION]: { instance: 'reloaded-copy', at: mine.at + 1, seq: 1, seenAt: Date.now() + 10 * 3600_000 },
  }
  // Work waits; the older copy must not wake for it or check again.
  r.state.answer = { pending: true, marker: 'm1' }
  await r.clock.advance(3 * STAND_DOWN_RECHECK_MS)
  expect(r.calls).toHaveLength(2)
  expect(r.prompts).toHaveLength(0)
  // It leaves the status line to the copy that took over.
  expect(r.statuses.length).toBe(statusesBefore)
  // And never takes the claim back.
  expect(claimOf(r.store)!.instance).toBe('reloaded-copy')
})

test('a newer copy holding the conversation at start: this copy never checks', async ($, on) => {
  const newer: Claim = { instance: 'newer-copy', at: Date.now() + 60_000, seq: 1, seenAt: Date.now() + 10 * 3600_000 }
  const r = await live($, on, { store: { [LIVE_COPIES_KEY]: { [SESSION]: newer } } })
  await start($)
  await r.clock.advance(2 * STAND_DOWN_RECHECK_MS)
  expect(r.calls).toHaveLength(0)
  expect(claimOf(r.store)!.instance).toBe('newer-copy')
})

test('a stopped copy comes back only when the copy that took over stops renewing its claim', async ($, on) => {
  const r = await live($, on)
  await start($)
  await r.clock.advance(6_000)
  const mine = claimOf(r.store)!
  r.store![LIVE_COPIES_KEY] = {
    [SESSION]: { instance: 'reloaded-copy', at: mine.at + 1, seq: 1, seenAt: Date.now() + 10 * 3600_000 },
  }
  await r.clock.advance(STAND_DOWN_RECHECK_MS - 30_000)
  const stoppedAt = r.calls.length
  // The owner went away: its claim is long past renewing.
  r.store![LIVE_COPIES_KEY] = {
    [SESSION]: { instance: 'reloaded-copy', at: mine.at + 1, seq: 1, seenAt: Date.now() - CLAIM_STALE_MS - 60_000 },
  }
  await r.clock.advance(STAND_DOWN_RECHECK_MS + 60_000)
  expect(r.calls.length).toBeGreaterThan(stoppedAt)
  expect(claimOf(r.store)!.instance).toBe(mine.instance)
})

test('a second session.start in one registration leaves one interval, not two', async ($, on) => {
  const r = await live($, on)
  await start($)
  await r.clock.advance(6_000)
  await start($)
  await r.clock.advance(10_000)
  const from = r.calls.length
  await r.clock.advance(60_000)
  // One check per 15 s: four in a minute, not eight.
  expect(r.calls.length - from).toBe(4)
})

test('different conversations in one process each keep their own claim, and both check', async ($, on) => {
  const otherConv: Claim = { instance: 'other-conv-copy', at: Date.now() + 60_000, seq: 1, seenAt: Date.now() + 10 * 3600_000 }
  const r = await live($, on, { store: { [LIVE_COPIES_KEY]: { 'sess-other': otherConv } } })
  await start($)
  await r.clock.advance(6_000 + 60_000)
  expect(r.calls.length).toBeGreaterThanOrEqual(5)
  expect(claimOf(r.store, 'sess-other')!.instance).toBe('other-conv-copy')
  expect(claimOf(r.store)).toBeDefined()
})

test('without a readable store, the copy checks as before', async ($, on) => {
  const r = await live($, on, { store: null })
  await start($)
  await r.clock.advance(6_000 + 30_000)
  expect(r.calls).toHaveLength(3)
})

const SUBMIT_DESCRIPTION = 'Dashera wake. Each copy sends instance. From 0.3.8 the plugin reports submit (entered, dropped, queued).'

test("a wake-up's submit result shows on the status line for 60 s and goes once to a Dashera that takes it", async ($, on) => {
  const r = await live($, on, { description: SUBMIT_DESCRIPTION })
  await start($)
  await r.clock.advance(6_000)
  r.state.answer = { pending: true, marker: 'm1' }
  await r.clock.advance(40_000)
  expect(r.prompts).toEqual([wakePrompt()])
  const shownAt = r.statuses.findIndex(s => s.includes('wake-up entered'))
  expect(shownAt).toBeGreaterThanOrEqual(0)
  r.state.answer = { pending: false, marker: null }
  const sent = r.calls.filter(c => c.submit !== undefined)
  await r.clock.advance(15_000)
  const after = r.calls.filter(c => c.submit !== undefined)
  expect(after.length).toBe(1)
  expect(after[0]!.submit).toBe('entered')
  expect(sent.length).toBeLessThanOrEqual(1)
  // Still on the line inside the 60 s, gone after it.
  expect(r.statuses.at(-1)).toContain('wake-up entered')
  await r.clock.advance(SUBMIT_SHOWN_MS)
  expect(r.statuses.at(-1)).not.toContain('wake-up')
  expect(r.statuses.at(-1)).toContain('Live on Dashera')
  // Once only.
  await r.clock.advance(60_000)
  expect(r.calls.filter(c => c.submit !== undefined)).toHaveLength(1)
})

test('a dropped wake-up shows as dropped', async ($, on) => {
  const r = await live($, on, { description: SUBMIT_DESCRIPTION, drop: true })
  await start($)
  await r.clock.advance(6_000)
  r.state.answer = { pending: true, marker: 'm1' }
  await r.clock.advance(40_000)
  expect(r.prompts.length).toBeGreaterThanOrEqual(1)
  expect(r.statuses.some(s => s.includes('wake-up dropped'))).toBe(true)
  await r.clock.advance(15_000)
  expect(r.calls.some(c => c.submit === 'dropped')).toBe(true)
})

test('a Dashera whose description does not mention submit is never sent it', async ($, on) => {
  const r = await live($, on)
  await start($)
  await r.clock.advance(6_000)
  r.state.answer = { pending: true, marker: 'm1' }
  await r.clock.advance(40_000)
  expect(r.prompts).toEqual([wakePrompt()])
  r.state.answer = { pending: false, marker: null }
  await r.clock.advance(60_000)
  expect(r.calls.every(c => c.submit === undefined)).toBe(true)
  // The status line shows it all the same.
  expect(r.statuses.some(s => s.includes('wake-up entered'))).toBe(true)
})
