import { expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__dashera__wake_status'

test('wakes once per new marker, never more often than every two minutes', async ($, on) => {
  const clock = mock.clock(on)
  let answer = { pending: false, marker: null as string | null }
  const prompts: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.list', () => ({
    value: [{ name: TOOL, description: 'wake' }],
  }))
  // Core sets `text` (the result as the model reads it) on a real call.
  on('tool.call', { tool: TOOL }, () => {
    const text = JSON.stringify({ ...answer, pollSeconds: 45 })
    return { result: [{ type: 'text', text }], text }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.status', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000)
  expect(prompts).toHaveLength(0)

  answer = { pending: true, marker: 'a1' }
  await clock.advance(30_000)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('check_in')

  // The same marker never wakes it again.
  await clock.advance(5 * 30_000)
  expect(prompts).toHaveLength(1)

  // A new marker does, once two minutes have passed since the last wake.
  answer = { pending: true, marker: 'b2' }
  await clock.advance(30_000)
  expect(prompts).toHaveLength(2)
})

test('says what to do when the Dashera connector is missing', async ($, on) => {
  const clock = mock.clock(on)
  const statuses: (string | undefined)[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.list', () => ({ value: [] }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000)
  expect(statuses.some(s => s?.includes('add the Dashera connector'))).toBe(true)
})

test('finds Dashera under a connector named by an id', async ($, on) => {
  const clock = mock.clock(on)
  const ID_TOOL = 'mcp__618e79f2-adbe-49a0-a83c-37cbf0b55c46__wake_status'
  const prompts: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('tool.list', () => ({
    value: [
      { name: 'mcp__other__wake_status', description: 'Some other service' },
      { name: ID_TOOL, description: 'Yes or no: is anything new addressed to you in Dashera' },
    ],
  }))
  on('tool.call', { tool: ID_TOOL }, () => {
    const text = JSON.stringify({ pending: true, marker: 'm1', pollSeconds: 30 })
    return { result: [{ type: 'text', text }], text }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000)
  expect(prompts).toHaveLength(1)
})

test('still checks when an older connector refuses the session details', async ($, on) => {
  const clock = mock.clock(on)
  const TOOL2 = 'mcp__abc__wake_status'
  const calls: Record<string, unknown>[] = []
  const prompts: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('tool.list', () => ({
    value: [{ name: TOOL2, description: 'is anything new addressed to you in Dashera' }],
  }))
  on('tool.call', { tool: TOOL2 }, (_, e) => {
    calls.push({ ...e })
    if ('sessionId' in e) return { isError: true, result: 'unknown field', text: 'unknown field' }
    const text = JSON.stringify({ pending: true, marker: 'z', pollSeconds: 30 })
    return { result: [{ type: 'text', text }], text }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/x/proj', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000)
  expect(prompts).toHaveLength(1)
})
