import { expect, mock, test } from 'claude-code/testing'
import { ENDED_STATUS } from '../hooks/register'
import { PLUGIN_VERSION } from '../hooks/version'

// 0.2.15 (Julian, 7 Nov 2026): every check carries the plugin's version, and
// a conversation whose live session was ended stops checking until its next
// prompt (the connect prompt is one), so it doesn't come back by itself.

const TOOL = 'mcp__dashera__wake_status'

const setup = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-end' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('tool.list', () => ({ value: [{ name: TOOL, description: 'Dashera wake' }] }))
  on('classic.UserPromptSubmit', () => ({}))
}

test('the version is a plain dotted number', () => {
  expect(PLUGIN_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  expect(PLUGIN_VERSION).toBe('0.3.3')
})

test('sends its own version with every check, beside the conversation id', async ($, on) => {
  const clock = mock.clock(on)
  setup(on)
  const checks: Record<string, unknown>[] = []
  on('tool.call', { tool: TOOL }, (_, e) => {
    checks.push({ ...(e as unknown as Record<string, unknown>) })
    const text = JSON.stringify({ pending: false, marker: null, session: { code: 'S-1', name: 'CRM' } })
    return { result: [{ type: 'text', text }], text }
  })
  on('ui.status', () => ({ value: undefined }))
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000 + 2 * 15_000)
  expect(checks.length).toBeGreaterThanOrEqual(2)
  for (const c of checks) {
    expect(c['version']).toBe(PLUGIN_VERSION)
    expect(c['sessionId']).toBe('sess-end')
  }
})

test('an ended session stops checking until the next prompt here', async ($, on) => {
  const clock = mock.clock(on)
  setup(on)
  let ended = true
  let calls = 0
  const statuses: string[] = []
  on('tool.call', { tool: TOOL }, () => {
    calls += 1
    const text = JSON.stringify({
      pending: false,
      marker: null,
      connected: false,
      session: { code: 'S-1', name: 'CRM' },
      ...(ended ? { ended: { at: '2026-11-07T22:00:00.000Z', by: 'session' } } : {}),
    })
    return { result: [{ type: 'text', text }], text }
  })
  on('ui.status', (_, e) => {
    statuses.push((e as unknown as { text: string }).text)
    return { value: undefined }
  })
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000)
  expect(calls).toBe(1)
  expect(statuses.at(-1)).toBe(ENDED_STATUS)
  // Quiet while ended: no checks at all.
  await clock.advance(5 * 15_000)
  expect(calls).toBe(1)
  // The person pastes the connect prompt: checks resume.
  ended = false
  await $.classic.UserPromptSubmit({ prompt: 'Connect this conversation to Dashera live' } as never)
  await clock.advance(15_000)
  expect(calls).toBe(2)
  await clock.advance(15_000)
  expect(calls).toBe(3)
})
