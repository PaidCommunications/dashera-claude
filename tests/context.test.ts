import { expect, mock, test } from 'claude-code/testing'
import {
  CONTEXT_RESEND_MS,
  CONTEXT_TAIL_BYTES,
  contextToSend,
  lastContextTokens,
  takesContext,
} from '../hooks/register'

// Context size (0.3.10, Dashera Token savings 2): the check carries the
// conversation's context size, read from the usage numbers on the last
// main-thread assistant line in the end of its transcript. Numbers only,
// and only to a Dashera whose wake_status takes contextTokens.

const TOOL = 'mcp__dashera__wake_status'
const turn = (input: number, created: number, read: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'private words' }],
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: created,
        cache_read_input_tokens: read,
        output_tokens: 99,
      },
    },
    ...extra,
  })

test('adds the three input counts of the last main-thread turn', () => {
  const tail = [
    turn(1, 1000, 400_000),
    JSON.stringify({ type: 'user', message: { content: 'hello' } }),
    turn(2, 3000, 500_000),
    // A sub-agent's turn is not this conversation's context.
    turn(5, 5, 5, { isSidechain: true }),
    '{"type":"assistant","message":{"usage":{"input_tok', // cut by the tail
  ].join('\n')
  expect(lastContextTokens(tail)).toBe(503_002)
  expect(lastContextTokens('{"type":"user"}\n')).toBeNull()
  expect(lastContextTokens('')).toBeNull()
})

test('sends a size when new, after a 5% move, or 10 minutes after the last send', () => {
  expect(contextToSend(null, null, 0, 0)).toBeNull()
  expect(contextToSend(500_000, null, 0, 0)).toBe(500_000)
  expect(contextToSend(510_000, 500_000, 0, 60_000)).toBeNull()
  expect(contextToSend(530_000, 500_000, 0, 60_000)).toBe(530_000)
  expect(contextToSend(510_000, 500_000, 0, CONTEXT_RESEND_MS)).toBe(510_000)
})

test('knows a Dashera that takes contextTokens by its tool description', () => {
  expect(takesContext({ description: 'Dashera wake. 0.3.10+ sends contextTokens.' })).toBe(true)
  expect(takesContext({ description: 'Dashera wake' })).toBe(false)
})

test('the check carries contextTokens only to a Dashera that takes it, once until it moves', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/Users/me' })
  let tail = `${turn(2, 3000, 500_000)}\n`
  let description = 'Dashera wake. Plugin 0.3.10+ sends contextTokens.'
  const reads: string[][] = []
  const checks: Record<string, unknown>[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-ctx' }))
  on('session.cwd', () => ({ value: '/Users/me/Projects/app' }))
  on('fs.exists', (_, e) => ({
    value: e.path === '/Users/me/.claude/projects/-Users-me-Projects-app/sess-ctx.jsonl',
  }))
  on('process.run', (_, e) => {
    if (e.argv[0] !== 'tail') {
      return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    reads.push([...e.argv])
    return { value: { exitCode: 0, stdout: tail, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.list', () => ({ value: [{ name: TOOL, description }] }))
  on('tool.call', { tool: TOOL }, (_, e) => {
    checks.push({ ...(e as unknown as Record<string, unknown>) })
    const text = JSON.stringify({ pending: false, marker: null, session: { code: 'S-1', name: null } })
    return { result: [{ type: 'text', text }], text }
  })
  on('ui.status', () => ({ value: undefined }))

  await $.session.start({ cwd: '/Users/me/Projects/app', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000)
  expect(checks).toHaveLength(1)
  expect(checks[0]!['contextTokens']).toBe(503_002)
  expect(reads.some(r => r[2] === String(CONTEXT_TAIL_BYTES))).toBe(true)
  // Never content.
  expect(JSON.stringify(checks)).not.toContain('private words')

  // Unchanged: not sent again.
  await clock.advance(2 * 15_000)
  expect(checks.slice(1).every(c => !('contextTokens' in c))).toBe(true)

  // Grown by more than 5%: sent with a check within the next minute.
  tail += `${turn(2, 3000, 700_000)}\n`
  await clock.advance(75_000)
  const sent = checks.filter(c => 'contextTokens' in c)
  expect(sent).toHaveLength(2)
  expect(sent[1]!['contextTokens']).toBe(703_002)

  // A Dashera that doesn't take it never gets it.
  description = 'Dashera wake'
  tail += `${turn(2, 3000, 900_000)}\n`
  const before = checks.length
  await clock.advance(CONTEXT_RESEND_MS + 30_000)
  expect(checks.length).toBeGreaterThan(before)
  expect(checks.slice(before).every(c => !('contextTokens' in c))).toBe(true)
})
