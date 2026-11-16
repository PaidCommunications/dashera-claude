import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import {
  BROKEN_STATUS,
  firstUp,
  LEASE_STALE_MS,
  leaseStep,
  OTHER_COPY_STATUS,
  SUBMIT_SHOWN_MS,
  wakePrompt,
} from '../hooks/register'
import type { LiveCopyLease } from '../types'

// 0.3.8 (16 Nov 2026): one live copy per conversation. A conversation had
// two copies of the plugin checking in from one process, and the copy
// Dashera kept never started a turn. Layer 1: a session-scoped lease in
// $.state; only its holder calls wake_status. Layer 2: every prompt's
// submit result goes to Dashera (deliveryResult), and two drops in a row
// give up the lease (deliveryBroken).

const TOOL = 'mcp__dashera__wake_status'
const PLAIN = 'Dashera wake. Each copy sends instance.'
const DELIVERY = `${PLAIN} From 0.3.8 the plugin reports deliveryResult and deliveryBroken.`
type Args = Record<string, unknown>

/**
 * The session's $.state for the lease, shared by every copy. `other` is a
 * second copy of the plugin in the same session: while `alive`, it renews
 * the lease each time it is read, as a holder does on every tick.
 */
function leaseOf(on: On) {
  const cell = { value: undefined as LiveCopyLease | undefined, version: 0 }
  const other = { alive: false, lease: undefined as LiveCopyLease | undefined }
  const now = { at: () => 0 }
  const isLease = (e: { plugin?: string; key?: string }) => e.plugin === 'dashera' && e.key === 'liveCopy'
  on('state.get', (_, e) => {
    if (!isLease(e as never)) return { value: { value: undefined, version: 0 } }
    if (other.alive && other.lease && (!cell.value || !cell.value.instance || cell.value.instance === other.lease.instance)) {
      cell.value = { ...other.lease, renewedAt: now.at() }
      cell.version += 1
    }
    return { value: { value: cell.value, version: cell.version } }
  })
  on('state.set', (_, e) => {
    const w = e as unknown as { value: LiveCopyLease; ifVersion?: number }
    if (w.ifVersion !== undefined && w.ifVersion !== cell.version) return { value: { isSet: false as const, version: cell.version } }
    cell.value = JSON.parse(JSON.stringify(w.value))
    cell.version += 1
    return { value: { isSet: true as const, version: cell.version } }
  })
  return { cell, other, now }
}

async function live($: Engine, on: On, opts: { description?: string; drop?: boolean } = {}) {
  const clock = mock.clock(on)
  const lease = leaseOf(on)
  lease.now.at = () => clock.now()
  const state = { answer: { pending: false, marker: null } as Record<string, unknown> }
  const calls: Args[] = []
  const callAt: number[] = []
  const prompts: string[] = []
  const statuses: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: 'sess-one' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('tool.list', () => ({ value: [{ name: TOOL, description: opts.description ?? PLAIN, mcp: true }] }))
  on('tool.call', { tool: TOOL }, (_, e) => {
    calls.push({ ...(e as unknown as Args) })
    callAt.push(clock.now())
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
  const startedAt = clock.now()
  return { clock, lease, state, calls, callAt, prompts, statuses, startedAt }
}

const start = ($: Engine) => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
const end = ($: Engine, reason: string) =>
  $.session.end({ reason, sessionId: 'sess-one', resume: undefined } as never)

test('leaseStep and firstUp: the holder keeps it, a stale one is taken, together the first up wins', () => {
  const me = { instance: 'm', startedAt: 1000 }
  const now = 100_000
  expect(leaseStep(undefined, me, now)).toBe('take')
  expect(leaseStep({ instance: '', startedAt: 0, renewedAt: 0 }, me, now)).toBe('take')
  expect(leaseStep({ ...me, renewedAt: now - 1000 }, me, now)).toBe('hold')
  // Another copy renewed it 5 s ago and came up long before: wait.
  expect(leaseStep({ instance: 'o', startedAt: 0, renewedAt: now - 5000 }, { instance: 'm', startedAt: 60_000 }, now)).toBe('wait')
  // Not stale at 30 s, stale past it.
  expect(leaseStep({ instance: 'o', startedAt: 0, renewedAt: now - LEASE_STALE_MS }, { instance: 'm', startedAt: 60_000 }, now)).toBe('wait')
  expect(leaseStep({ instance: 'o', startedAt: 0, renewedAt: now - LEASE_STALE_MS - 1 }, { instance: 'm', startedAt: 60_000 }, now)).toBe('take')
  // Came up together: earlier startedAt wins, then the lower instance id.
  expect(firstUp({ instance: 'z', startedAt: 1 }, { instance: 'a', startedAt: 2 })).toBe(true)
  expect(firstUp({ instance: 'a', startedAt: 5 }, { instance: 'b', startedAt: 5 })).toBe(true)
  expect(firstUp({ instance: 'b', startedAt: 5 }, { instance: 'a', startedAt: 5 })).toBe(false)
  expect(leaseStep({ instance: 'o', startedAt: 2000, renewedAt: now }, me, now)).toBe('take')
  expect(leaseStep({ instance: 'o', startedAt: 500, renewedAt: now }, me, now)).toBe('wait')
  // A copy whose prompts don't enter never takes a lease another copy holds.
  expect(leaseStep({ instance: 'o', startedAt: 2000, renewedAt: now }, me, now, true)).toBe('wait')
})

test('one copy alone holds the lease, renews it every tick, and checks every 15 s as before', async ($, on) => {
  const r = await live($, on)
  await start($)
  await r.clock.advance(6_000 + 60_000)
  expect(r.calls).toHaveLength(5)
  const held = r.lease.cell.value!
  expect(held.instance).toBe(r.calls[0]!.instance as string)
  expect(held.startedAt).toBe(r.startedAt)
  // Renewed on the last tick.
  expect(r.clock.now() - held.renewedAt).toBeLessThan(15_000)
  expect(r.statuses.some(s => s === OTHER_COPY_STATUS)).toBe(false)
})

test('two copies in one session: only the one holding the lease ever calls wake_status', async ($, on) => {
  const r = await live($, on)
  // The other copy came up a minute earlier and holds the lease.
  r.lease.other.alive = true
  r.lease.other.lease = { instance: 'other-copy', startedAt: r.startedAt - 60_000, renewedAt: r.startedAt }
  await start($)
  r.state.answer = { pending: true, marker: 'm1' }
  await r.clock.advance(10 * 60_000)
  expect(r.calls).toHaveLength(0)
  expect(r.prompts).toHaveLength(0)
  expect(r.statuses.at(-1)).toBe(OTHER_COPY_STATUS)
  expect(r.lease.cell.value!.instance).toBe('other-copy')
})

test('the lease holder is gone: the other copy takes over once the lease is over 30 s old', async ($, on) => {
  const r = await live($, on)
  r.lease.other.alive = true
  r.lease.other.lease = { instance: 'other-copy', startedAt: r.startedAt - 60_000, renewedAt: r.startedAt }
  await start($)
  await r.clock.advance(2 * 60_000)
  expect(r.calls).toHaveLength(0)
  // The holder is killed: it renews no more.
  r.lease.other.alive = false
  const lastRenewed = r.lease.cell.value!.renewedAt
  await r.clock.advance(60_000)
  expect(r.calls.length).toBeGreaterThan(0)
  const tookOver = r.callAt[0]! - lastRenewed
  // Over 30 s old, at the next 15-second read.
  expect(tookOver).toBeGreaterThan(LEASE_STALE_MS)
  expect(tookOver).toBeLessThanOrEqual(LEASE_STALE_MS + 15_000)
  expect(r.lease.cell.value!.instance).toBe(r.calls[0]!.instance as string)
})

test('tie-break when both come up together: the earlier startedAt wins', async ($, on) => {
  const r = await live($, on)
  r.lease.other.alive = true
  // The other copy came up 2 s after this one and wrote the lease first.
  r.lease.other.lease = { instance: 'other-copy', startedAt: r.startedAt + 2000, renewedAt: r.startedAt }
  await start($)
  await r.clock.advance(6_000)
  expect(r.calls).toHaveLength(1)
  expect(r.lease.cell.value!.instance).toBe(r.calls[0]!.instance as string)
})

test('tie-break: a copy that came up 2 s earlier keeps the lease', async ($, on) => {
  const r = await live($, on)
  r.lease.other.alive = true
  r.lease.other.lease = { instance: 'other-copy', startedAt: r.startedAt - 2000, renewedAt: r.startedAt }
  await start($)
  await r.clock.advance(60_000)
  expect(r.calls).toHaveLength(0)
})

for (const [other, wins] of [['0', false], ['zzzzzzzzzzzzzzzz', true]] as const) {
  test(`tie-break at the same startedAt: the lower instance id wins (other copy "${other.slice(0, 4)}")`, async ($, on) => {
    const r = await live($, on)
    r.lease.other.alive = true
    r.lease.other.lease = { instance: other, startedAt: r.startedAt, renewedAt: r.startedAt }
    await start($)
    await r.clock.advance(60_000)
    expect(r.calls.length > 0).toBe(wins)
  })
}

test('2 drops in a row: the copy gives up the lease and reports deliveryBroken', async ($, on) => {
  const r = await live($, on, { description: DELIVERY, drop: true })
  await start($)
  await r.clock.advance(6_000)
  const me = r.calls[0]!.instance as string
  r.state.answer = { pending: true, marker: 'm1' }
  // First drop at the burst's end, the second 30 s later.
  await r.clock.advance(60_000)
  expect(r.prompts.length).toBe(2)
  expect(r.statuses.some(s => s.includes('wake-up dropped'))).toBe(true)
  // The lease is given up at once.
  expect(r.lease.cell.value!.instance).toBe('')
  const broke = r.calls.length
  // While it hands over it checks nothing and says why.
  await r.clock.advance(15_000)
  expect(r.calls.length).toBe(broke)
  expect(r.statuses.at(-1)).toContain(BROKEN_STATUS)
  // No other copy took it: after 30 s this one checks again and says it is broken.
  await r.clock.advance(60_000)
  expect(r.calls.length).toBeGreaterThan(broke)
  const later = r.calls.slice(broke)
  expect(later.every(c => c.deliveryBroken === true)).toBe(true)
  expect(later.some(c => c.deliveryResult === 'dropped')).toBe(true)
  expect(r.lease.cell.value!.instance).toBe(me)
})

test('a copy that gave up the lease leaves it to another copy', async ($, on) => {
  const r = await live($, on, { description: DELIVERY, drop: true })
  await start($)
  await r.clock.advance(6_000)
  r.state.answer = { pending: true, marker: 'm1' }
  await r.clock.advance(60_000)
  expect(r.lease.cell.value!.instance).toBe('')
  // Another copy comes up and takes it.
  r.lease.other.alive = true
  r.lease.other.lease = { instance: 'other-copy', startedAt: r.clock.now() - 60_000 * 2, renewedAt: r.clock.now() }
  const before = r.calls.length
  await r.clock.advance(5 * 60_000)
  expect(r.calls.length).toBe(before)
  expect(r.lease.cell.value!.instance).toBe('other-copy')
})

test('deliveryBroken and deliveryResult go only to a Dashera that names them', async ($, on) => {
  const r = await live($, on, { drop: true })
  await start($)
  await r.clock.advance(6_000)
  r.state.answer = { pending: true, marker: 'm1' }
  await r.clock.advance(3 * 60_000)
  expect(r.prompts.length).toBeGreaterThanOrEqual(2)
  expect(r.calls.every(c => c.deliveryBroken === undefined && c.deliveryResult === undefined)).toBe(true)
})

test("a wake-up's result shows for 60 s and goes once as deliveryResult", async ($, on) => {
  const r = await live($, on, { description: DELIVERY })
  await start($)
  await r.clock.advance(6_000)
  r.state.answer = { pending: true, marker: 'm1' }
  await r.clock.advance(40_000)
  expect(r.prompts).toEqual([wakePrompt()])
  expect(r.statuses.some(s => s.includes('wake-up entered'))).toBe(true)
  r.state.answer = { pending: false, marker: null }
  await r.clock.advance(15_000)
  const sent = r.calls.filter(c => c.deliveryResult !== undefined)
  expect(sent).toHaveLength(1)
  expect(sent[0]!.deliveryResult).toBe('entered')
  expect(r.calls.every(c => c.deliveryBroken === undefined)).toBe(true)
  expect(r.statuses.at(-1)).toContain('wake-up entered')
  await r.clock.advance(SUBMIT_SHOWN_MS)
  expect(r.statuses.at(-1)).not.toContain('wake-up')
  await r.clock.advance(60_000)
  expect(r.calls.filter(c => c.deliveryResult !== undefined)).toHaveLength(1)
})

test('session.end cancels the interval and gives up the lease', async ($, on) => {
  const r = await live($, on)
  await start($)
  await r.clock.advance(6_000 + 30_000)
  expect(r.calls).toHaveLength(3)
  await end($, 'prompt_input_exit')
  expect(r.lease.cell.value!.instance).toBe('')
  await r.clock.advance(5 * 60_000)
  expect(r.calls).toHaveLength(3)
})

test('a /clear goes on checking (no session.start follows it)', async ($, on) => {
  const r = await live($, on)
  await start($)
  await r.clock.advance(6_000)
  await end($, 'clear')
  await r.clock.advance(60_000)
  expect(r.calls.length).toBeGreaterThanOrEqual(5)
})

test('session.start again in the same load starts no second interval', async ($, on) => {
  const r = await live($, on)
  await start($)
  await r.clock.advance(6_000)
  await start($)
  await r.clock.advance(10_000)
  const from = r.calls.length
  await r.clock.advance(60_000)
  expect(r.calls.length - from).toBe(4)
})
