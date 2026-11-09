import { expect, mock, test } from 'claude-code/testing'
import {
  CONTINUITY_MAX_AGE_MS,
  CONVERSATIONS_KEY,
  conversationsOf,
  LEGACY_CONTINUITY_KEY,
  rememberConversation,
  resumedFrom,
  takesInstance,
  transcriptSessionIds,
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

/** A transcript's lines, each written under the session id given. */
const transcript = (...ids: string[]) =>
  ids.map(id => JSON.stringify({ type: 'user', sessionId: id, message: { content: 'x' } })).join('\n') + '\n'

/** The plugin's store, as earlier processes left it, readable and writable. */
function storeOf(on: Parameters<Parameters<typeof test>[1]>[1], initial: Record<string, unknown>) {
  const store: Record<string, unknown> = { ...initial }
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  return store
}

/** `head` of the resumed conversation's transcript. */
function transcriptHead(on: Parameters<Parameters<typeof test>[1]>[1], text: string) {
  on('process.run', (_, e) => {
    const argv = (e as { argv: string[] }).argv
    const ran = { stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    if (argv[0] === 'head') return { value: { ...ran, exitCode: 0, stdout: text } }
    return { value: { ...ran, exitCode: 1, stdout: '' } }
  })
}

test('a conversation resumed under a new id names the id its own transcript continues', async ($, on) => {
  const clock = mock.clock(on)
  const store = storeOf(on, { [CONVERSATIONS_KEY]: { 'conv-old': { at: Date.now() - 60_000 } } })
  on('session.id', () => ({ value: 'conv-restarted' }))
  on('classic.SessionStart', () => ({}))
  transcriptHead(on, transcript('conv-old', 'conv-old', 'conv-restarted'))
  const checks: Check[] = []
  connector(on, checks)
  await $.classic.SessionStart({ source: 'resume', transcript_path: '/t/conv-restarted.jsonl' } as never)
  await $.session.start({ cwd: '/Users/j/crm', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000)
  expect(checks[0]?.['sessionId']).toBe('conv-restarted')
  expect(checks[0]?.['previousSessionId']).toBe('conv-old')
  // Connected under the new id: the store names the conversation by id.
  await clock.advance(15_000)
  const stored = conversationsOf(store[CONVERSATIONS_KEY])
  expect(Object.keys(stored).sort()).toEqual(['conv-old', 'conv-restarted'])
})

test('two conversations in one folder: a restart never hands one the other\'s id', async ($, on) => {
  const clock = mock.clock(on)
  // Dashera Builder connected last in this folder (0.3.0 kept it per folder).
  storeOf(on, {
    [LEGACY_CONTINUITY_KEY]: { '/Users/j/ops': { id: 'builder', at: Date.now() - 30_000 } },
    [CONVERSATIONS_KEY]: { builder: { at: Date.now() - 30_000 }, crm: { at: Date.now() - 40_000 } },
  })
  // CRM comes back after the restart, under its own id.
  on('session.id', () => ({ value: 'crm' }))
  on('classic.SessionStart', () => ({}))
  transcriptHead(on, transcript('crm', 'crm'))
  const checks: Check[] = []
  connector(on, checks)
  await $.classic.SessionStart({ source: 'resume', transcript_path: '/t/crm.jsonl' } as never)
  await $.session.start({ cwd: '/Users/j/ops', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000 + 2 * 15_000)
  expect(checks.length).toBeGreaterThanOrEqual(2)
  for (const c of checks) {
    expect(c['sessionId']).toBe('crm')
    expect(c['previousSessionId']).toBeUndefined()
  }
})

test('a resumed conversation under a new id whose transcript names no connected id sends none', async ($, on) => {
  const clock = mock.clock(on)
  storeOf(on, { [CONVERSATIONS_KEY]: { builder: { at: Date.now() - 30_000 } } })
  on('session.id', () => ({ value: 'milo-2' }))
  on('classic.SessionStart', () => ({}))
  transcriptHead(on, transcript('milo-1', 'milo-2'))
  const checks: Check[] = []
  connector(on, checks)
  await $.classic.SessionStart({ source: 'resume', transcript_path: '/t/milo-2.jsonl' } as never)
  await $.session.start({ cwd: '/Users/j/ops', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000 + 15_000)
  for (const c of checks) expect(c['previousSessionId']).toBeUndefined()
})

test('a fork is a new conversation: nothing carried over', async ($, on) => {
  const clock = mock.clock(on)
  storeOf(on, { [CONVERSATIONS_KEY]: { 'conv-old': { at: Date.now() - 60_000 } } })
  on('session.id', () => ({ value: 'conv-fork' }))
  on('classic.SessionStart', () => ({}))
  transcriptHead(on, transcript('conv-old', 'conv-fork'))
  const checks: Check[] = []
  connector(on, checks)
  await $.classic.SessionStart({ source: 'fork', transcript_path: '/t/conv-fork.jsonl' } as never)
  await $.session.start({ cwd: '/Users/j/crm', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000 + 15_000)
  for (const c of checks) expect(c['previousSessionId']).toBeUndefined()
})

test('a new conversation (not a resume) never claims a stored id', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { [CONVERSATIONS_KEY]: { 'conv-old': { at: Date.now() - 60_000 } } })
  on('session.id', () => ({ value: 'conv-fresh' }))
  const checks: Check[] = []
  connector(on, checks)
  await $.session.start({ cwd: '/Users/j/crm', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000 + 15_000)
  expect(checks.length).toBeGreaterThanOrEqual(1)
  for (const c of checks) expect(c['previousSessionId']).toBeUndefined()
})

test('0.3.0\'s per-folder ids are cleared once connected', async ($, on) => {
  const clock = mock.clock(on)
  const store = storeOf(on, {
    [LEGACY_CONTINUITY_KEY]: { '/Users/j/crm': { id: 'someone-else', at: Date.now() } },
  })
  on('session.id', () => ({ value: 'conv-x' }))
  const checks: Check[] = []
  connector(on, checks)
  await $.session.start({ cwd: '/Users/j/crm', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000 + 15_000)
  expect(store[LEGACY_CONTINUITY_KEY]).toEqual({})
  expect(Object.keys(conversationsOf(store[CONVERSATIONS_KEY]))).toEqual(['conv-x'])
})

test('each copy of the plugin names itself, to a Dashera that takes it', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.id', () => ({ value: 'conv-i' }))
  const checks: Check[] = []
  connector(on, checks, `${DESC} Each copy of the plugin also sends its own instance id.`)
  await $.session.start({ cwd: '/Users/j/crm', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000 + 2 * 15_000)
  expect(checks.length).toBeGreaterThanOrEqual(2)
  const ids = new Set(checks.map(c => c['instance']))
  expect(ids.size).toBe(1)
  expect(typeof checks[0]?.['instance']).toBe('string')
  expect(String(checks[0]?.['instance']).length).toBeGreaterThan(6)
})

test('an older Dashera without instance never gets it', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.id', () => ({ value: 'conv-j' }))
  const checks: Check[] = []
  connector(on, checks)
  await $.session.start({ cwd: '/Users/j/crm', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000 + 15_000)
  expect(checks.length).toBeGreaterThanOrEqual(1)
  for (const c of checks) expect(c['instance']).toBeUndefined()
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

test('store helpers: per conversation id, never per folder', () => {
  const now = Date.now()
  // 0.3.0's folder entries are dropped.
  let s = conversationsOf({ bad: 1, '/Users/j/crm': { id: 'a', at: now }, a: { at: now } })
  expect(Object.keys(s)).toEqual(['a'])
  s = rememberConversation(s, 'b', now)
  expect(resumedFrom(s, ['a', 'b', 'c'], 'c', now)).toBe('b')
  expect(resumedFrom(s, ['a', 'c'], 'c', now)).toBe('a')
  expect(resumedFrom(s, ['c'], 'c', now)).toBeNull()
  expect(resumedFrom(s, ['x', 'c'], 'c', now)).toBeNull()
  expect(resumedFrom(s, ['b', 'c'], 'c', now + CONTINUITY_MAX_AGE_MS + 1)).toBeNull()
  expect(transcriptSessionIds(transcript('a', 'a', 'b') + '{"sessionId": "c"}')).toEqual(['a', 'b', 'c'])
  expect(takesInstance({ description: 'sends its own instance id' })).toBe(true)
  expect(takesInstance({ description: 'Yes or no' })).toBe(false)
})
