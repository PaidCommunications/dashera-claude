import { expect, mock, test } from 'claude-code/testing'
import { wakePrompt } from '../hooks/register'

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

test('asks the connector directly first', async ($, on) => {
  const clock = mock.clock(on)
  const ID_TOOL = 'mcp__618e79f2-adbe-49a0-a83c-37cbf0b55c46__wake_status'
  const servers: string[] = []
  const prompts: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('tool.list', () => ({
    value: [{ name: ID_TOOL, description: 'is anything new addressed to you in Dashera' }],
  }))
  // What auto mode answers a call no message of the user's asked for.
  on('tool.call', { tool: ID_TOOL }, () => {
    const text = 'Error: The server-side auto mode classifier gave no verdict'
    return { result: text, text }
  })
  on('mcp.call', (_, e) => {
    servers.push(e.server)
    const text = JSON.stringify({ pending: true, marker: 'd1', pollSeconds: 30 })
    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000)
  expect(servers[0]).toBe('618e79f2-adbe-49a0-a83c-37cbf0b55c46')
  expect(prompts).toHaveLength(1)
})

test('says the check is paused, and why, instead of going quiet', async ($, on) => {
  const clock = mock.clock(on)
  const statuses: (string | undefined)[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('tool.list', () => ({ value: [{ name: TOOL, description: 'Dashera wake' }] }))
  on('mcp.call', () => {
    throw new Error('not connected')
  })
  on('tool.call', { tool: TOOL }, () => {
    const text = 'Error: The server-side auto mode classifier gave no verdict'
    return { result: text, text }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000)
  expect(statuses.some(s => s?.startsWith('Live on Dashera: paused (auto mode refused the check; allow '))).toBe(true)
})

test('with two Dashera connectors, uses the one a permission rule allows', async ($, on) => {
  const clock = mock.clock(on)
  const REFUSED = 'mcp__618e79f2-adbe-49a0-a83c-37cbf0b55c46__wake_status'
  const ALLOWED = 'mcp__dashera__wake_status'
  const prompts: string[] = []
  const asked: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  // The refused one is listed first, as after a connector reconnects.
  on('tool.list', () => ({
    value: [
      { name: REFUSED, description: 'Yes or no: is anything new in Dashera' },
      { name: ALLOWED, description: 'Yes or no: is anything new in Dashera' },
    ],
  }))
  on('mcp.call', (_, e) => {
    asked.push(e.server)
    if (e.server !== 'dashera') throw new Error('auto mode classifier gave no verdict')
    const text = JSON.stringify({ pending: true, marker: 'two', pollSeconds: 30 })
    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  on('tool.call', () => {
    const text = 'Error: The server-side auto mode classifier gave no verdict'
    return { result: text, text }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000)
  expect(prompts).toHaveLength(1)
  // Next time it asks the one that answered first.
  asked.length = 0
  await clock.advance(30_000)
  expect(asked[0]).toBe('dashera')
})

test('asks once, through the agent, for the one-tool rule when auto mode blocks the check', async ($, on) => {
  const clock = mock.clock(on)
  const ID_TOOL = 'mcp__618e79f2-adbe-49a0-a83c-37cbf0b55c46__wake_status'
  const prompts: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('tool.list', () => ({
    value: [{ name: ID_TOOL, description: 'is anything new addressed to you in Dashera' }],
  }))
  on('mcp.call', () => {
    throw new Error('The server-side auto mode classifier gave no verdict')
  })
  on('tool.call', { tool: ID_TOOL }, () => {
    const text = 'Error: The server-side auto mode classifier gave no verdict'
    return { result: text, text }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000 + 3 * 30_000)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain(ID_TOOL)
  expect(prompts[0]).toContain('only after they say yes')
})

test("doesn't ask for a rule when the connector itself refuses", async ($, on) => {
  const clock = mock.clock(on)
  const prompts: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('tool.list', () => ({ value: [{ name: TOOL, description: 'Dashera wake' }] }))
  on('mcp.call', () => ({
    value: { content: [{ type: 'text', text: 'Unauthorized' }], isError: true },
  }))
  on('tool.call', { tool: TOOL }, () => ({ isError: true, result: 'Unauthorized', text: 'Unauthorized' }))
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000 + 30_000)
  expect(prompts).toHaveLength(0)
})

test('the first wake-up reads everything; later ones are one line naming where', () => {
  const first = wakePrompt(true, ['Humboldt Gardens'])
  expect(first).toContain('Humboldt Gardens')
  expect(first).toContain('brief: true')
  expect(first).toContain('New activity in Dashera')
  expect(wakePrompt(false, ['Humboldt Gardens'])).toBe('New activity in Dashera: Humboldt Gardens.')
  // An older Dashera that doesn't say where.
  expect(wakePrompt(false)).toBe('New activity in Dashera.')
  expect(wakePrompt(true)).toContain('naming the organization')
})
