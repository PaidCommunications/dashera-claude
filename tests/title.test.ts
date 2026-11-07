import { expect, mock, test } from 'claude-code/testing'
import {
  lastCustomTitle,
  projectFolderOf,
  TITLE_MAX,
  TITLE_REFRESH_MS,
  TITLE_TAIL_BYTES,
  titleFromDashera,
  titleToSend,
  transcriptPath,
} from '../hooks/register'

// Rename sync (0.2.14, Julian, 7 Nov 2026): renaming this conversation
// renames its Dashera session, and a name the owner gives the session in
// Dashera comes back onto the conversation. Both at no AI token cost.

const TOOL = 'mcp__dashera__wake_status'
const row = (title: string, sessionId = 's1') =>
  JSON.stringify({ type: 'custom-title', customTitle: title, sessionId })

test('finds the transcript where Claude Code writes it', () => {
  expect(projectFolderOf('/Users/julian/Projects/dashera')).toBe('-Users-julian-Projects-dashera')
  // A space, a dot and an underscore become "-" too; letters and digits stay.
  expect(projectFolderOf('/Users/j/Library/Application Support/a.b_c')).toBe(
    '-Users-j-Library-Application-Support-a-b-c',
  )
  expect(transcriptPath('/Users/julian/', '/Users/julian/Projects/dashera', 'abc-123')).toBe(
    '/Users/julian/.claude/projects/-Users-julian-Projects-dashera/abc-123.jsonl',
  )
})

test('reads the last custom-title line of a transcript tail', () => {
  const tail = [
    '{"type":"user","message":{"content":"hello"}}',
    row('First name'),
    '{"type":"assistant","message":{"content":"…"}}',
    row('  Second name  '),
    '{"type":"user","message":{"content":"more"}}',
    '',
  ].join('\n')
  expect(lastCustomTitle(tail)).toBe('Second name')
  // A tail cut in the middle of a line: that line is skipped, not misread.
  expect(lastCustomTitle(`e","customTitle":"Cut off"}\n${row('Whole')}\n`)).toBe('Whole')
  expect(lastCustomTitle(`e","customTitle":"Cut off"}\n{"type":"user"}\n`)).toBeNull()
  // Never renamed: nothing to send. Other rows that mention the words don't count.
  expect(lastCustomTitle('{"type":"user","message":{"content":"a custom-title line"}}\n')).toBeNull()
  expect(lastCustomTitle('')).toBeNull()
  // Cut to a session name's length; blank titles are none.
  expect(lastCustomTitle(row('x'.repeat(80)))).toBe('x'.repeat(TITLE_MAX))
  expect(lastCustomTitle(row('   '))).toBeNull()
})

test('sends the title only when it changed since the last send', () => {
  expect(titleToSend(null, null)).toBeNull()
  expect(titleToSend('CRM', null)).toBe('CRM')
  expect(titleToSend('CRM', 'CRM')).toBeNull()
  expect(titleToSend('CRM imports', 'CRM')).toBe('CRM imports')
})

test('takes a name the owner gave in Dashera, and nothing else', () => {
  expect(titleFromDashera({ name: 'Imports (Julian)', nameSource: 'owner' }, 'CRM')).toBe(
    'Imports (Julian)',
  )
  // Already the conversation's title, or unknown title: only when it differs.
  expect(titleFromDashera({ name: 'CRM', nameSource: 'owner' }, 'CRM')).toBeNull()
  expect(titleFromDashera({ name: 'CRM', nameSource: 'owner' }, null)).toBe('CRM')
  // The agent's own name, or one that follows the title: the title leads.
  expect(titleFromDashera({ name: 'CRM', nameSource: 'agent' }, 'Other')).toBeNull()
  expect(titleFromDashera({ name: 'CRM', nameSource: 'title' }, 'Other')).toBeNull()
  expect(titleFromDashera({ name: null, nameSource: 'owner' }, 'Other')).toBeNull()
  expect(titleFromDashera({}, 'Other')).toBeNull()
})

test('sends a changed title with the check, reading the tail at most once a minute', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/Users/julian' })
  let tail = `{"type":"user"}\n${row('Alpha')}\n`
  const reads: string[][] = []
  const checks: Record<string, unknown>[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: '/Users/julian/Projects/dashera' }))
  on('fs.exists', (_, e) => ({
    value: e.path === '/Users/julian/.claude/projects/-Users-julian-Projects-dashera/sess-1.jsonl',
  }))
  on('process.run', (_, e) => {
    if (e.argv[0] !== 'tail') {
      return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    reads.push([...e.argv])
    return { value: { exitCode: 0, stdout: tail, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.list', () => ({ value: [{ name: TOOL, description: 'Dashera wake' }] }))
  on('tool.call', { tool: TOOL }, (_, e) => {
    checks.push({ ...(e as unknown as Record<string, unknown>) })
    const text = JSON.stringify({
      pending: false,
      marker: null,
      session: { code: 'S-1', name: 'Alpha' },
      name: 'Alpha',
      nameSource: 'title',
    })
    return { result: [{ type: 'text', text }], text }
  })
  on('ui.status', () => ({ value: undefined }))

  await $.session.start({ cwd: '/Users/julian/Projects/dashera', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000)
  expect(checks).toHaveLength(1)
  // The first check carries the title; the tail was read with `tail -c`.
  expect(checks[0]!['title']).toBe('Alpha')
  expect(checks[0]!['sessionId']).toBe('sess-1')
  expect(reads[0]).toEqual(['tail', '-c', String(TITLE_TAIL_BYTES), '/Users/julian/.claude/projects/-Users-julian-Projects-dashera/sess-1.jsonl'])

  // Unchanged: later checks don't repeat it, and the file isn't re-read
  // within the minute.
  await clock.advance(2 * 15_000)
  expect(checks.length).toBeGreaterThanOrEqual(2)
  expect(checks.slice(1).every(c => !('title' in c))).toBe(true)
  expect(reads).toHaveLength(1)

  // Renamed here: within a minute the next check carries the new title, once.
  tail += `${row('Beta')}\n`
  await clock.advance(TITLE_REFRESH_MS + 15_000)
  const withTitle = checks.filter(c => 'title' in c)
  expect(withTitle).toHaveLength(2)
  expect(withTitle[1]!['title']).toBe('Beta')
  expect(reads.length).toBeGreaterThanOrEqual(2)
})

test('puts a name the owner gave in Dashera on this conversation at the next prompt', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/Users/julian' })
  let answer: Record<string, unknown> = {
    pending: false,
    marker: null,
    session: { code: 'S-1', name: 'CRM' },
    name: 'CRM',
    nameSource: 'title',
  }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-2' }))
  on('session.cwd', () => ({ value: '/Users/julian/Projects/dashera' }))
  on('fs.exists', () => ({ value: true }))
  on('process.run', (_, e) => ({
    value: {
      exitCode: e.argv[0] === 'tail' ? 0 : 1,
      stdout: e.argv[0] === 'tail' ? `${row('CRM')}\n` : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('tool.list', () => ({ value: [{ name: TOOL, description: 'Dashera wake' }] }))
  on('tool.call', { tool: TOOL }, () => {
    const text = JSON.stringify(answer)
    return { result: [{ type: 'text', text }], text }
  })
  on('ui.status', () => ({ value: undefined }))
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.SessionStart', () => ({}))

  await $.session.start({ cwd: '/Users/julian/Projects/dashera', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000)
  // Nothing to put on the conversation while the names agree.
  expect(await $.classic.UserPromptSubmit({ prompt: 'hello' } as never)).not.toHaveProperty('sessionTitle')

  // The owner renames the session on its card: the next prompt takes it.
  answer = { ...answer, session: { code: 'S-1', name: 'Imports (Julian)' }, name: 'Imports (Julian)', nameSource: 'owner' }
  await clock.advance(15_000)
  expect(await $.classic.UserPromptSubmit({ prompt: 'next' } as never)).toMatchObject({
    sessionTitle: 'Imports (Julian)',
  })
  // Once: the title is taken as set until the transcript says otherwise.
  expect(await $.classic.UserPromptSubmit({ prompt: 'again' } as never)).not.toHaveProperty('sessionTitle')
  await clock.advance(15_000)
  expect(await $.classic.SessionStart({ source: 'resume' } as never)).not.toHaveProperty('sessionTitle')
})
