import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import {
  COMPACT_REQUEST_PROMPT,
  COMPACT_TIMEOUT_MS,
  POINTER_SHAPE,
  categorySplit,
  firstNoticeAt,
  isCompactRequest,
  noticeDue,
  noticeText,
  parseCheckpointAnswer,
  pointerPrompt,
  reportText,
} from '../hooks/memory'

// Session memory (0.3.10, Dashera Session memory 1): /dashera-compact and
// the owner's words save a checkpoint, the plugin compacts only on a
// confirmed one and only at a turn's end, every compaction advances the
// context epoch once and starts one turn with the fixed pointer only, and
// the context-full notice shows on the status line with no turn.

const D = 'mcp__dashera__'
const CODE = 'S-5A1E00'
const CP = '11111111-2222-4333-8444-555555555555'
const COMP = '99999999-8888-4777-8666-555555555555'
const CARD_TEXT = 'Recalled card text that must never reach a prompt'
type Args = Record<string, unknown>

const confirmed = (extra: Args = {}) =>
  JSON.stringify({
    checkpoint: { id: CP, version: 3 },
    card: { version: 4 },
    compaction: { id: COMP, status: 'pending', checkpointId: CP, by: 'plugin' },
    ...extra,
  })

async function live(
  $: Engine,
  on: On,
  opts: {
    usage?: () => { tokens?: number; window: number; percent?: number }
    compact?: (instructions: string | undefined) => Promise<Record<string, unknown>> | Record<string, unknown>
    resume?: (args: Args) => { text: string; isError?: boolean }
    prefixes?: string[]
  } = {},
) {
  const clock = mock.clock(on)
  const calls: { tool: string; args: Args }[] = []
  const prompts: string[] = []
  const statuses: string[] = []
  const compacts: (string | undefined)[] = []
  const commands: string[] = []
  let checkpointReply: { text: string; isError?: boolean } = { text: confirmed() }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-mem' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: opts.usage?.() ?? { tokens: 500_000, window: 1_000_000, percent: 50 },
      rateLimits: [],
    },
  }))
  on('session.compact', async (_, e) => {
    compacts.push(e.instructions)
    return (await opts.compact?.(e.instructions)) ?? { messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensBefore: 512_000, tokensAfter: 130_000 }
  })
  on('command.register', (_, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.list', () => ({
    value: (opts.prefixes ?? [D]).flatMap(p =>
      ['wake_status', 'check_in', 'checkpoint_work', 'resume_work'].map(n => ({ name: `${p}${n}`, description: 'Dashera', mcp: true })),
    ),
  }))
  on('tool.call', (_, e) => {
    const { tool, tool_use_id: _id, ...args } = e as unknown as Args & { tool: string; tool_use_id?: string }
    if (/__wake_status$/.test(tool)) {
      const text = JSON.stringify({ pending: false, marker: null, session: { code: CODE, name: null }, pollSeconds: 15 })
      return { result: [{ type: 'text', text }], text }
    }
    calls.push({ tool, args })
    const r =
      /__checkpoint_work$/.test(tool)
        ? checkpointReply
        : /__resume_work$/.test(tool)
          ? (opts.resume?.(args) ?? {
              text: JSON.stringify({ session: { code: CODE, contextEpoch: 2 }, delivery: 'full', card: { objective: CARD_TEXT } }),
            })
          : { text: '{"ok":true}' }
    return { result: [{ type: 'text', text: r.text }], text: r.text, ...(r.isError ? { isError: true } : {}) }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.status', (_, e) => {
    statuses.push(String((e as { text?: string }).text))
    return { value: undefined }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('classic.SessionStart', () => ({}))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(6_000)
  return {
    clock,
    calls,
    prompts,
    statuses,
    compacts,
    commands,
    reply: (r: { text: string; isError?: boolean }) => {
      checkpointReply = r
    },
  }
}

const done = (turnId: string) => ({ answer: 'done', durationMs: 1000, isAborted: false, turnId, reason: 'answer' as const })
const resumes = (calls: { tool: string; args: Args }[]) => calls.filter(c => c.tool === `${D}resume_work`).map(c => c.args)
const owner = { kind: 'composer' } as const

/** A turn the person starts by typing, in which the model saves with compactAfter. */
async function ownerSaves($: Engine, r: Awaited<ReturnType<typeof live>>, turnId: string) {
  await $.prompt.submit({ text: 'save your context to Dashera and compact', origin: owner } as never)
  await $.turn.start({ text: 'save your context to Dashera and compact', turnId })
  await $.tool.call({ tool: `${D}checkpoint_work`, compactAfter: true, operationKey: `op-${turnId}`, expectedVersion: 2 } as never)
  await $.turn.complete(done(turnId))
  await r.clock.advance(5_000)
}

test('the pointer is fixed: only the code and the epoch vary', () => {
  expect(pointerPrompt(CODE, 7)).toBe('You are S-5A1E00, context 7. Call resume_work.')
  expect(pointerPrompt(CODE, 7)).toMatch(POINTER_SHAPE)
  expect(pointerPrompt(CODE, null)).toMatch(POINTER_SHAPE)
})

test('reads only ids, version and status from a checkpoint answer', () => {
  expect(parseCheckpointAnswer(`<dashera_data>\n${confirmed()}\n</dashera_data>`)).toEqual({
    checkpointId: CP,
    version: 3,
    compactionId: COMP,
    compactionStatus: 'pending',
    noop: false,
  })
  expect(parseCheckpointAnswer('{"error":"stale_version"}')).toBeNull()
  expect(parseCheckpointAnswer(undefined)).toBeNull()
})

test('the notice rule: 300K or 70% of the window, 150K above the compaction, then every 100K', () => {
  // 130K after a compaction: first at 300K.
  expect(firstNoticeAt(130_000, 1_000_000)).toBe(300_000)
  // 200K after: first at 350K (the floor above the compaction).
  expect(firstNoticeAt(200_000, 1_000_000)).toBe(350_000)
  // A small window: 70% comes first; the floor above the compaction still holds.
  expect(firstNoticeAt(null, 200_000)).toBe(140_000)
  expect(firstNoticeAt(100_000, 200_000)).toBe(250_000)
  expect(noticeDue(299_999, 1_000_000, 130_000, null)).toBe(false)
  expect(noticeDue(300_000, 1_000_000, 130_000, null)).toBe(true)
  expect(noticeDue(399_999, 1_000_000, 130_000, 300_000)).toBe(false)
  expect(noticeDue(400_000, 1_000_000, 130_000, 300_000)).toBe(true)
  expect(noticeDue(null, 1_000_000, null, null)).toBe(false)
})

test('the report says unknown for what the runtime does not split', () => {
  const split = categorySplit({
    categories: [
      { name: 'System prompt', tokens: 3_000 },
      { name: 'Messages', tokens: 90_000 },
    ],
  })
  expect(split).toEqual([
    { label: 'System prompt', tokens: 3_000 },
    { label: 'System tools', tokens: 'unknown' },
    { label: 'MCP tools', tokens: 'unknown' },
    { label: 'Memory files', tokens: 'unknown' },
    { label: 'Skills', tokens: 'unknown' },
    { label: 'Messages (summary plus retained history)', tokens: 90_000 },
  ])
  const text = reportText({
    code: CODE,
    epoch: 2,
    source: 'dashera-compact',
    before: 512_000,
    after: 130_000,
    window: 1_000_000,
    split,
    dashera: { playbookAndRules: 9_000, playbook: 'unknown', card: 1_200 },
    samples: [134_000, 140_000],
  })
  expect(text).toContain('Before: 512,000 tokens. Right after: 130,000 tokens.')
  expect(text).toContain('System tools: unknown')
  expect(text).toContain('playbook (get_playbook) unknown')
  expect(text).toContain('Growth after: 5,000 tokens per turn over 2 turns')
})

test('/dashera-compact: saves, compacts once at the turn end, advances the epoch, then only the pointer', async ($, on) => {
  const r = await live($, on)
  expect(r.commands).toContain('dashera-compact')
  const out = await $.command.run({ command: 'dashera-compact', args: '', origin: owner } as never)
  expect((out as { text?: string }).text).toMatch(/Saving this session to Dashera/)
  await r.clock.advance(1_000)
  expect(r.prompts).toEqual([COMPACT_REQUEST_PROMPT])
  // The turn the command started (the plugin's prompt) is the owner's.
  await $.turn.start({ text: COMPACT_REQUEST_PROMPT, turnId: 'c1' })
  await $.tool.call({ tool: `${D}checkpoint_work`, compactAfter: true, operationKey: 'op-1', expectedVersion: 2 } as never)
  // The session filled its own code on the write.
  expect(r.calls.find(c => c.tool === `${D}checkpoint_work`)!.args.session).toBe(CODE)
  expect(r.compacts).toEqual([])
  await $.turn.complete(done('c1'))
  await r.clock.advance(2_000)
  expect(r.compacts).toHaveLength(1)
  expect(r.compacts[0]).toContain(CP)
  expect(r.compacts[0]).toContain('Keep this summary short')
  const [report] = resumes(r.calls)
  expect(report).toMatchObject({
    session: CODE,
    newContext: true,
    contextTokens: 130_000,
    compaction: { id: COMP, status: 'done', tokensBefore: 512_000, tokensAfter: 130_000 },
  })
  expect(typeof report!.contextOperation).toBe('string')
  // Exactly one more prompt: the fixed pointer, nothing recalled.
  expect(r.prompts.slice(1)).toEqual(['You are S-5A1E00, context 2. Call resume_work.'])
  expect(r.prompts.join('\n')).not.toContain(CARD_TEXT)

  // A repeat while it is done or pending compacts nothing more.
  r.reply({ text: confirmed({ noop: true, checkpoint: undefined }) })
  await $.turn.start({ text: 'again', turnId: 'c2' })
  await $.tool.call({ tool: `${D}checkpoint_work`, compactAfter: true, operationKey: 'op-2', expectedVersion: 3 } as never)
  await $.turn.complete(done('c2'))
  await r.clock.advance(2_000)
  expect(r.compacts).toHaveLength(1)
  const report2 = await $.command.run({ command: 'dashera-compact', args: 'report', origin: owner } as never)
  expect((report2 as { text?: string }).text).toContain('Before: 512,000 tokens. Right after: 130,000 tokens.')
})

test("the owner's own words compact the same way", async ($, on) => {
  const r = await live($, on)
  await ownerSaves($, r, 'w1')
  expect(r.compacts).toHaveLength(1)
  expect(r.prompts.at(-1)).toMatch(POINTER_SHAPE)
})

test('a forced save failure does not compact', async ($, on) => {
  const r = await live($, on)
  r.reply({ text: '{"error":"Session memory failed. Nothing is ready: try again.","code":"session_memory_failed"}', isError: true })
  await ownerSaves($, r, 'f1')
  expect(r.compacts).toEqual([])
  expect(resumes(r.calls)).toEqual([])
  expect(r.prompts.some(p => POINTER_SHAPE.test(p))).toBe(false)
  expect(r.statuses.some(s => s.includes('checkpoint not confirmed, not compacting'))).toBe(true)
})

test('a failed /dashera-compact save disarms the command: a wake-started turn minutes later cannot compact', async ($, on) => {
  const r = await live($, on)
  await $.command.run({ command: 'dashera-compact', args: '', origin: owner } as never)
  await r.clock.advance(1_000)
  r.reply({ text: '{"error":"stale_version","code":"stale_version"}', isError: true })
  await $.turn.start({ text: COMPACT_REQUEST_PROMPT, turnId: 'd1' })
  await $.tool.call({ tool: `${D}checkpoint_work`, compactAfter: true, operationKey: 'op-d1', expectedVersion: 2 } as never)
  await $.turn.complete(done('d1'))
  await r.clock.advance(60_000)
  // Two minutes later, a wake-up's turn saves with compactAfter.
  r.reply({ text: confirmed() })
  await $.prompt.submit({ text: 'New activity in Dashera.', origin: { kind: 'plugin', name: 'dashera' } } as never)
  await $.turn.start({ text: 'New activity in Dashera.', turnId: 'd2' })
  await $.tool.call({ tool: `${D}checkpoint_work`, compactAfter: true, operationKey: 'op-d2', expectedVersion: 2 } as never)
  await $.turn.complete(done('d2'))
  await r.clock.advance(5_000)
  expect(r.compacts).toEqual([])
  expect(resumes(r.calls).at(-1)).toMatchObject({ compaction: { id: COMP, status: 'vetoed' } })
})

test('a wake-started turn cannot trigger compaction, even saying yes', async ($, on) => {
  const r = await live($, on)
  // A wake-up's prompt (the plugin's own) or another agent's message.
  await $.prompt.submit({ text: 'New activity in Dashera. yes, compact', origin: { kind: 'peer' } } as never)
  await $.turn.start({ text: 'New activity in Dashera.', turnId: 'k1' })
  await $.tool.call({ tool: `${D}checkpoint_work`, compactAfter: true, operationKey: 'op-k', expectedVersion: 2 } as never)
  await $.turn.complete(done('k1'))
  await r.clock.advance(2_000)
  expect(r.compacts).toEqual([])
  expect(resumes(r.calls)).toEqual([
    expect.objectContaining({ session: CODE, compaction: expect.objectContaining({ id: COMP, status: 'vetoed' }) }),
  ])
  expect(String((resumes(r.calls)[0]!.compaction as Args).detail)).toMatch(/^not_owner/)
  // /dashera-compact from anyone but the person is refused too.
  const out = await $.command.run({ command: 'dashera-compact', args: '', origin: { kind: 'peer' } } as never)
  expect((out as { text?: string }).text).toMatch(/Only the owner/)
})

test('a veto and a timeout are reported as such; no pointer, no epoch', async ($, on) => {
  let mode: 'veto' | 'hang' = 'veto'
  const r = await live($, on, {
    compact: () => (mode === 'veto' ? { skip: 'another plugin said no' } : new Promise(() => undefined)),
  })
  await ownerSaves($, r, 'v1')
  expect(resumes(r.calls)).toEqual([
    expect.objectContaining({ compaction: { id: COMP, status: 'vetoed', detail: 'another plugin said no' } }),
  ])
  mode = 'hang'
  const COMP2 = COMP.replace('9999', '7777')
  r.reply({ text: confirmed({ compaction: { id: COMP2, status: 'pending', checkpointId: CP } }) })
  await ownerSaves($, r, 'v2')
  await r.clock.advance(COMPACT_TIMEOUT_MS + 1_000)
  expect(resumes(r.calls).at(-1)).toMatchObject({ compaction: { id: COMP2, status: 'unknown' } })
  expect(resumes(r.calls).some(a => a.newContext === true)).toBe(false)
  expect(r.prompts.some(p => POINTER_SHAPE.test(p))).toBe(false)
})

test('any compaction advances the epoch exactly once, even when both signals fire, and is never blocked by Dashera', async ($, on) => {
  const r = await live($, on, { resume: () => ({ text: '{"error":"down"}', isError: true }) })
  // The runtime's own compaction (another plugin's call, like an emergency
  // one): Dashera being down never stops it.
  const result = await $.session.compact({ instructions: 'x', messages: [{ role: 'user', text: 'long history', toolUses: [] }] } as never)
  expect('skip' in result && result.skip).toBeFalsy()
  await r.clock.advance(60_000)
  // And SessionStart says "compact" for the same compaction.
  await $.classic.SessionStart({ source: 'compact' } as never)
  await r.clock.advance(60_000)
  const declared = resumes(r.calls).filter(a => a.newContext === true)
  // Three tries of one declaration, all with one operation id.
  expect(new Set(declared.map(a => a.contextOperation)).size).toBe(1)
  expect(r.prompts.filter(p => POINTER_SHAPE.test(p))).toEqual(['You are S-5A1E00, context new. Call resume_work.'])
})

test('only SessionStart "compact" (no hook): the epoch still advances once', async ($, on) => {
  const r = await live($, on)
  await $.classic.SessionStart({ source: 'compact' } as never)
  await r.clock.advance(5_000)
  expect(resumes(r.calls).filter(a => a.newContext === true)).toHaveLength(1)
  expect(r.prompts.filter(p => POINTER_SHAPE.test(p))).toEqual(['You are S-5A1E00, context 2. Call resume_work.'])
})

test('the notice: on the status line at the threshold with no turn, once per band, measured from after the compaction', async ($, on) => {
  let tokens = 250_000
  const r = await live($, on, { usage: () => ({ tokens, window: 1_000_000, percent: Math.round(tokens / 10_000) }) })
  const turn = async (id: string) => {
    await $.turn.start({ text: 'work', turnId: id })
    await $.turn.complete(done(id))
    await r.clock.advance(2_000)
  }
  const notices = () => r.statuses.filter(s => s.includes('Say "compact this session" to back up to Dashera and compress.'))
  const promptsBefore = r.prompts.length
  await turn('n1')
  expect(notices()).toEqual([])
  tokens = 310_000
  await turn('n2')
  expect(notices().at(-1)).toContain('Context 310K (31%).')
  const shownAt = notices().length
  tokens = 390_000
  await turn('n3')
  expect(notices().filter(s => s.includes('390K'))).toEqual([])
  expect(notices().length).toBeGreaterThanOrEqual(shownAt)
  // No turn was ever started for it.
  expect(r.prompts.length).toBe(promptsBefore)
  // A compaction that lands at 130K: nothing at 200K, the first at 300K.
  await $.session.compact({ instructions: 'x', messages: [{ role: 'user', text: 'long history', toolUses: [] }] } as never)
  await r.clock.advance(5_000)
  tokens = 200_000
  await turn('n4')
  expect(notices().filter(s => s.includes('200K'))).toEqual([])
  tokens = 300_000
  await turn('n5')
  expect(notices().at(-1)).toContain('Context 300K (30%).')
})

// ---- Release 2e live test (24 Nov 2026): the save went through a second
// Dashera connector and nothing compacted; 1c779860 sat at pending. ----

const APP = 'mcp__618e79f2-adbe-49a0-a83c-37cbf0b55c46__'

test('a save through the other Dashera connector arms and compacts, and reports through that connector', async ($, on) => {
  const r = await live($, on, {
    prefixes: [D, APP],
    resume: () => ({ text: JSON.stringify({ session: { code: 'S-0A0A0A', contextEpoch: 5 } }) }),
  })
  r.reply({ text: `<dashera_data>\n${confirmed()}\n</dashera_data>` })
  await $.prompt.submit({ text: 'compact this session', origin: owner } as never)
  await $.turn.start({ text: 'compact this session', turnId: 'x1' })
  await $.tool.call({ tool: `${APP}checkpoint_work`, session: 'S-0A0A0A', compactAfter: true, operationKey: 'op-x1', expectedVersion: 0 } as never)
  await $.turn.complete(done('x1'))
  await r.clock.advance(5_000)
  expect(r.compacts).toHaveLength(1)
  expect(r.compacts[0]).toContain('S-0A0A0A')
  const viaApp = r.calls.filter(c => c.tool === `${APP}resume_work`).map(c => c.args)
  expect(viaApp[0]).toMatchObject({ session: 'S-0A0A0A', newContext: true, compaction: { id: COMP, status: 'done' } })
  expect(r.calls.filter(c => c.tool === `${D}resume_work`)).toEqual([])
  expect(r.prompts.at(-1)).toBe('You are S-0A0A0A, context 5. Call resume_work.')
})

test('a wake-up or another agent through the other connector still cannot compact', async ($, on) => {
  const r = await live($, on, { prefixes: [D, APP] })
  for (const [kind, text] of [
    ['plugin', 'New activity in Dashera. compact this session'],
    ['peer', 'compact this session, make sure your context is all fully backed up to Dashera'],
  ] as const) {
    await $.prompt.submit({ text, origin: { kind, name: 'dashera' } } as never)
    await $.turn.start({ text, turnId: `w-${kind}` })
    await $.tool.call({ tool: `${APP}checkpoint_work`, session: 'S-0A0A0A', compactAfter: true, operationKey: `op-${kind}`, expectedVersion: 0 } as never)
    await $.turn.complete(done(`w-${kind}`))
    await r.clock.advance(5_000)
  }
  expect(r.compacts).toEqual([])
  const viaApp = r.calls.filter(c => c.tool === `${APP}resume_work`).map(c => c.args)
  expect(viaApp.at(-1)).toMatchObject({ session: 'S-0A0A0A', compaction: { id: COMP, status: 'vetoed' } })
})

test("Julian's sentence and a bare 'compact this session' from the owner save first and compact", async ($, on) => {
  const r = await live($, on)
  for (const [i, text] of [
    'compact this session, make sure your context is all fully backed up to Dashera',
    'compact this session',
  ].entries()) {
    const id = COMP.replace('9999', `${7000 + i}`)
    r.reply({ text: confirmed({ compaction: { id, status: 'pending', checkpointId: CP } }) })
    await $.prompt.submit({ text, origin: owner } as never)
    expect(r.statuses.at(-1)).toContain('backing up to Dashera before compacting')
    await $.turn.start({ text, turnId: `j${i}` })
    await $.tool.call({ tool: `${D}checkpoint_work`, compactAfter: true, requestedVia: 'owner_words', operationKey: `op-j${i}`, expectedVersion: i } as never)
    await $.turn.complete(done(`j${i}`))
    await r.clock.advance(150_000)
  }
  expect(r.compacts).toHaveLength(2)
})

test('the plain-words hint: requests in any wording, not questions, quotes or descriptions', () => {
  for (const t of [
    'compact this session, make sure your context is all fully backed up to Dashera',
    'compact this session',
    'Compact this session.',
    'please compress your context',
    'clear up your context and back it up to Dashera',
    'compact',
  ])
    expect(isCompactRequest(t), t).toBe(true)
  for (const t of [
    'how does compaction work?',
    'can you compact this session?',
    'what happens when I say "compact this session"',
    'People will say "compact this session" to back up their work.',
    'when owners type compact this session, they get a checkpoint first.',
    'thanks, that looks good',
  ])
    expect(isCompactRequest(t), t).toBe(false)
  expect(noticeText(412_000, 41)).toBe('Context 412K (41%). Say "compact this session" to back up to Dashera and compress.')
})

test('a pending compaction this copy never armed is reported failed (never_armed), said plainly, never left pending', async ($, on) => {
  const r = await live($, on)
  r.reply({ text: confirmed({ noop: true, checkpoint: undefined }) })
  await ownerSaves($, r, 'n1')
  expect(r.compacts).toEqual([])
  expect(resumes(r.calls)).toEqual([expect.objectContaining({ compaction: { id: COMP, status: 'failed', detail: 'never_armed' } })])
  expect(r.statuses.some(s => s.includes('an earlier compaction never ran; it is cleared, ask again'))).toBe(true)
})

test('compaction refused at every turn end: failed after the tries, said plainly, never left pending', async ($, on) => {
  const r = await live($, on, {
    compact: () => {
      throw new Error('a turn is running')
    },
  })
  await ownerSaves($, r, 'r1')
  for (let i = 2; i <= 3; i++) {
    await $.turn.start({ text: 'more', turnId: `r${i}` })
    await $.turn.complete(done(`r${i}`))
    await r.clock.advance(5_000)
  }
  expect(resumes(r.calls).at(-1)).toMatchObject({ compaction: { id: COMP, status: 'failed' } })
  expect(r.statuses.some(s => s.includes('compaction was refused; checkpoint saved'))).toBe(true)
})
