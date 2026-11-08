import { expect, mock, test } from 'claude-code/testing'
import {
  CONTINUITY_KEY,
  CONTINUITY_MAX_AGE_MS,
  continuityOf,
  rememberConnected,
  resumedFrom,
} from '../hooks/register'

// 0.3.0 (Julian, 8 Nov 2026): a connected conversation that goes on under a
// new Claude Code session id names the id it last checked in under while
// connected (previousSessionId), so Dashera keeps it the same live session.

const TOOL = 'mcp__dashera__wake_status'
const DESC = 'Yes or no: anything new in Dashera. The plugin sends previousSessionId.'

type Check = Record<string, unknown>

function connector(on: Parameters<Parameters<typeof test>[1]>[1], checks: Check[], description = DESC) {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/Users/j/crm' }))
  on('tool.list', () => ({ value: [{ name: TOOL, description }] }))
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: TOOL }, (_, e) => {
    checks.push({ ...(e as unknown as Check) })
    const text = JSON.stringify({ pending: false, marker: null, connected: true, session: { code: 'S-2AFF27', name: 'CRM' } })
    return { result: [{ type: 'text', text }], text }
  })
}

test('a new session id in the same process sends the id it continues, then stops', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  let id = 'conv-old'
  on('session.id', () => ({ value: id }))
  const checks: Check[] = []
  connector(on, checks)
  await $.session.start({ cwd: '/Users/j/crm', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000 + 15_000)
  expect(checks.length).toBeGreaterThanOrEqual(1)
  for (const c of checks) {
    expect(c['sessionId']).toBe('conv-old')
    expect(c['previousSessionId']).toBeUndefined()
  }
  // The conversation goes on under a new id (a resume): no session.start.
  id = 'conv-new'
  const before = checks.length
  await clock.advance(15_000)
  const moved = checks.slice(before)
  expect(moved[0]?.['sessionId']).toBe('conv-new')
  expect(moved[0]?.['previousSessionId']).toBe('conv-old')
  // Connected again (same code): later checks carry only the new id.
  await clock.advance(2 * 15_000)
  const later = checks.slice(before + 1)
  expect(later.length).toBeGreaterThanOrEqual(1)
  for (const c of later) {
    expect(c['sessionId']).toBe('conv-new')
    expect(c['previousSessionId']).toBeUndefined()
  }
})

test('the connected id persists in the plugin store and a resumed conversation names it', async ($, on) => {
  const clock = mock.clock(on)
  // The plugin's store, as an earlier process left it: this folder
  // connected under conv-old.
  const store: Record<string, unknown> = {
    [CONTINUITY_KEY]: { '/Users/j/crm': { id: 'conv-old', at: Date.now() - 60_000 } },
  }
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'conv-restarted' }))
  on('classic.SessionStart', () => ({}))
  const checks: Check[] = []
  connector(on, checks)
  await $.classic.SessionStart({ source: 'resume' } as never)
  await $.session.start({ cwd: '/Users/j/crm', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000)
  expect(checks[0]?.['sessionId']).toBe('conv-restarted')
  expect(checks[0]?.['previousSessionId']).toBe('conv-old')
  // Connected under the new id: the store now names it for next time.
  await clock.advance(15_000)
  const stored = continuityOf(store[CONTINUITY_KEY])
  expect(stored['/Users/j/crm']?.id).toBe('conv-restarted')
})

test('a new conversation (not a resume) never claims the folder\'s stored id', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, {
    [CONTINUITY_KEY]: { '/Users/j/crm': { id: 'conv-old', at: Date.now() - 60_000 } },
  })
  on('session.id', () => ({ value: 'conv-fresh' }))
  const checks: Check[] = []
  connector(on, checks)
  await $.session.start({ cwd: '/Users/j/crm', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000 + 15_000)
  expect(checks.length).toBeGreaterThanOrEqual(1)
  for (const c of checks) expect(c['previousSessionId']).toBeUndefined()
})

test('a /clear starts a new conversation: nothing carried over', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  let id = 'conv-a'
  on('session.id', () => ({ value: id }))
  const checks: Check[] = []
  connector(on, checks)
  on('session.end', (_, e) => ({ sessionId: (e as { sessionId: string }).sessionId }))
  await $.session.start({ cwd: '/Users/j/crm', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000 + 15_000)
  await $.session.end({ reason: 'clear', sessionId: 'conv-a' } as never)
  id = 'conv-b'
  const before = checks.length
  await clock.advance(2 * 15_000)
  const after = checks.slice(before)
  expect(after[0]?.['sessionId']).toBe('conv-b')
  for (const c of after) expect(c['previousSessionId']).toBeUndefined()
})

test('an older Dashera whose tool list lacks previousSessionId never gets it', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  let id = 'o-1'
  on('session.id', () => ({ value: id }))
  const checks: Check[] = []
  connector(on, checks, 'Yes or no: anything new in Dashera.')
  await $.session.start({ cwd: '/Users/j/crm', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000 + 15_000)
  id = 'o-2'
  await clock.advance(2 * 15_000)
  expect(checks.at(-1)?.['sessionId']).toBe('o-2')
  for (const c of checks) expect(c['previousSessionId']).toBeUndefined()
  // The other details still go with every check.
  expect(checks.at(-1)?.['folder']).toBe('crm')
})

test('store helpers: newest per folder, too old or its own id offers nothing', () => {
  const now = Date.now()
  let s = continuityOf({ bad: 1, '/x': { id: 'a', at: now } })
  expect(Object.keys(s)).toEqual(['/x'])
  s = rememberConnected(s, '/x', 'b', now)
  expect(resumedFrom(s, '/x', 'c', now)).toBe('b')
  expect(resumedFrom(s, '/x', 'b', now)).toBeNull()
  expect(resumedFrom(s, '/x', 'c', now + CONTINUITY_MAX_AGE_MS + 1)).toBeNull()
  expect(resumedFrom(s, '/y', 'c', now)).toBeNull()
})
