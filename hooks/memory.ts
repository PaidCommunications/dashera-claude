// Session memory (0.3.10, Dashera Session memory 1, 23 Nov 2026;
// docs/design/session-memory-1.md in Dashera).
//
// /dashera-compact, or the owner's own words: the session saves a checkpoint
// to Dashera (checkpoint_work with compactAfter). Only when Dashera confirms
// it (a checkpoint id and version, and a pending compaction) does this
// plugin compact the conversation, and only when the main loop's turn ends
// ($.session.compact rejects during a turn; it is never forced). A veto or a
// failure is reported to Dashera as it is, and a compaction that doesn't
// answer within COMPACT_TIMEOUT_MS is reported as unknown, never as done.
//
// After any compaction of the main conversation (this plugin's, the owner's
// /compact, or the runtime's automatic one: the session.compact hook after
// next(e) resolves, or, where that hook doesn't fire, SessionStart with
// source "compact"), the context epoch advances once in Dashera, with an
// operation id, and one turn starts with the fixed pointer only: "You are
// S-XXXXXX, context N. Call resume_work." No recalled text ever goes
// through a hook: the card and checkpoint come back through resume_work,
// fenced as data. The hook never vetoes and never waits on Dashera, so
// memory work never blocks an emergency compaction.
//
// Who may start it: the owner. /dashera-compact typed by the person, or a
// checkpoint_work with compactAfter in a main-loop turn the person started
// (a prompt typed at the composer or sent through Remote Control). A turn a
// wake-up started (another agent, a task or a comment), a peer's message, a
// subagent or anything else can't, even with text that says yes: the plugin
// reports such a compaction vetoed (not_owner).
//
// The context-full notice: at each idle turn end the plugin reads the real
// size ($.session.usage()). The status line says so, with no turn started,
// when it reaches the threshold (300K tokens or 70% of the window, whichever
// comes first, and at least 150K above the size right after this context's
// compaction), once per context and again only after 100K more growth.

/** The fixed pointer that starts the turn after a compaction. Nothing else varies. */
export function pointerPrompt(code: string, epoch: number | null): string {
  return `You are ${code}, context ${epoch ?? 'new'}. Call resume_work.`
}
export const POINTER_SHAPE = /^You are S-[0-9A-F]{6}, context (\d+|new)\. Call resume_work\.$/

/** What /dashera-compact asks the session to do (fixed text, no data). */
export const COMPACT_REQUEST_PROMPT =
  'Your owner ran /dashera-compact. Save your context to Dashera: load the memory toolset if it is not listed, call checkpoint_work with your session code, a new operationKey, expectedVersion (your latest checkpoint version, 0 for none), your objective, constraints, decisions, completed work, evidence, failed approaches, blockers and next action, and compactAfter: true with requestedVia "command". Then end your turn. If Dashera does not confirm a checkpoint id and version, say what failed and do not compact.'

/** The compaction's own instructions: short, naming the checkpoint by id. */
export function compactInstructions(code: string, checkpointId: string, version: number): string {
  return `Keep this summary short. Dashera checkpoint ${checkpointId} (version ${version}) holds this session's state: objective, constraints, decisions, evidence, failed approaches and the next action. Keep the session code ${code}, that checkpoint id, and that the first step after this is resume_work. Leave out detail the checkpoint holds.`
}

/** A compaction that doesn't answer within this is reported as unknown. */
export const COMPACT_TIMEOUT_MS = 10 * 60_000
/** A compaction rejected because a turn ran is tried again at most this many turn ends. */
export const COMPACT_TRIES = 3
/** The two compaction signals within this of each other are one compaction. */
export const EPOCH_DEDUPE_MS = 2 * 60_000
/** How many turns after a compaction the growth report samples. */
export const GROWTH_TURNS = 5

// The context-full notice (each a beta setting, the same as Dashera's).
export const NOTICE_TOKENS = 300_000
export const NOTICE_PERCENT = 70
export const NOTICE_ABOVE_COMPACTION = 150_000
export const NOTICE_BAND = 100_000

/**
 * Where this context's first notice comes: the threshold (300K or 70% of
 * the window, whichever is lower) but never under 150K above the size right
 * after its compaction.
 */
export function firstNoticeAt(baseline: number | null, window: number | null): number {
  const pct = window && window > 0 ? Math.floor((window * NOTICE_PERCENT) / 100) : Number.POSITIVE_INFINITY
  return Math.max(Math.min(NOTICE_TOKENS, pct), baseline !== null ? baseline + NOTICE_ABOVE_COMPACTION : 0)
}

/** Whether the notice is due: past the first notice's mark and the last notice's band. */
export function noticeDue(tokens: number | null, window: number | null, baseline: number | null, last: number | null): boolean {
  if (tokens === null) return false
  if (tokens < firstNoticeAt(baseline, window)) return false
  return last === null || tokens >= last + NOTICE_BAND
}

/** The status line's notice. */
export function noticeText(tokens: number, percent: number | null): string {
  const k = Math.round(tokens / 1000)
  return `Context ${k}K${percent !== null ? ` (${percent}%)` : ''}. Say "compact this session" to back up to Dashera and compress.`
}

/** A prompt's origin the plugin counts as the owner's own typed message. */
export function isOwnerOrigin(origin: unknown): boolean {
  const kind = (origin as { kind?: unknown } | null)?.kind
  return kind === 'composer' || kind === 'bridge'
}

/** What a confirmed checkpoint_work answer says, or null when it confirmed nothing. */
export type CheckpointConfirm = {
  checkpointId: string | null
  version: number | null
  compactionId: string | null
  compactionStatus: string | null
  noop: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Reads only the ids, version and status of a checkpoint_work answer (the
 * JSON inside its data fence). Never any text of the checkpoint.
 */
export function parseCheckpointAnswer(text: string | undefined): CheckpointConfirm | null {
  if (!text) return null
  // The answer inside Dashera's data fence when there is one.
  const fenced = /<dashera_data>\s*([\s\S]*?)\s*<\/dashera_data>/.exec(text)
  if (fenced) text = fenced[1]!
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let a: Record<string, unknown>
  try {
    a = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
  const cp = (a.checkpoint ?? null) as { id?: unknown; version?: unknown } | null
  const comp = (a.compaction ?? null) as { id?: unknown; status?: unknown; checkpointId?: unknown } | null
  const checkpointId = typeof cp?.id === 'string' && UUID.test(cp.id) ? cp.id : typeof comp?.checkpointId === 'string' && UUID.test(comp.checkpointId) ? comp.checkpointId : null
  const version = typeof cp?.version === 'number' && Number.isInteger(cp.version) ? cp.version : null
  const compactionId = typeof comp?.id === 'string' && UUID.test(comp.id) ? comp.id : null
  const compactionStatus = typeof comp?.status === 'string' && /^[a-z_]{1,20}$/.test(comp.status) ? comp.status : null
  if (!checkpointId && !compactionId) return null
  return { checkpointId, version, compactionId, compactionStatus, noop: a.noop === true }
}

/** The epoch in a resume_work answer, or null. Nothing else is read. */
export function parseEpoch(text: string | undefined): number | null {
  if (!text) return null
  const m = /"contextEpoch"\s*:\s*(\d{1,6})/.exec(text)
  return m ? Number(m[1]) : null
}

/** The runtime's own categories, as the report names them. */
export const REPORT_CATEGORIES: readonly { label: string; match: RegExp }[] = [
  { label: 'System prompt', match: /^system prompt$/i },
  { label: 'System tools', match: /^system tools$/i },
  { label: 'MCP tools', match: /^mcp tools$/i },
  { label: 'Memory files', match: /^memory files$/i },
  { label: 'Skills', match: /^skills$/i },
  { label: 'Messages (summary plus retained history)', match: /^messages$/i },
]

type Breakdown = { categories?: readonly { name: string; tokens: number }[] } | undefined

/** Each category's tokens as the runtime measured them, or "unknown". */
export function categorySplit(b: Breakdown): { label: string; tokens: number | 'unknown' }[] {
  return REPORT_CATEGORIES.map(c => {
    const hit = b?.categories?.find(x => c.match.test(x.name.trim()))
    return { label: c.label, tokens: hit && Number.isFinite(hit.tokens) ? hit.tokens : 'unknown' }
  })
}

export type CompactionReport = {
  code: string | null
  epoch: number | null
  source: string
  before: number | 'unknown'
  after: number | 'unknown'
  window: number | 'unknown'
  split: { label: string; tokens: number | 'unknown' }[]
  /** Characters of Dashera's own answers in the new context, by part. */
  dashera: { playbookAndRules: number | 'unknown'; playbook: number | 'unknown'; card: number | 'unknown' }
  /** The size at each idle turn end after the compaction. */
  samples: number[]
}

const fmt = (n: number | 'unknown') => (n === 'unknown' ? 'unknown' : n.toLocaleString('en-US'))

/** The report /dashera-compact report prints. Measured numbers only; the rest says unknown. */
export function reportText(r: CompactionReport | null): string {
  if (!r) return 'No compaction in this conversation yet.'
  const lines = [
    `Compaction report: ${r.code ?? 'no session'}, context ${r.epoch ?? 'unknown'} (${r.source}).`,
    `Before: ${fmt(r.before)} tokens. Right after: ${fmt(r.after)} tokens. Window: ${fmt(r.window)}.`,
    'Right after, by the runtime\'s own categories (tokens):',
    ...r.split.map(s => `  ${s.label}: ${fmt(s.tokens)}`),
    `Dashera's own answers in the new context (characters, not tokens): playbook and rules (check_in) ${fmt(r.dashera.playbookAndRules)}, playbook (get_playbook) ${fmt(r.dashera.playbook)}, card (resume_work) ${fmt(r.dashera.card)}.`,
  ]
  const steps = r.samples.slice(0, GROWTH_TURNS + 1)
  if (typeof r.after === 'number' && steps.length > 0) {
    const last = steps[steps.length - 1]!
    const perTurn = Math.round((last - r.after) / steps.length)
    lines.push(`Growth after: ${fmt(perTurn)} tokens per turn over ${steps.length} turn${steps.length === 1 ? '' : 's'} (sizes: ${steps.map(fmt).join(', ')}).`)
  } else {
    lines.push('Growth after: unknown (no turn measured since).')
  }
  return lines.join('\n')
}


/**
 * Whether an owner's typed message asks to compact this session, in any
 * wording (Julian, 24 Nov 2026): "compact this session, make sure your
 * context is all fully backed up to Dashera", a bare "compact this
 * session", "compress your context", "clear up your context". Not a
 * question about compaction, not a quoted phrase, not a description of how
 * people will use it. Only a hint for the status line: the session decides,
 * and asks once when it's unclear; only the owner's own turn can compact.
 */
export function isCompactRequest(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  // A question, or the phrase quoted or described, is not a request.
  if (/\?\s*$/.test(t)) return false
  if (/["“”'‘’`][^"“”'‘’`]*\b(compact|compress)\b[^"“”'‘’`]*["“”'‘’`]/i.test(t)) return false
  if (/\b(how|what|when|why|whether|if)\b[^.]*\b(compact|compress)/i.test(t)) return false
  if (/\b(people|users|owners|they|someone|anyone)\b[^.]*\b(will|would|can|could|might)\b[^.]*\b(say|type|ask|use)\b/i.test(t)) return false
  return /\b(compact|compress|clear up|clean up)\b[^.]*\b(this session|the session|your context|this context|context|session|yourself)\b/i.test(t) ||
    /^(please\s+)?(compact|compress)( now| it| yourself)?[.!]*$/i.test(t)
}
