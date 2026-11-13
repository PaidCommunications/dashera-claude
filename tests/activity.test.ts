import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import { ACTIVITY_LABELS, activityLabel, mcpPrefix } from '../hooks/register'

// 0.3.7 (Julian, 13 Nov 2026): while a turn runs, the checks already running
// carry the KIND of the latest tool call as one fixed label (`activity`) and
// when it was made (`activityAt`). Never the call's inputs, file names,
// commands, URLs or content; cleared when the turn ends.

const TOOL = 'mcp__618e79f2-adbe-49a0-a83c-37cbf0b55c46__wake_status'
const DESCRIPTION =
  'Dashera wake. Each copy sends instance. The plugin reports turnStartedAt, deliveredMarker, activity and activityAt.'
type Args = Record<string, unknown>

async function live($: Engine, on: On, opts: { description?: string } = {}) {
  const clock = mock.clock(on)
  const state = { answer: { pending: false, marker: null } as Record<string, unknown> }
  const calls: Args[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-activity' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('tool.list', () => ({ value: [{ name: TOOL, description: opts.description ?? DESCRIPTION, mcp: true }] }))
  on('tool.call', (_, e) => {
    if (e.tool === TOOL) {
      calls.push({ ...(e as unknown as Args) })
      const text = JSON.stringify({ ...state.answer, session: { code: 'S-C0721A', name: null }, pollSeconds: 15 })
      return { result: [{ type: 'text', text }], text }
    }
    return { result: [{ type: 'text', text: 'ok' }], text: 'ok' }
  })
  on('ui.status', () => ({ value: undefined }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000)
  return { clock, state, calls }
}

const done = (turnId: string) => ({ answer: 'done', durationMs: 1000, isAborted: false, turnId, reason: 'answer' as const })

test('each kind of tool maps to its fixed label', () => {
  const prefixes = [mcpPrefix(TOOL)!]
  expect(mcpPrefix(TOOL)).toBe('mcp__618e79f2-adbe-49a0-a83c-37cbf0b55c46__')
  const cases: Array<[string, string]> = [
    ['Read', 'Reading files'],
    ['Grep', 'Reading files'],
    ['Glob', 'Reading files'],
    ['Edit', 'Editing code'],
    ['Write', 'Editing code'],
    ['NotebookEdit', 'Editing code'],
    ['Bash', 'Running a command'],
    ['WebSearch', 'Searching the web'],
    ['WebFetch', 'Searching the web'],
    ['mcp__dashera__check_in', 'Using Dashera'],
    ['mcp__618e79f2-adbe-49a0-a83c-37cbf0b55c46__post_channel_message', 'Using Dashera'],
    ['mcp__claude-in-chrome__navigate', 'Using a browser'],
    ['mcp__Claude_Browser__read_page', 'Using a browser'],
    ['Agent', 'Working with a sub-agent'],
    ['Task', 'Working with a sub-agent'],
    ['TodoWrite', 'Working'],
    ['mcp__github__create_issue', 'Working'],
  ]
  for (const [tool, label] of cases) expect(activityLabel(tool, prefixes)).toBe(label)
  // Every label is one of the fixed list Dashera accepts.
  for (const [tool] of cases) expect(ACTIVITY_LABELS as readonly string[]).toContain(activityLabel(tool, prefixes))
  // Without the connector's prefix, an id-named connector is just "Working".
  expect(activityLabel('mcp__618e79f2-adbe-49a0-a83c-37cbf0b55c46__check_in')).toBe('Working')
})

test("the running turn's latest tool kind rides on the regular check, with its time", async ($, on) => {
  const { clock, calls } = await live($, on)
  await $.turn.start({ text: 'q', turnId: 't1' })
  await clock.advance(1_000)
  await $.tool.call({ tool: 'Read', file_path: '/Users/someone/secret-plan.md' })
  const readAt = clock.now()
  await clock.advance(15_000)
  const c = calls.at(-1)!
  expect(c.activity).toBe('Reading files')
  expect(c.activityAt).toBe(new Date(readAt).toISOString())
  expect(typeof c.turnStartedAt).toBe('string')
  // The latest call wins.
  await $.tool.call({ tool: 'Bash', command: 'rm -rf /tmp/private-build', description: 'clean' })
  await clock.advance(15_000)
  expect(calls.at(-1)!.activity).toBe('Running a command')
  await $.turn.complete(done('t1'))
})

test('no tool input, file name, command, URL or content is ever sent', async ($, on) => {
  const { clock, calls } = await live($, on)
  await $.turn.start({ text: 'q', turnId: 't2' })
  const secrets = ['/Users/someone/secret-plan.md', 'curl https://private.example/x?token=abc', 'https://private.example/page', 'TOP SECRET BODY']
  await $.tool.call({ tool: 'Read', file_path: secrets[0]! })
  await clock.advance(15_000)
  await $.tool.call({ tool: 'Bash', command: secrets[1]!, description: 'fetch' })
  await clock.advance(15_000)
  await $.tool.call({ tool: 'WebFetch', url: secrets[2]!, prompt: 'summarize' })
  await clock.advance(15_000)
  await $.tool.call({ tool: 'Write', file_path: '/Users/someone/notes.txt', content: secrets[3]! })
  await clock.advance(15_000)
  await $.turn.complete(done('t2'))
  await clock.advance(15_000)
  const sent = JSON.stringify(calls)
  for (const s of [...secrets, 'notes.txt', 'secret-plan', 'private.example', 'summarize', 'fetch"']) {
    expect(sent.includes(s)).toBe(false)
  }
  // Not even the tool's own name: no field carries Read, Bash, WebFetch or Write.
  for (const c of calls) {
    for (const v of Object.values(c)) expect(['Read', 'Bash', 'WebFetch', 'Write']).not.toContain(v)
  }
  // Only fixed labels ever went out.
  for (const c of calls) {
    if (c.activity !== undefined) expect(ACTIVITY_LABELS as readonly string[]).toContain(c.activity as string)
  }
  expect(calls.filter(c => c.activity !== undefined).length).toBeGreaterThan(0)
})

test('the activity clears when the turn ends and does not carry into the next turn', async ($, on) => {
  const { clock, calls } = await live($, on)
  await $.turn.start({ text: 'q', turnId: 't3' })
  await $.tool.call({ tool: 'Edit', file_path: '/w/a.ts', old_string: 'a', new_string: 'b' })
  await clock.advance(15_000)
  expect(calls.at(-1)!.activity).toBe('Editing code')
  await $.turn.complete(done('t3'))
  await clock.advance(2_000)
  // The "none" check carries no activity, and later idle checks neither.
  expect(calls.at(-1)!.turnStartedAt).toBe('none')
  expect(calls.at(-1)!.activity).toBeUndefined()
  await clock.advance(30_000)
  expect(calls.at(-1)!.activity).toBeUndefined()
  // A new turn starts without the old label until a tool runs in it.
  await $.turn.start({ text: 'again', turnId: 't4' })
  await clock.advance(15_000)
  expect(typeof calls.at(-1)!.turnStartedAt).toBe('string')
  expect(calls.at(-1)!.activity).toBeUndefined()
  expect(calls.at(-1)!.activityAt).toBeUndefined()
  await $.turn.complete(done('t4'))
})

test("a subagent's own calls and calls outside a turn set no activity", async ($, on) => {
  const { clock, calls } = await live($, on)
  await $.tool.call({ tool: 'Read', file_path: '/w/x' })
  await clock.advance(15_000)
  expect(calls.every(c => c.activity === undefined)).toBe(true)
  await $.turn.start({ text: 'q', turnId: 't5' })
  await $.tool.call({ tool: 'Agent', prompt: 'look around', description: 'explore', subagent_type: 'Explore' } as never)
  await $.tool.call({ tool: 'Grep', pattern: 'x', agentId: 'sub-1' } as never)
  await clock.advance(15_000)
  expect(calls.at(-1)!.activity).toBe('Working with a sub-agent')
  await $.turn.complete(done('t5'))
})

test('a Dashera whose tool predates activity gets none', async ($, on) => {
  const { clock, calls } = await live($, on, {
    description: 'Dashera wake. Each copy sends instance. The plugin reports turnStartedAt and deliveredMarker.',
  })
  await $.turn.start({ text: 'q', turnId: 't6' })
  await $.tool.call({ tool: 'Read', file_path: '/w/x' })
  await clock.advance(30_000)
  expect(calls.some(c => typeof c.turnStartedAt === 'string')).toBe(true)
  expect(calls.every(c => c.activity === undefined && c.activityAt === undefined)).toBe(true)
  await $.turn.complete(done('t6'))
})
