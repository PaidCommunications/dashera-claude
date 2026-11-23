import type { Register, Timer } from 'claude-code'
import type { LiveCopyLease } from '../types'
import { PLUGIN_VERSION } from './version'
import {
  COMPACT_REQUEST_PROMPT,
  COMPACT_TIMEOUT_MS,
  COMPACT_TRIES,
  EPOCH_DEDUPE_MS,
  GROWTH_TURNS,
  type CompactionReport,
  categorySplit,
  compactInstructions,
  isOwnerOrigin,
  noticeDue,
  noticeText,
  parseCheckpointAnswer,
  parseEpoch,
  pointerPrompt,
  reportText,
} from './memory'

// Dashera wake-ups (1 Nov 2026). Every 15 seconds (30 until 5 Nov 2026), between turns, ask the
// Dashera connector's wake_status tool "is anything new waiting for me?".
// It answers yes/no and an opaque marker, nothing else. When the answer is
// yes with a marker not seen before, start one turn with the fixed prompt
// below. The check is a plain tool call outside any model turn, so waiting
// costs no AI tokens; only the turn it starts does.
//
// Version and end (0.2.15, Julian, 7 Nov 2026): every check sends the
// plugin's own version (`version`, the same field the Codex watcher uses),
// and a conversation whose live session was ended stops checking until its
// next prompt (the connect prompt brings it back).
//
// Session continuity (0.3.0, Julian, 8 Nov 2026): a conversation can go on
// under a new Claude Code session id (a resume, the Claude app restarting;
// the engine says so itself: "after a /clear or a resume the process goes on
// under another" id, and no session.start fires for it). The plugin read
// the id once, at session.start, and kept checking under the stale one, so
// Dashera saw a new, unconnected conversation and let the connected session
// lapse. Now every check reads the id again, and when it changed the check
// names the id this conversation last checked in under while connected
// (previousSessionId): Dashera keeps it the same live session, with its
// code, name and assignments. A /clear starts a new conversation: nothing
// is carried over.
//
// One conversation, one session (0.3.1, B16, 9 Nov 2026): 0.3.0 also kept
// the last connected id per folder and had a conversation resumed in a new
// process name it. Several conversations share a folder (the Mac Studio's
// "Humboldt Gardens Operations" holds Dashera Builder, CRM, Milo Games and
// more), so a resumed conversation could name another one's id and take
// its session. Now the store keeps connected conversation ids, never
// folders, and a resumed conversation names a previous id only when its
// own transcript shows it continues that conversation. Each copy of the
// plugin also names itself (instance), so when two copies check in for one
// conversation (an old copy for a while after the plugin updates) Dashera
// wakes only the newest.
//
// One wake-up per burst (0.3.2, 11 Nov 2026): the first new item starts a
// 20-second wait and the whole burst gets one wake-up, with a fixed prompt
// (it carried organization names until 0.3.4). Only what addresses this
// session counts; Dashera leaves quiet posts out of the answer.
//
// Wake-ups that arrive (0.3.3, 12 Nov 2026): a mention woke a busy session
// 23 minutes late once and never another time (it was found 3h44m later).
// 0.3.2 counted a wake as delivered the moment it asked for the prompt, and
// ignored the answer: a submit the engine dropped, or one lost while the
// session was in the middle of a turn, used up that item and nothing raised
// it again. Now a wake is delivered only when its prompt enters; it waits
// while the session runs a turn of its own and goes at the first idle check
// after it (a turn that never reports its end holds it at most
// STUCK_TURN_MS); and a burst gets its wake-up at most WAKE_MAX_WAIT_MS after
// its first new item, however much keeps arriving (the 2-minute gap is now
// 30 seconds).
//
// Stand-down and the not-connected note (0.3.5, HG task 17215051, 12 Nov
// 2026). Two copies of the plugin in one conversation (the installed plugin
// and a session mod of it, or an old copy for a while after an update) both
// checked for it. Dashera wakes only one of them (the keeper) and now tells
// the other `standDown: true`: that copy stops its checks, says so once on
// the status line, and asks once every STAND_DOWN_RECHECK_MS in case the
// keeper went away (alone again, it goes back to checking as usual). And a
// conversation the plugin checks from that isn't connected only said so on
// the status line, which the agent never sees: once the agent has called a
// connect tool here itself (wake_status, name_my_session, live_session), a
// still-unconnected answer is put to it once per conversation as a short
// descriptive note with the plugin's own session code. Conversations nobody
// tries to connect never get a turn from it.
//
// Turn report (0.3.6, Who gets it receipts, 12 Nov 2026): Dashera shows
// "Working…" on a session while it runs a turn and "Delivered" once a
// wake-up's turn started, and it can only know either from here. The checks
// already running carry it, never a request of their own: while a main-loop
// turn runs (the person's or a wake-up's) each check sends turnStartedAt, the
// turn's start (Dashera counts a turn over after 90 s without a report), and
// the first check after it ends sends "none". The check after a wake-up's
// prompt entered sends its marker as deliveredMarker, once. Both go only to a
// Dashera whose wake_status takes them (its tool list says so), and a copy
// that stands down sends neither.
//
// Activity (0.3.7, Julian, 13 Nov 2026): Dashera's "Thinking…" bubble shows
// what the agent is doing, privacy first. While a main-loop turn runs, the
// plugin keeps the KIND of the latest tool call as one fixed label
// (ACTIVITY_LABELS: "Reading files", "Editing code", ...) and the time of
// that call. The same checks carry it as `activity` and `activityAt`, beside
// turnStartedAt, never a request of their own. Only the label is kept and
// sent: never the tool's name, inputs, file names, commands, URLs or
// content. It clears when the turn ends, goes only to a Dashera whose
// wake_status takes it, and a copy that stands down sends none.

// One live copy per conversation (0.3.8, 16 Nov 2026): a conversation on
// the Mac Studio got no wake-up from 12 Nov on. Dashera saw two copies
// checking in for it (doubledSameConversation) from one Claude process and
// told one to stand down; the copy it kept never started a turn. Nothing
// here ever stopped a copy: session.start started a 15-second interval and
// never cancelled it, a second session.start in the same load started a
// second one, and no copy knew of another. Two layers now:
// 1. A lease in $.state (session-scoped, dashera.liveCopy). Before every
//    check a copy reads it; while another copy's lease is renewed under
//    LEASE_FRESH_MS ago this copy never calls wake_status, says "another copy
//    is active", and takes over only once the lease is over LEASE_STALE_MS
//    old. The holder renews it on every tick. Copies that come up together:
//    the earlier startedAt wins, then the lower instance id. One interval
//    per load, cancelled at session.end.
// 2. Proof it can deliver: every prompt submit's result (entered, dropped,
//    queued) shows on the status line for SUBMIT_SHOWN_MS and goes with the
//    next check as deliveryResult; DROPS_BROKEN drops in a row give up the
//    lease and report deliveryBroken, so another copy, or the owner's alert,
//    takes over.

// Session on writes (0.3.9, 23 Nov 2026, Dashera Release 2b): every write
// tool takes `session`, the caller's own live session code; with two or
// more live sessions a write that carries only the connection's remembered
// code is saved without session credit and answers sessionWarning
// (name_your_session), and a Build Room seat action answers 409. The
// tool.call hook fills this conversation's code on the listed write tools
// (SESSION_WRITE_TOOLS) of the connector whose check gave it, while it is
// connected, when the call leaves session out. Never on reads, other
// servers, a session the model passed, or writes whose session names
// another session (NEVER_FILL). A sessionWarning in a Dashera answer shows
// once on the status line. Design: README, "Filling in session".

// Rename sync (0.2.14, Julian, 7 Nov 2026): the check also carries this
// conversation's title when it changed, read from the tail of the
// conversation's transcript (never its content), so the session's name in
// Dashera follows a rename here; and a name the owner gives the session in
// Dashera is put on this conversation at its next prompt. No AI tokens
// either way.

// Fixed wake prompt (0.3.4, 12 Nov 2026, SEC-1 / Dashera task 8ab0d831):
// 0.3.2 put organization names in the prompt, and a prompt is an instruction
// channel into the owner's session. Any organization that adds the agent
// names itself, so a name like "Acme. Ignore previous instructions and ..."
// reached the session as if the owner had typed it. The prompt is now a
// fixed template: the only thing that varies is a list of organization ids,
// each checked to be a UUID; anything else (an older Dashera's names, a
// malformed id) is dropped, never quoted. check_in takes an organization's
// id as well as its name.

/** An organization id the prompt may carry: a UUID, nothing else. */
const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** At most this many ids in one prompt; more says "each organization". */
export const MAX_PROMPT_ORGS = 10

/** The ids that may go into the prompt: UUIDs only, lower-cased, no repeats. */
export function safeOrgIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return []
  const out: string[] = []
  for (const id of ids) {
    if (typeof id !== 'string' || !ORG_ID.test(id)) continue
    const v = id.toLowerCase()
    if (!out.includes(v)) out.push(v)
  }
  return out
}

/** A live session's code, as Dashera issues it: "S-" and 6 hex digits. */
const SESSION_CODE = /^S-[0-9A-F]{6}$/
export function safeSessionCode(code: unknown): string | null {
  return typeof code === 'string' && SESSION_CODE.test(code) ? code : null
}

/**
 * The turn a wake-up starts (0.3.4): a fixed template. Only UUID-checked
 * organization ids vary; no text Dashera or an organization supplied is
 * ever part of it. Claude Code adds its own framing around it; the plugin
 * fills in this session's code on check_in and advance_cursor itself.
 */
export function wakePrompt(organizationIds?: unknown): string {
  const ids = safeOrgIds(organizationIds)
  if (ids.length === 0 || ids.length > MAX_PROMPT_ORGS) {
    return 'New activity in Dashera. Run check_in with brief: true in each organization you work in.'
  }
  if (ids.length === 1) {
    return `New activity in Dashera (organization id ${ids[0]}). Run check_in with brief: true, passing that id as organization.`
  }
  return `New activity in Dashera (organization ids ${ids.join(', ')}). Run check_in with brief: true in each, passing its id as organization.`
}
const POLL_MS = 15_000
// Never two wake-ups closer than this, however busy Dashera gets (2 minutes
// until 0.3.3, which held a new item up to 2 minutes behind the last wake).
export const MIN_GAP_MS = 30_000
/**
 * Debounce (0.3.2, 11 Nov 2026): the first new addressed item starts a wait
 * this long, and the whole burst gets one wake-up when it ends (4 posts in
 * 3 minutes had woken a session 4 times, about 4 calls each).
 */
export const WAKE_DEBOUNCE_MS = 20_000
/**
 * The hard limit (0.3.3): a burst's wake-up is due at most this long after
 * the first new item the plugin saw, whatever arrives after it.
 */
export const WAKE_MAX_WAIT_MS = 30_000
/**
 * A wake-up waits while the session runs a turn of its own (0.3.3), but a
 * turn that never reported its end holds it no longer than this.
 */
export const STUCK_TURN_MS = 30 * 60_000
/**
 * A main-loop turn with no sign of life (its start, or a tool call of its
 * own) for this long no longer holds a wake-up (0.3.8): a turn the engine
 * started and never ran, or never reported ending, held one for 30 minutes.
 */
export const TURN_IDLE_MS = 5 * 60_000
/** What the status line adds when a wake-up goes past such a turn. */
export const STUCK_NOTE = 'a turn looked stuck; delivering'

/**
 * Whether a main-loop turn still counts as running (0.3.8): one is open,
 * it showed a sign of life under TURN_IDLE_MS ago, and it started under
 * STUCK_TURN_MS ago.
 */
export function turnIsLive(open: boolean, since: number, lastSign: number, now: number): boolean {
  return open && now - lastSign < TURN_IDLE_MS && now - since < STUCK_TURN_MS
}
/** A wake-up the engine dropped is asked again no sooner than this. */
export const RETRY_DROPPED_MS = 30_000
/** How long a submit may take to answer before it counts as queued. */
const SUBMIT_ANSWER_MS = 30_000

// ---- Rename sync (0.2.14) ----
/** A session name in Dashera is at most this long. */
export const TITLE_MAX = 60
/** The transcript's tail is read again at most this often. */
export const TITLE_REFRESH_MS = 60_000
/** How much of the transcript's end is read: a rename line is tiny. */
export const TITLE_TAIL_BYTES = 64 * 1024
/** $.fs.read refuses a file over this; `tail` is tried first. */
const FS_READ_LIMIT = 4 * 1024 * 1024

/**
 * The folder under ~/.claude/projects that holds a working folder's
 * transcripts: its path with every character that isn't a letter or a digit
 * replaced by "-" ("/" and " " alike, as the folders on a Mac show).
 */
export function projectFolderOf(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

/** Where Claude Code writes this conversation's transcript. */
export function transcriptPath(home: string, cwd: string, sessionId: string): string {
  return `${home.replace(/\/+$/, '')}/.claude/projects/${projectFolderOf(cwd)}/${sessionId}.jsonl`
}

/**
 * The conversation's title now, from the end of its transcript: Claude Code
 * appends {"type":"custom-title","customTitle":"…"} when it is renamed, and
 * the last such line is current. A tail may begin in the middle of a line;
 * only whole lines parse. Null when the conversation was never renamed.
 */
export function lastCustomTitle(tail: string): string | null {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.includes('"custom-title"')) continue
    try {
      const row = JSON.parse(line) as { type?: unknown; customTitle?: unknown }
      if (row.type === 'custom-title' && typeof row.customTitle === 'string') {
        const title = row.customTitle.trim().slice(0, TITLE_MAX)
        return title || null
      }
    } catch {
      // A line the tail cut, or not JSON: look further up.
    }
  }
  return null
}

// ---- Context size (0.3.10, Dashera Token savings 2) ----
/** How much of the transcript's end is read for the last turn's usage. */
export const CONTEXT_TAIL_BYTES = 256 * 1024
/** The usage is read again at most this often (with the title's cadence). */
export const CONTEXT_REFRESH_MS = 60_000
/** A size is sent again when it moved by more than this share... */
export const CONTEXT_RESEND_SHARE = 0.05
/** ...or this long after it was last sent. */
export const CONTEXT_RESEND_MS = 10 * 60_000

/**
 * The conversation's context size in tokens, from the end of its
 * transcript: the usage numbers on the last main-thread (not isSidechain)
 * assistant line. input_tokens + cache_creation_input_tokens +
 * cache_read_input_tokens is what the next turn reloads. Numbers only: the
 * line's content is never kept or sent. Null when the tail holds none.
 */
export function lastContextTokens(tail: string): number | null {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
    try {
      const row = JSON.parse(line) as {
        type?: unknown
        isSidechain?: unknown
        message?: { usage?: Record<string, unknown> }
      }
      if (row.type !== 'assistant' || row.isSidechain === true) continue
      const u = row.message?.usage
      if (!u || typeof u !== 'object') continue
      const n = (k: string) => {
        const v = u[k]
        return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
      }
      const total = n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens')
      return total > 0 ? Math.min(total, 10_000_000) : null
    } catch {
      // A line the tail cut, or not JSON: look further up.
    }
  }
  return null
}

/** The size to send with this check: a new one, a big move, or a stale send. */
export function contextToSend(
  current: number | null,
  lastSent: number | null,
  lastSentAt: number,
  now: number,
): number | null {
  if (current === null) return null
  if (lastSent === null) return current
  if (Math.abs(current - lastSent) > lastSent * CONTEXT_RESEND_SHARE) return current
  return now - lastSentAt >= CONTEXT_RESEND_MS ? current : null
}

/** Whether this Dashera takes contextTokens (0.3.10; its tool list says so). */
export const takesContext = (t: { description: string }) => /contextTokens/.test(t.description)

/** The title to send with this check: only one that differs from the last sent. */
export function titleToSend(current: string | null, lastSent: string | null): string | null {
  return current && current !== lastSent ? current : null
}

/**
 * The other direction: the name to put on this conversation, when its owner
 * renamed the session in Dashera (nameSource "owner") and the conversation's
 * title differs. A name the agent gave, or one that follows the title
 * already, changes nothing here.
 */
export function titleFromDashera(
  answer: { name?: string | null; nameSource?: string | null },
  title: string | null,
): string | null {
  if (answer.nameSource !== 'owner') return null
  const name = (answer.name ?? '').trim().slice(0, TITLE_MAX)
  return name && name !== title ? name : null
}

// ---- Session continuity (0.3.0; per conversation since 0.3.1) ----
/** The plugin store's key: connected conversation ids (0.3.1 on). */
export const CONVERSATIONS_KEY = 'conversations'
/** 0.3.0's key, one id per folder: never read, cleared once. */
export const LEGACY_CONTINUITY_KEY = 'continuity'
/** A stored id is offered for this long after its last check. */
export const CONTINUITY_MAX_AGE_MS = 6 * 3600_000
/** previousSessionId goes with checks until connected, at most this long. */
export const PREVIOUS_SEND_MS = 10 * 60_000
/** At most this many conversations are remembered. */
const CONTINUITY_CONVERSATIONS = 200
/** How much of a resumed transcript's start is read for the ids it continues. */
export const RESUME_HEAD_BYTES = 256 * 1024

/** Connected conversation ids and when each last checked in connected. */
export type ConversationStore = Record<string, { at: number }>

/** The store's value, cleaned: only well-formed entries (never a folder). */
export function conversationsOf(raw: unknown): ConversationStore {
  const out: ConversationStore = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const e = v as { at?: unknown }
    if (k && !k.includes('/') && e && typeof e.at === 'number') out[k] = { at: e.at }
  }
  return out
}

/** The store with this conversation's id remembered; the oldest dropped. */
export function rememberConversation(store: ConversationStore, id: string, at: number): ConversationStore {
  const next: ConversationStore = { ...store, [id]: { at } }
  const keys = Object.keys(next).sort((a, b) => next[b]!.at - next[a]!.at)
  for (const k of keys.slice(CONTINUITY_CONVERSATIONS)) delete next[k]
  return next
}

/**
 * The session ids a transcript's lines carry, in order, each once. A
 * conversation resumed under a new id starts its transcript with the
 * earlier messages, which keep the ids they were written under.
 */
export function transcriptSessionIds(head: string): string[] {
  const seen: string[] = []
  for (const m of head.matchAll(/"sessionId"\s*:\s*"([^"\\]{1,200})"/g)) {
    const id = m[1]!
    if (!seen.includes(id)) seen.push(id)
  }
  return seen
}

/**
 * The id a conversation resumed in a new process continues: the latest id
 * its own transcript was written under that checked in connected, recently,
 * and isn't its own. Never another conversation's: a shared folder says
 * nothing about which conversation this is.
 */
export function resumedFrom(store: ConversationStore, ownIds: string[], id: string, now: number): string | null {
  for (let i = ownIds.length - 1; i >= 0; i--) {
    const prev = ownIds[i]!
    const e = store[prev]
    if (prev !== id && e && now - e.at <= CONTINUITY_MAX_AGE_MS) return prev
  }
  return null
}

/** A random id for this copy of the plugin (new each time it loads). */
export function newInstanceId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Whether this Dashera tells plugin copies apart (its tool list says so). */
export const takesInstance = (t: { description: string }) => /\binstance\b/.test(t.description)

/** Whether this Dashera takes the turn report (0.3.6; its tool list says so). */
export const takesTurnStarted = (t: { description: string }) => /turnStartedAt/.test(t.description)
export const takesDelivered = (t: { description: string }) => /deliveredMarker/.test(t.description)

/**
 * The turnStartedAt this check sends (0.3.6), or null for none: the running
 * turn's start on every check (a turn Dashera hears nothing of for 90 s
 * counts as over), and "none" once after it ends. A turn that never
 * reported its end counts as over after STUCK_TURN_MS.
 */
export function turnStartedAtToSend(
  busy: boolean,
  since: number,
  now: number,
  lastSent: string | null,
): string | null {
  if (busy && now - since < STUCK_TURN_MS) return new Date(since).toISOString()
  return lastSent !== null && lastSent !== 'none' ? 'none' : null
}

/** Whether this Dashera takes the activity label (0.3.7; its tool list says so). */
export const takesActivity = (t: { description: string }) => /activityAt/.test(t.description)

/**
 * The only labels the activity report (0.3.7) ever sends. Dashera accepts
 * exactly these and ignores anything else.
 */
export const ACTIVITY_LABELS = [
  'Reading files',
  'Editing code',
  'Running a command',
  'Searching the web',
  'Using Dashera',
  'Using a browser',
  'Working with a sub-agent',
  'Working',
] as const
export type ActivityLabel = (typeof ACTIVITY_LABELS)[number]

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS'])
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const COMMAND_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell'])
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch'])
const AGENT_TOOLS = new Set(['Agent', 'Task'])

/**
 * The label for a tool call (0.3.7): its kind, from the tool's name alone,
 * as one of ACTIVITY_LABELS. `dasheraPrefixes` are the `mcp__<server>__`
 * prefixes of this conversation's Dashera connectors (a claude.ai connector
 * is named by an id, not "dashera"). Never looks at the call's arguments.
 */
export function activityLabel(tool: string, dasheraPrefixes: Iterable<string> = []): ActivityLabel {
  if (READ_TOOLS.has(tool)) return 'Reading files'
  if (EDIT_TOOLS.has(tool)) return 'Editing code'
  if (COMMAND_TOOLS.has(tool)) return 'Running a command'
  if (WEB_TOOLS.has(tool)) return 'Searching the web'
  if (AGENT_TOOLS.has(tool)) return 'Working with a sub-agent'
  if (/^mcp__dashera__/.test(tool)) return 'Using Dashera'
  for (const p of dasheraPrefixes) if (p && tool.startsWith(p)) return 'Using Dashera'
  if (/^mcp__.*(chrome|browser|playwright|puppeteer)/i.test(tool)) return 'Using a browser'
  return 'Working'
}

/** The `mcp__<server>__` prefix of a wake tool's name, or null. */
export const mcpPrefix = (name: string) => /^(mcp__.+__)wake_status$/.exec(name)?.[1] ?? null

/** Whether this Dashera takes previousSessionId (its tool list says so). */
export const takesPrevious = (t: { description: string }) => /previousSessionId/.test(t.description)

// Connectors added from claude.ai are named by an id
// (mcp__618e79f2-...__wake_status), so the tool is found by its own name,
// and among several by the one whose description says Dashera.
const isWakeTool = (name: string) => /(^|__)wake_status$/.test(name)
// The Dashera tools that take this session's code (2 Nov 2026).
export const takesSession = (name: string) =>
  /^mcp__.+__(check_in|advance_cursor|name_my_session|resume_work)$/.test(name)

/**
 * Dashera write tools whose `session` is the caller's own live session code
 * (0.3.9, Release 2b): the plugin fills it in when the call leaves it out.
 * Taken from Dashera's lib/agent-cli/src/tools.ts (every tool whose input
 * schema has `session`: `session: SESSION_PROP` and AUTO_SESSION_TOOLS),
 * less the reads and less the writes where `session` names another session
 * (NEVER_FILL). build_report_limit is on it: left out, its session pauses
 * all of the agent's runs, not only this conversation's. A hooks module never sees an MCP tool's
 * input schema, so this list must be kept in step with Dashera's tools.
 */
export const SESSION_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'act_on_rep_change', 'add_bot_document', 'checkpoint_work', 'add_email_image', 'add_email_image_from_url',
  'add_hr_note', 'add_project_member', 'approve_my_playbook', 'approve_spif_payouts',
  'archive_crm_account', 'archive_project', 'archive_thread', 'build_accept_review_round',
  'build_approve_plan', 'build_cancel_review_round', 'build_create_list', 'build_create_room',
  'build_hand_off', 'build_import_items', 'build_join_room', 'build_pause_scheduled_run',
  'build_post_checklist', 'build_propose_scheduled_run', 'build_record_checklist_reply',
  'build_record_decision', 'build_rename_room', 'build_report_access', 'build_report_env_names',
  'build_report_limit',
  'build_report_push', 'build_report_review', 'build_report_scheduled_run',
  'build_request_plan_changes', 'build_request_sessions', 'build_schedule_run',
  'build_scheduled_run_action', 'build_scheduled_run_settings', 'build_set_brief',
  'build_set_job_titles', 'build_set_lead', 'build_set_qa_seat', 'build_set_role_brief',
  'build_set_services', 'build_set_switch', 'build_start_task', 'build_status',
  'build_sync_conversation', 'build_tick_checklist_item', 'build_tick_import_step',
  'build_update_decision', 'build_update_service', 'cancel_scheduled_email_campaign',
  'close_old_tasks', 'comment_on_task', 'comment_on_task_list', 'complete_task',
  'create_calendar_event', 'create_doc', 'create_email_template', 'create_folder', 'create_project', 'create_sheet',
  'create_task', 'create_task_list', 'create_thread', 'create_ticket', 'delete_calendar_event',
  'delete_crm_account', 'delete_crm_contact', 'delete_crm_product', 'delete_crm_records',
  'delete_deal', 'delete_email_template', 'delete_file', 'delete_knowledge_note',
  'delete_my_message', 'delete_project', 'delete_promotion', 'delete_task', 'delete_task_list',
  'delete_thread', 'dismiss_reminder', 'draft_agent_email', 'duplicate_email_template',
  'edit_my_post', 'export_organization', 'extend_invite', 'flag_knowledge_note',
  'hand_off_session', 'import_rep_history', 'invite_to_project', 'link_crm_accounts_to_project',
  'log_crm_activities', 'log_time', 'mark_agent_email_read', 'move_deal', 'move_to_folder', 'open_direct_message',
  'pause_import_run', 'plan_today', 'post_channel_message', 'post_progress',
  'preview_email_template', 'preview_import', 'record_crm_orders', 'record_crm_store_counts',
  'record_spif_funding', 'reply_to_ticket', 'report_reminder_result', 'request_connection',
  'request_from_owner', 'resend_invite', 'restore_from_trash', 'restore_thread',
  'resume_import_run', 'revoke_invite', 'run_crm_data_connection', 'run_import',
  'schedule_email_campaign', 'send_email_campaign', 'send_email_template_test',
  'send_reorder_link', 'set_channel_fees', 'set_crm_connection_settings', 'set_crm_dashboard',
  'set_crm_data_connection', 'set_crm_sample_settings', 'set_email_theme', 'set_goals',
  'set_my_work_pins', 'set_not_a_rep', 'set_order_line_sold_by', 'set_price_agreement_term',
  'set_product_costs', 'set_rep_change_settings', 'set_report_schedule', 'set_thread_historical',
  'set_ticket_visibility', 'snooze_reminder', 'split_goal', 'start_timer', 'stop_timer',
  'undo_import', 'update_calendar_event', 'update_doc', 'update_email_template',
  'update_invite_role', 'update_knowledge_note', 'update_project', 'update_sheet_rows',
  'update_task', 'update_task_list', 'update_ticket', 'upload_file', 'upsert_crm_accounts',
  'upsert_crm_contacts', 'upsert_crm_inventory', 'upsert_crm_products', 'upsert_crm_shipments',
  'upsert_deals', 'upsert_price_agreements', 'upsert_price_tiers', 'upsert_promotions',
  'upsert_spifs', 'upsert_teams'
])
/** Dashera tools whose `session` is never filled (another session, or a read's filter). */
export const NEVER_FILL: ReadonlySet<string> = new Set([
  'wake_teammate', 'build_add_agent', 'build_remove_agent',
  'list_agent_inbox', 'upcoming_reminders', 'list_unanswered', 'live_session',
  'build_read_added_item', 'call', 'load_tools', 'wake_status',
])

/** `mcp__<server>__` and the tool's own name, or null for a tool of no MCP server. */
export function splitMcpName(name: string): { prefix: string; tool: string } | null {
  const m = /^(mcp__.+__)([A-Za-z0-9_-]+)$/.exec(name)
  return m ? { prefix: m[1]!, tool: m[2]! } : null
}

/**
 * The Dashera connectors among the session's tools (0.3.9): each prefix that
 * lists `wake_status` and also `check_in` or `advance_cursor`.
 */
export function dasheraConnectors(names: Iterable<string>): Set<string> {
  const byPrefix = new Map<string, Set<string>>()
  for (const n of names) {
    const s = splitMcpName(n)
    if (!s) continue
    let set = byPrefix.get(s.prefix)
    if (!set) byPrefix.set(s.prefix, (set = new Set()))
    set.add(s.tool)
  }
  const out = new Set<string>()
  for (const [p, t] of byPrefix) if (t.has('wake_status') && (t.has('check_in') || t.has('advance_cursor'))) out.add(p)
  return out
}

/** What the fill needs to know of this conversation's live session (0.3.9). */
export type LiveSession = {
  code: string | null
  /** The `mcp__<server>__` prefix of the wake_status tool whose answer gave the code. */
  prefix: string | null
  connected: boolean
  connectors: ReadonlySet<string>
}

/**
 * Whether a write call gets this conversation's code (0.3.9): a listed
 * write tool of the very connector whose check gave the code, that
 * connector recognised as Dashera, the conversation connected, and no
 * `session` in the call.
 */
export function fillsWriteSession(tool: string, args: Record<string, unknown>, live: LiveSession): boolean {
  if (!live.code || !live.prefix || !live.connected || !live.connectors.has(live.prefix)) return false
  if ('session' in args && args.session !== undefined) return false
  const s = splitMcpName(tool)
  if (!s || s.prefix !== live.prefix) return false
  return SESSION_WRITE_TOOLS.has(s.tool) && !NEVER_FILL.has(s.tool)
}

/**
 * A refusal of the `session` argument itself, before the call ran (0.3.9):
 * a cached schema's "unexpected parameter `session`", a validator's
 * "unrecognized key", or Dashera's unknown_argument naming session. Only
 * then is a write sent again as written; any other error stands.
 */
export function refusedSessionArg(r: { deny?: string; isError?: boolean; text?: string }): boolean {
  const failed = r.deny !== undefined || r.isError === true
  const t = r.deny ?? r.text ?? ''
  return (
    failed &&
    /\bsession\b/i.test(t) &&
    /(unexpected|unrecogni[sz]ed|unknown|additional)[ _-]?(parameters?|arguments?|propert|keys?|fields?)/i.test(t)
  )
}

/** sessionWarning's code in a Dashera answer (0.3.9), or null. Nothing else of it is read. */
export function sessionWarningCode(text: string | undefined): string | null {
  if (!text || !text.includes('sessionWarning')) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const w = (JSON.parse(text.slice(start, end + 1)) as { sessionWarning?: { code?: unknown } }).sessionWarning
      if (w && typeof w === 'object') {
        return typeof w.code === 'string' && /^[a-z_]{1,40}$/.test(w.code) ? w.code : 'unknown'
      }
    } catch {
      // Not one JSON object: look for the field itself.
    }
  }
  const m = /"sessionWarning"\s*:\s*\{\s*"code"\s*:\s*"([a-z_]{1,40})"/.exec(text)
  return m ? m[1]! : /"sessionWarning"\s*:\s*\{/.test(text) ? 'unknown' : null
}
/** What the status line says, once per conversation, when a write lost its session credit. */
export const SESSION_WARNING_NOTE = 'Dashera: a write was saved without session credit'

// A chat app whose cached tool list predates `session` refuses the extra
// argument before the call runs.
export function refusedSession(r: { isError?: boolean; text?: string }): boolean {
  const t = r.text ?? ''
  return r.isError === true && /session/i.test(t) && /unexpected|unrecognized|not allowed|additional|invalid/i.test(t)
}

// Whether to stop sending where this check runs (sessionId, machine, app,
// folder). Only when the connector refused those fields outright (an app
// whose cached tool list predates them) and a plain check then worked.
// A check that merely failed (a deploy restarting the server, a timeout)
// never drops them: without the sessionId Dashera can't tell this
// conversation from the agent's others and wakes it for all of their work
// (HG, 6 Nov 2026: every live session woken for every item after a deploy).
export function dropWhereAfter(first: Reply, plain: Reply): boolean {
  if (plain.failed || !plain.text) return false
  return first.failed && /session|machine|folder|version|title|\bapp\b/i.test(first.text ?? '') &&
    /unexpected|unrecognized|not allowed|additional|invalid|unknown/i.test(first.text ?? '')
}

// Every Dashera wake tool, the one that last answered first, then those that
// say Dashera, then any other.
export function wakeTools<T extends { name: string; description: string }>(
  tools: readonly T[],
  lastGood?: string,
): T[] {
  const rank = (t: T) =>
    t.name === lastGood ? 0 : /dashera/i.test(t.description + t.name) ? 1 : 2
  return tools.filter(t => isWakeTool(t.name)).sort((a, b) => rank(a) - rank(b))
}

/** A stood-down copy asks this often in case the keeper went away (0.3.5). */
export const STAND_DOWN_RECHECK_MS = 10 * 60_000
/** The one line a copy that stands down shows (0.3.5). */
export const STAND_DOWN_STATUS =
  'Live on Dashera: standing down (another copy of the plugin checks for this conversation)'
// ---- One live copy per conversation (0.3.8) ----
/** The lease: which copy checks for this session. Session-scoped, never across conversations. */
const LEASE = { plugin: 'dashera', key: 'liveCopy' } as const
/** Another copy's lease renewed less than this long ago: this copy doesn't check. */
export const LEASE_FRESH_MS = 15_000
/** A lease not renewed for more than this long is taken over. */
export const LEASE_STALE_MS = 30_000
/** What a copy that waits for the lease shows. */
export const OTHER_COPY_STATUS = 'Live on Dashera: another copy is active'
/** What a copy whose prompts don't enter shows while it waits. */
export const BROKEN_STATUS = 'Live on Dashera: prompts from this copy are not entering (handing over)'
/** How long a prompt's submit result stays on the status line. */
export const SUBMIT_SHOWN_MS = 60_000
/** This many dropped prompts in a row mean this copy can't deliver. */
export const DROPS_BROKEN = 2
/** What became of a prompt, as the engine answered its submit. */
export type DeliveryResult = 'entered' | 'dropped' | 'queued'
/** Whether this Dashera takes the delivery report (0.3.8; its tool list says so). */
export const takesDeliveryResult = (t: { description: string }) => /deliveryResult/.test(t.description)
export const takesDeliveryBroken = (t: { description: string }) => /deliveryBroken/.test(t.description)

/** A lease nobody holds (written when a copy gives it up). */
export const RELEASED: LiveCopyLease = { instance: '', startedAt: 0, renewedAt: 0 }

/** Whether copy a wins over copy b when both come up together: earlier start, then lower id. */
export function firstUp(a: { startedAt: number; instance: string }, b: { startedAt: number; instance: string }): boolean {
  if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt
  return a.instance < b.instance
}

/**
 * What a copy does with the lease before a check: "hold" (its own), "take"
 * (nobody's, stale, or held by a copy that came up together with this one
 * and loses the tie-break), or "wait" (another copy holds it). A copy whose
 * prompts don't enter never takes a lease another copy holds.
 */
export function leaseStep(
  lease: LiveCopyLease | undefined,
  me: { instance: string; startedAt: number },
  now: number,
  broken = false,
): 'hold' | 'take' | 'wait' {
  if (!lease || !lease.instance) return 'take'
  if (lease.instance === me.instance) return 'hold'
  if (now - lease.renewedAt > LEASE_STALE_MS) return 'take'
  const together = Math.abs(lease.startedAt - me.startedAt) < LEASE_FRESH_MS
  if (!broken && together && firstUp(me, lease)) return 'take'
  return 'wait'
}

/** The model's own calls that mean it is connecting this conversation (0.3.5). */
export const isConnectTool = (name: string) =>
  /^mcp__.+__(wake_status|name_my_session|live_session)$/.test(name)
/** A not-connected note that the app turned away is offered at most this often. */
export const NOT_CONNECTED_TRIES = 3

/**
 * The note an unconnected conversation's agent gets once (0.3.5): a fixed
 * template; only a code in Dashera's form (S- and 6 hex digits) varies.
 * `full`: Dashera left the session out because its owner's live sessions
 * are all in use.
 */
export function notConnectedNote(code: unknown, full = false): string | null {
  const c = safeSessionCode(code)
  if (!c) return null
  if (full) {
    return `Live on Dashera note: the Dashera plugin checks for wake-ups in this conversation as session ${c}. Dashera left that session unconnected because its owner's live sessions are all in use, so nothing in Dashera wakes this conversation; it connects by itself once one of them ends (End live session on the agent's card in Dashera).`
  }
  return `Live on Dashera note: the Dashera plugin checks for wake-ups in this conversation as session ${c}, and that session isn't connected, so nothing in Dashera wakes this conversation yet. name_my_session with session "${c}" and this conversation's title as name connects it; the plugin fills in that session code when session is left out.`
}

/** The one turn that asks the person for the rule; nothing changes without their yes. */
export function ruleRequest(tool: string, reason: string): string {
  return `Live on Dashera can't check for new work in this conversation: ${reason}. Ask the person you work with, once and in plain words, whether to add "${tool}" to "permissions" > "allow" in ~/.claude/settings.json. It lets only that yes/no check through, nothing else. Change the file only after they say yes, keep it valid JSON, and tell them it takes effect within 30 seconds with no restart. If they say no, drop it; they can switch this conversation out of auto mode instead.`
}

type Answer = {
  pending?: boolean
  marker?: string | null
  // Where something waits, by name: shown nowhere and never put in the
  // prompt (0.3.4). organizationIds is what the prompt carries.
  organizations?: string[]
  organizationIds?: string[]
  // A newer session of this agent is live; this one isn't woken.
  standingBy?: boolean
  // This session's code and name, for the agent to pass as session.
  session?: { code: string; name: string | null }
  // False: this conversation isn't connected yet (opt-in, 5 Nov 2026).
  connected?: boolean
  // The session's name in Dashera and who set it: "owner" after Rename on
  // its card (then this conversation takes it), "title" when it follows this
  // conversation's title, "agent" after name_my_session (0.2.14).
  name?: string | null
  nameSource?: 'agent' | 'owner' | 'title' | null
  // This conversation's live session was ended on purpose (0.2.15): stop
  // checking until the next prompt here.
  ended?: { at: string; by: 'session' | 'owner' } | null
  // Left unconnected because the owner's live sessions are full (only read
  // as present or not; its text never reaches a prompt).
  refused?: string
  // Another copy of the plugin checks for this conversation and is the one
  // woken (0.3.5): this copy stops its checks.
  standDown?: boolean
}

/** The status line for an ended session (0.2.15). */
export const ENDED_STATUS = 'Dashera: live session ended (paste the connect prompt to connect it again)'
type Reply = { text: string | undefined; failed: boolean }

export function blockedReason(text: string | undefined): string {
  const t = text ?? ''
  if (/auto mode/i.test(t)) return 'auto mode refused the check'
  if (/permission|denied|not allowed/i.test(t)) return 'a permission rule refused the check'
  return 'the connector refused the check'
}

function parse(text: string | undefined): Answer | null {
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const a = JSON.parse(text.slice(start, end + 1)) as Answer
    return typeof a.pending === 'boolean' ? a : null
  } catch {
    return null
  }
}

export const register: Register = on => {
  let lastMarker: string | null = null
  let lastWakeAt = Number.NEGATIVE_INFINITY
  let polling = false
  let lastGood: string | undefined
  let askedForRule = false
  // Debounce (0.3.2): a burst under way, its newest marker, the
  // organizations it touched, and whether the last answer still had work.
  let burst = false
  let burstMarker: string | null = null
  const burstOrgs: string[] = []
  let stillPending = false
  let sessionCode: string | null = null
  // Session memory (0.3.10): the context-full note on the status line, and
  // how to show the status line again; the compaction handler, for the
  // SessionStart fallback.
  let contextNote: string | null = null
  let sayAgain: (() => void) | null = null
  let afterCompaction:
    | ((c: { source: string; compactionId?: string; tokensBefore?: number; tokensAfter?: number }) => Promise<void>)
    | null = null
  // Filling session on writes (0.3.9): the prefix of the connector whose
  // check gave the code, whether that check said connected, the Dashera
  // connectors the tool list shows, whether a sessionWarning was shown in
  // this conversation, and how to show it (set at session.start).
  let codePrefix: string | null = null
  let codeConnected = false
  let connectors: ReadonlySet<string> = new Set()
  let sessionWarned = false
  let showWarning: ((note: string) => void) | null = null
  // Rename sync (0.2.14): this conversation's title as its transcript last
  // said, the title last sent to Dashera, and a name the owner gave the
  // session in Dashera, waiting to go on this conversation.
  let title: string | null = null
  let lastSentTitle: string | null = null
  let pendingTitle: string | null = null
  // Context size (0.3.10): the last turn's, as the transcript said, and the
  // size last sent to Dashera and when.
  let contextTokens: number | null = null
  let lastSentContext: number | null = null
  let lastSentContextAt = 0
  let contextReadAt = Number.NEGATIVE_INFINITY
  // Ended (0.2.15): no checks until a prompt arrives in this conversation.
  let endedPause = false
  // Continuity (0.3.0): the id this conversation last checked in under while
  // connected; the one to send as previousSessionId, and since when; how the
  // last session ended (a /clear carries nothing over); a resume at start.
  let connectedId: string | null = null
  let previousId: string | null = null
  let previousSince = 0
  let endedBy: string | null = null
  // A resume in a new process (0.3.1): its transcript, read once for the
  // ids it continues.
  let resumed = false
  let resumedTranscript: string | null = null
  // This copy of the plugin (0.3.1): Dashera wakes only the newest copy.
  const instance = newInstanceId()
  // One live copy per conversation (0.3.8): when this copy came up; this
  // load's interval and timers, ended at session.end; and the delivery
  // report: the latest prompt's result until a check carries it, drops in a
  // row, and whether this copy gave up the lease for them (and since when).
  let startedAt = 0
  let interval: Timer | null = null
  let endChecks: ((release: boolean) => Promise<void>) | null = null
  let deliveryPending: DeliveryResult | null = null
  let drops = 0
  let broken = false
  let brokenAt = 0
  // Not-connected note (0.3.5): the model called a connect tool itself since
  // the last note; the conversations already told; tries per conversation;
  // and whether this copy is calling wake_status itself right now.
  let engaged = false
  const notedFor = new Set<string>()
  const noteTries = new Map<string, number>()
  let selfCalls = 0
  // Delivery (0.3.3): the main loop's turns running now and since when; a
  // wake-up whose wait ended and that hasn't entered yet; when a dropped one
  // may be asked again; and the check to run when a turn ends.
  const running = new Set<string>()
  let runningSince = 0
  let due: { marker: string; orgs: string[] } | null = null
  let delivering = false
  let retryAt = Number.NEGATIVE_INFINITY
  let checkSoon: (() => void) | null = null
  // Turn report (0.3.6): the turnStartedAt Dashera last got; the marker of a
  // wake-up whose prompt entered, until a check carries it; and one whose
  // submit didn't answer in time, which enters with the next turn.
  let turnSent: string | null = null
  let deliveredPending: string | null = null
  let queuedMarker: string | null = null
  // Activity (0.3.7): the label of the main loop's latest tool call in the
  // running turn and when it was made (never anything else of the call), and
  // the prefixes of the Dashera connectors this copy checks through.
  let activity: { label: ActivityLabel; at: number } | null = null
  const dasheraPrefixes = new Set<string>()
  // The main loop's last sign of life (0.3.8): its turn's start or its
  // latest tool call, whichever is later.
  const lastSign = () => Math.max(runningSince, activity?.at ?? Number.NEGATIVE_INFINITY)
  const turnLive = (now: number) => turnIsLive(running.size > 0, runningSince, lastSign(), now)
  // A turn that never ran or never reported its end: forgotten.
  const clearStaleTurn = () => {
    running.clear()
    activity = null
  }

  // The owner renamed the session in Dashera: the conversation takes that
  // name at the next prompt Claude Code allows a title on (a wake-up's
  // prompt counts). The title read from the transcript later confirms it.
  const followDashera = <R extends { sessionTitle?: string }>(r: R): R => {
    if (!pendingTitle) return r
    const name = pendingTitle
    pendingTitle = null
    title = name
    return { ...r, sessionTitle: name }
  }
  on('classic.UserPromptSubmit', async ($, e, next) => {
    // A prompt here (the connect prompt, say) may connect it again: check.
    endedPause = false
    return followDashera(await next(e))
  }).catch(
    ($, e, next) => next(e),
  )
  // The session's own turns (0.3.3): a wake-up waits for the main loop to be
  // idle. A subagent's run is part of a turn the main loop already holds.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      // A new turn after an idle gap (0.3.8): the turns still open from
      // before it never reported their end, so they are over.
      if (running.size > 0 && !running.has(e.turnId) && now - lastSign() >= TURN_IDLE_MS) clearStaleTurn()
      if (running.size === 0) {
        runningSince = now
        activity = null
        await memoryTurnStart?.()
        // A wake-up that waited in the engine's queue enters with this turn.
        if (queuedMarker) {
          deliveredPending = queuedMarker
          queuedMarker = null
        }
      }
      running.add(e.turnId)
    }
    return next(e)
  }).catch(($, e, next) => next(e))
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && running.delete(e.turnId) && running.size === 0) {
      // The turn ended: its activity goes with it (0.3.7).
      activity = null
      // Idle again: check now rather than at the next tick.
      checkSoon?.()
      // Session memory (0.3.10): after the turn has ended, never in it.
      ownerTurn = false
      $.clock.after(MEMORY_AFTER_TURN_MS, () => void memoryAfterTurn?.())
    }
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.SessionStart', async ($, e, next) => {
    // A resumed conversation (continuity): it may go on under a new id.
    // Only a resume: a compact keeps the id, a fork is a new conversation.
    const c = e as { source?: string; transcript_path?: string }
    // Session memory (0.3.10): the fallback signal that a compaction
    // happened, where the session.compact hook didn't fire for it.
    if (c.source === 'compact') void afterCompaction?.({ source: 'compact (session start)' })
    if (c.source === 'resume') {
      resumed = true
      if (typeof c.transcript_path === 'string' && c.transcript_path) resumedTranscript = c.transcript_path
    }
    return followDashera(await next(e))
  }).catch(($, e, next) => next(e))
  // The session this process ran ends: a /clear starts a new conversation
  // (nothing carried over); a resume goes on under another id.
  on('session.end', async ($, e, next) => {
    endedBy = (e as { reason?: string }).reason ?? null
    if (endedBy === 'clear') {
      connectedId = null
      previousId = null
    }
    // The session ends (0.3.8): the interval and every timer end with it,
    // and the lease is given up. Not after a /clear or a resume: the process
    // goes on under another id, and no session.start follows to start again.
    if (endedBy !== 'clear' && endedBy !== 'resume') await endChecks?.(true)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Only this plugin's own yes/no question goes through without a dialog;
  // the model's calls and every other tool are decided as before.
  on('tool.check', async ($, e, next) => {
    if (isWakeTool(e.tool) && next.origin?.plugin === $.plugin.name) {
      return { decision: 'allow', reason: 'Live on Dashera check (yes or no only)' }
    }
    // Session memory (0.3.10): this plugin's own report of a compaction to
    // its own session's memory (resume_work), never the model's calls.
    if (/^mcp__.+__resume_work$/.test(e.tool) && next.origin?.plugin === $.plugin.name) {
      return { decision: 'allow', reason: 'Dashera session memory: report a compaction' }
    }
    return next(e)
  }).catch(($, e, next) =>
    // If this hook ever fails, the usual permission decision stands.
    next(e),
  )

  // A Dashera answer that says a write lost its session credit (0.3.9): on
  // the status line once per conversation. Only the field's presence is
  // read; the result goes back exactly as it came.
  const noteWarning = <R,>(r: R): R => {
    try {
      const text = (r as { text?: unknown }).text
      if (!sessionWarned && typeof text === 'string' && sessionWarningCode(text) && showWarning) {
        sessionWarned = true
        showWarning(SESSION_WARNING_NOTE)
      }
    } catch {
      // Never in the way of the result.
    }
    return r
  }

  // Fill in this session's code on the tools that take it, so the agent
  // needn't remember it. All three are safe to send again (a read, and two
  // writes that only move forward or set a name), so when an old tool list
  // refuses the argument the call goes on as the agent wrote it.
  on('tool.call', async ($, e, next) => {
    const r = await (async () => {
    const args = e as unknown as Record<string, unknown>
    // The model connecting this conversation itself (0.3.5); never this
    // plugin's own checks.
    const origin = (next as unknown as { origin?: { plugin?: string } }).origin
    if (isConnectTool(e.tool) && selfCalls === 0 && origin?.plugin !== $.plugin.name) engaged = true
    // Activity (0.3.7): the kind of the main loop's latest call in a running
    // turn, as a fixed label; the call's arguments are never read here.
    if (e.agentId === undefined && running.size > 0 && origin?.plugin !== $.plugin.name) {
      try {
        activity = { label: activityLabel(e.tool, dasheraPrefixes), at: await $.clock.now() }
      } catch {
        // No label this time; the call goes on as usual.
      }
    }
    // Dashera writes (0.3.9): this conversation's own code when the call
    // leaves session out. Resent as written only when the field itself was
    // refused before the call ran, so a write never runs twice.
    const live: LiveSession = { code: sessionCode, prefix: codePrefix, connected: codeConnected, connectors }
    if (fillsWriteSession(e.tool, args, live)) {
      const r = await next({ ...e, session: live.code } as typeof e)
      if (refusedSessionArg(r as { deny?: string; isError?: boolean; text?: string })) return noteWarning(await next(e))
      return noteWarning(r)
    }
    if (!sessionCode || !takesSession(e.tool) || typeof args.session === 'string') {
      const prefix = splitMcpName(e.tool)?.prefix
      return prefix && connectors.has(prefix) ? noteWarning(await next(e)) : next(e)
    }
    try {
      const r = await next({ ...e, session: sessionCode } as typeof e)
      if (!('deny' in r && r.deny !== undefined) && !refusedSession(r)) return r
    } catch {
      // Refused before it ran: send it as written below.
    }
    return next(e)
    })()
    return memoryAfterCall ? ((await memoryAfterCall(e, next, r)) as typeof r) : r
  }).catch(($, e, next) => next(e))

  // ---- Session memory (0.3.10, Dashera Session memory 1) ----
  // See hooks/memory.ts. State: whether the running main-loop turn is the
  // owner's (a prompt the person typed started it), whether the next one
  // will be, /dashera-compact's arming, the compaction Dashera confirmed,
  // the ones already handled, the epoch Dashera last gave, when it last
  // advanced (the two compaction signals are one), the notice's place, and
  // the latest compaction's report.
  let ownerTurn = false
  let nextTurnOwner = false
  let commandArmedAt = Number.NEGATIVE_INFINITY
  const COMMAND_ARM_MS = 10 * 60_000
  let pendingCompaction: { id: string; checkpointId: string; version: number; tries: number } | null = null
  let compacting = false
  const handledCompactions = new Set<string>()
  let epoch: number | null = null
  let lastAdvanceAt = Number.NEGATIVE_INFINITY
  let noticeBaseline: number | null = null
  let noticeLast: number | null = null
  let report: CompactionReport | null = null
  let sampling = false
  let memoryTurnStart: (() => Promise<void>) | null = null
  let memoryAfterCall: ((e: { tool: string; agentId?: string }, next: unknown, r: unknown) => Promise<unknown>) | null = null
  let memoryAfterTurn: (() => Promise<void>) | null = null
  let compactNow: (() => Promise<void>) | null = null
  let submitCompactRequest: (() => void) | null = null
  /** The memory work after a turn waits this long, so it runs outside the turn. */
  const MEMORY_AFTER_TURN_MS = 1_000

  // Whose turn this is: a prompt the person typed (composer, Remote
  // Control) makes the next turn, or the running one, the owner's; anything
  // else delivered into a running turn takes that away.
  on('prompt.submit', async ($, e, next) => {
    const owner = isOwnerOrigin((e as { origin?: unknown }).origin)
    if ((e as { turnId?: string }).turnId !== undefined) ownerTurn = ownerTurn && owner ? true : owner
    else nextTurnOwner = owner
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'dashera-compact' }, async ($, e) => {
    if (/^\s*report\s*$/i.test(e.args)) return { text: reportText(report) }
    if (!isOwnerOrigin(e.origin)) return { text: 'Only the owner can run /dashera-compact.' }
    if (!sessionCode) return { text: 'This conversation is not a connected Dashera session, so there is nothing to save to. Nothing was compacted.' }
    if (pendingCompaction || compacting) return { text: 'A compaction is already waiting for this turn to end. Nothing new was started.' }
    commandArmedAt = await $.clock.now()
    submitCompactRequest?.()
    return { text: 'Saving this session to Dashera. It compacts when Dashera confirms the checkpoint and the turn ends.' }
  }).catch(() => ({ text: 'Dashera: /dashera-compact failed before it started. Nothing was compacted.' }))


  // At each idle turn end: compact if Dashera confirmed one; then read the
  // real size for the notice and the growth report. Never during a turn.

  // Any compaction of the main conversation (the owner's /compact, the
  // runtime's own, another plugin's): the epoch advances after it, and the
  // pointer turn starts. Never a veto, never waiting on Dashera.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && !('skip' in r && r.skip !== undefined)) {
      const done = r as { tokensBefore?: number; tokensAfter?: number }
      void afterCompaction?.({ source: e.trigger, tokensBefore: done.tokensBefore, tokensAfter: done.tokensAfter }).catch(() => undefined)
    }
    return r
  }).catch(($, e, next) => next(e))


  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Session memory (0.3.10): /dashera-compact. Registering again replaces it.
    try {
      await $.command.register({
        name: 'dashera-compact',
        description: 'Save this session to Dashera, then compact it (report: the last compaction)',
        argumentHint: '[report]',
      })
    } catch {
      // An engine without registered commands: the owner's words still work.
    }
    // Session memory (0.3.10): its closures use this start's $.
    submitCompactRequest = () => {
      // Fixed text, no data: a turn that saves the checkpoint, once the
      // command has answered.
      $.clock.after(250, () => void $.prompt.submit({ text: COMPACT_REQUEST_PROMPT }).catch(() => undefined))
    }
    const later = <T,>(p: Promise<T>, ms: number): Promise<T | 'timeout'> =>
      Promise.race([p, new Promise<'timeout'>(r => void $.clock.after(ms, () => r('timeout')))])
    // A call to this conversation's own Dashera connector (the one whose
    // check gave the code). Null when there is none or it failed.
    const callDashera = async (tool: string, args: Record<string, unknown>): Promise<string | null> => {
      const prefix = codePrefix
      if (!prefix || !sessionCode) return null
      const server = prefix.replace(/^mcp__/, '').replace(/__$/, '')
      try {
        const r = await $.mcp.call(server, tool, args)
        if (r.isError) return null
        return r.content.map(b => ((b as { type?: string }).type === 'text' ? (b as { text: string }).text : '')).join('\n')
      } catch {
        try {
          const r = await $.tool.call({ tool: `${prefix}${tool}` as `mcp__${string}__${string}`, ...args } as {
            tool: `mcp__${string}__${string}`
          })
          return r.deny !== undefined || r.isError ? null : (r.text ?? null)
        } catch {
          return null
        }
      }
    }
    const usageOf = async (breakdown = false) => {
      try {
        const u = await later(breakdown ? $.session.usage({ breakdown: 'summary' }) : $.session.usage(), 5000)
        return u === 'timeout' ? null : u
      } catch {
        return null
      }
    }
    const reportCompaction = async (id: string, status: string, extra: Record<string, unknown> = {}) => {
      if (!sessionCode) return
      for (let i = 0; i < 3; i++) {
        const r = await later(callDashera('resume_work', { session: sessionCode, compaction: { id, status, ...extra } }), 15_000)
        if (r !== 'timeout' && r !== null) return
      }
    }

    afterCompaction = async c => {
      const now = await $.clock.now()
      // Both signals (the hook and SessionStart "compact") for one
      // compaction: the epoch advances once.
      if (now - lastAdvanceAt < EPOCH_DEDUPE_MS) return
      lastAdvanceAt = now
      const code = sessionCode
      const after = await usageOf(true)
      const tokensAfter = c.tokensAfter ?? after?.context.tokens
      report = {
        code,
        epoch: null,
        source: c.source,
        before: c.tokensBefore ?? 'unknown',
        after: tokensAfter ?? 'unknown',
        window: after?.context.window ?? 'unknown',
        split: categorySplit(after?.context.breakdown),
        dashera: { playbookAndRules: 'unknown', playbook: 'unknown', card: 'unknown' },
        samples: [],
      }
      sampling = true
      noticeBaseline = tokensAfter ?? null
      noticeLast = null
      contextNote = null
      sayAgain?.()
      if (!code) return
      const op = `ctx-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      let answer: string | null = null
      for (let i = 0; i < 3 && answer === null; i++) {
        const r = await later(
          callDashera('resume_work', {
            session: code,
            newContext: true,
            contextOperation: op,
            ...(typeof tokensAfter === 'number' ? { contextTokens: tokensAfter } : {}),
            ...(c.compactionId
              ? {
                  compaction: {
                    id: c.compactionId,
                    status: 'done',
                    ...(typeof c.tokensBefore === 'number' ? { tokensBefore: c.tokensBefore } : {}),
                    ...(typeof tokensAfter === 'number' ? { tokensAfter } : {}),
                  },
                }
              : {}),
          }),
          15_000,
        )
        answer = r === 'timeout' ? null : r
      }
      const n = parseEpoch(answer ?? undefined)
      if (n !== null) epoch = n
      if (report) report.epoch = epoch
      // Only the fixed pointer, never anything Dashera or the session wrote.
      void $.prompt.submit({ text: pointerPrompt(code, n) }).catch(() => undefined)
    }

    compactNow = async () => {
      const p = pendingCompaction
      if (!p || compacting || !sessionCode) return
      compacting = true
      try {
        const before = await usageOf()
        let r: Awaited<ReturnType<typeof $.session.compact>> | 'timeout'
        try {
          r = await later($.session.compact({ instructions: compactInstructions(sessionCode, p.checkpointId, p.version) }), COMPACT_TIMEOUT_MS)
        } catch (err) {
          // Rejected (a turn running, or no compaction here): never forced.
          p.tries += 1
          if (p.tries >= COMPACT_TRIES) {
            pendingCompaction = null
            handledCompactions.add(p.id)
            await reportCompaction(p.id, 'failed', { detail: String(err instanceof Error ? err.message : err).slice(0, 160) })
          }
          return
        }
        pendingCompaction = null
        handledCompactions.add(p.id)
        if (r === 'timeout') {
          await reportCompaction(p.id, 'unknown', { detail: 'no answer within 10 minutes' })
          return
        }
        if ('skip' in r && typeof r.skip === 'string') {
          await reportCompaction(p.id, 'vetoed', { detail: r.skip.slice(0, 160) })
          return
        }
        const done = r as { tokensBefore?: number; tokensAfter?: number }
        await afterCompaction?.({
          source: 'dashera-compact',
          compactionId: p.id,
          tokensBefore: done.tokensBefore ?? before?.context.tokens,
          tokensAfter: done.tokensAfter,
        })
      } finally {
        compacting = false
      }
    }

    memoryTurnStart = async () => {
      const now = await $.clock.now()
      ownerTurn = nextTurnOwner || now - commandArmedAt < COMMAND_ARM_MS
      nextTurnOwner = false
    }
    memoryAfterCall = async (e, callNext, r) => {
      try {
        const s = splitMcpName(e.tool)
        const origin = (callNext as { origin?: { plugin?: string } }).origin
        if (!s || !codePrefix || s.prefix !== codePrefix || origin?.plugin === $.plugin.name) return r
        const text = (r as { text?: string }).text
        const failed = (r as { isError?: boolean; deny?: string }).isError === true || (r as { deny?: string }).deny !== undefined
        // Dashera's own answers in the new context, by size only.
        if (report && sampling && !failed && typeof text === 'string') {
          if (s.tool === 'check_in' && report.dashera.playbookAndRules === 'unknown') {
            const owner = /<from_your_owner>[\s\S]*?<\/from_your_owner>/.exec(text)
            report.dashera.playbookAndRules = owner ? owner[0].length : 'unknown'
          }
          if (s.tool === 'get_playbook' && report.dashera.playbook === 'unknown') report.dashera.playbook = text.length
          if (s.tool === 'resume_work' && report.dashera.card === 'unknown' && /"delivery"\s*:\s*"full"/.test(text)) report.dashera.card = text.length
        }
        const args = e as unknown as Record<string, unknown>
        if (s.tool !== 'checkpoint_work' || args.compactAfter !== true) return r
        const confirmed = failed ? null : parseCheckpointAnswer(text)
        if (!confirmed || !confirmed.checkpointId || !confirmed.compactionId || confirmed.compactionStatus !== 'pending') {
          // No confirmation, no compaction, and /dashera-compact's arming
          // ends with it: a later turn (a wake-up's) can't use it.
          commandArmedAt = Number.NEGATIVE_INFINITY
          if (!confirmed || confirmed.compactionStatus !== 'not_supported') {
            contextNote = 'Dashera: checkpoint not confirmed, not compacting'
            sayAgain?.()
          }
          return r
        }
        if (handledCompactions.has(confirmed.compactionId)) return r
        if (pendingCompaction?.id === confirmed.compactionId) return r
        const now = await $.clock.now()
        const byOwner = e.agentId === undefined && (ownerTurn || now - commandArmedAt < COMMAND_ARM_MS)
        if (!byOwner) {
          handledCompactions.add(confirmed.compactionId)
          void reportCompaction(confirmed.compactionId, 'vetoed', {
            detail: e.agentId !== undefined ? 'not_owner: a subagent asked' : 'not_owner: the turn was not started by the owner',
          })
          return r
        }
        // The repeat's no-op answer names the pending one; its version comes
        // from the save that made it, so only a fresh confirmation arms it.
        if (confirmed.version === null) return r
        pendingCompaction = { id: confirmed.compactionId, checkpointId: confirmed.checkpointId, version: confirmed.version, tries: 0 }
        commandArmedAt = Number.NEGATIVE_INFINITY
      } catch {
        // Never in the way of the call's own result.
      }
      return r
    }
    memoryAfterTurn = async () => {
      if (running.size > 0) return
      try {
        if (pendingCompaction) {
          await compactNow?.()
          return
        }
        const u = await usageOf()
        const tokens = u?.context.tokens ?? null
        if (tokens === null) return
        if (report && sampling && typeof report.after === 'number') {
          report.samples.push(tokens)
          if (report.samples.length >= GROWTH_TURNS) sampling = false
        }
        const window = u?.context.window ?? null
        if (noticeDue(tokens, window, noticeBaseline, noticeLast)) {
          noticeLast = tokens
          contextNote = noticeText(tokens, u?.context.percent ?? null)
          sayAgain?.()
        }
      } catch {
        // The size is unknown this time; nothing is shown.
      }
    }

    // Another start in this load (0.3.8): the interval already runs; never a
    // second one beside it.
    if (interval) return started
    startedAt = await $.clock.now()
    const timers = new Set<Timer>()
    const after = (ms: number, fn: () => void) => {
      const t: Timer = $.clock.after(ms, () => {
        timers.delete(t)
        fn()
      })
      timers.add(t)
      return t
    }
    // A burst's timer from an earlier start may be gone: start clean (a
    // late one still wakes at most once per marker).
    burst = false
    due = null
    // Where this session runs, for the agent's card in Dashera: the
    // computer, the app and the folder. Never content. Gathered in the
    // background with a time limit each, so nothing here can ever hold up
    // the checks (a host command can wait on the app indefinitely).
    const where: Record<string, string> = {}
    const surface = (e as { surface?: string }).surface
    // The plugin's own version goes with every check (0.2.15).
    where.version = PLUGIN_VERSION
    where.app =
      surface === 'desktop'
        ? 'Claude app'
        : surface === 'vscode'
          ? 'VS Code'
          : surface === 'mobile'
            ? 'Claude mobile'
            : 'Claude Code'
    const within = <T,>(p: Promise<T>, ms: number): Promise<T | undefined> =>
      Promise.race([
        p.catch(() => undefined),
        new Promise<undefined>(r => {
          $.clock.after(ms, () => r(undefined))
        }),
      ])
    // For the transcript's path (rename sync): the whole working folder
    // and the home folder. Neither is sent anywhere.
    let cwdFull: string | null = null
    let home: string | null = null
    const gather = async () => {
      const id = await within($.session.id(), 3000)
      if (id) where.sessionId = id
      const cwd = await within($.session.cwd(), 3000)
      if (cwd) {
        cwdFull = cwd
        where.folder = cwd.split('/').filter(Boolean).pop() ?? cwd
      }
      home ??= (await within($.env.get('HOME'), 2000)) ?? null
      // A cloud session runs in a fresh container whose hostname means
      // nothing to its owner ("vm", HG 2 Nov 2026): say it's the cloud.
      const remote = await within(
        $.process.run(['printenv', 'CLAUDE_CODE_REMOTE'], { timeoutMs: 2000 }),
        3000,
      )
      if (remote && remote.exitCode === 0 && remote.stdout.trim() === 'true') {
        where.machine = 'Cloud'
        return
      }
      for (const argv of [
        ['scutil', '--get', 'ComputerName'],
        ['hostname', '-s'],
      ]) {
        const r = await within($.process.run(argv, { timeoutMs: 2000 }), 3000)
        if (r && r.exitCode === 0 && r.stdout.trim()) {
          const name = r.stdout.trim().slice(0, 80)
          where.machine = argv[0] === 'hostname' && name === 'vm' ? 'Cloud' : name
          break
        }
      }
    }
    // On the plugin's own timer, after the start-up step has finished.
    after(1000, () => void gather())
    // Rename sync: the transcript file, found once (it appears with the
    // first message), and its tail read at most every TITLE_REFRESH_MS.
    let transcript: string | null = null
    let titleReadAt = Number.NEGATIVE_INFINITY
    const findTranscript = async (): Promise<string | null> => {
      if (!where.sessionId || !cwdFull || !home) return null
      const expected = transcriptPath(home, cwdFull, where.sessionId)
      if (await within($.fs.exists(expected), 2000)) return expected
      // Another folder spelling (a link, another version): look for the
      // file by this conversation's id under ~/.claude/projects.
      const root = `${home}/.claude/projects`
      const dirs = (await within($.fs.list(root), 3000)) ?? []
      for (const d of dirs) {
        if (d.kind !== 'dir') continue
        const p = `${root}/${d.name}/${where.sessionId}.jsonl`
        if (await within($.fs.exists(p), 1000)) return p
      }
      return null
    }
    const readTitle = async () => {
      transcript ??= await findTranscript()
      if (!transcript) return
      // Only the end of the file: a transcript can be hundreds of MB.
      const tail = await within(
        $.process.run(['tail', '-c', String(TITLE_TAIL_BYTES), transcript], { timeoutMs: 3000 }),
        4000,
      )
      let text = tail && tail.exitCode === 0 ? tail.stdout : null
      if (text === null) {
        // No tail command (Windows): the whole file, while it is small.
        const stat = await within($.fs.stat(transcript), 2000)
        if (stat && stat.kind === 'file' && stat.size <= FS_READ_LIMIT) {
          const whole = await within($.fs.read(transcript), 4000)
          if (typeof whole === 'string') text = whole
        }
      }
      if (text === null) return
      const found = lastCustomTitle(text)
      if (found) title = found
    }
    // Context size (0.3.10): the end of the same file, numbers only.
    const readContext = async () => {
      transcript ??= await findTranscript()
      if (!transcript) return
      const tail = await within(
        $.process.run(['tail', '-c', String(CONTEXT_TAIL_BYTES), transcript], { timeoutMs: 3000 }),
        4000,
      )
      if (!tail || tail.exitCode !== 0) return
      const found = lastContextTokens(tail.stdout)
      if (found !== null) contextTokens = found
    }
    // The status line (0.3.8: with the latest prompt's submit result for
    // SUBMIT_SHOWN_MS, so a copy whose prompts go nowhere shows it).
    let shown: string | null = null
    let submitNote: string | null = null
    let submitClear: Timer | null = null
    const say = (text: string) => {
      shown = text
      const parts = [text, ...(contextNote ? [contextNote] : []), ...(submitNote ? [submitNote] : [])]
      void $.ui.status(parts.join(' · '))
    }
    sayAgain = () => {
      if (shown) say(shown)
    }
    // The lease's writes; null when $.state can't be read (then this copy
    // checks as it always did).
    const writeLease = async (value: LiveCopyLease, version: number) =>
      within($.state.set(LEASE, value, { ifVersion: version }), 2000)
    // Every prompt's submit result (0.3.8): on the status line, to Dashera
    // with the next check, and DROPS_BROKEN drops in a row give up the lease.
    const recordDelivery = async (result: DeliveryResult, what: string) => {
      deliveryPending = result
      showSubmit(`${what} ${result}`)
      if (result !== 'dropped') {
        drops = 0
        if (result === 'entered') broken = false
        return
      }
      drops += 1
      if (drops < DROPS_BROKEN || broken) return
      broken = true
      brokenAt = await $.clock.now()
      const held = await within($.state.get(LEASE), 2000)
      if (held && held.value?.instance === instance) await writeLease(RELEASED, held.version)
    }
    // A sessionWarning shows like a submit result, for SUBMIT_SHOWN_MS (0.3.9).
    showWarning = note => showSubmit(note)
    const showSubmit = (note: string) => {
      submitNote = note
      say(shown ?? 'Live on Dashera')
      if (submitClear) {
        submitClear.cancel()
        timers.delete(submitClear)
      }
      submitClear = after(SUBMIT_SHOWN_MS, () => {
        submitNote = null
        submitClear = null
        if (shown) say(shown)
      })
    }
    // The burst's wait ended: one wake-up for all of it, unless the work was
    // handled meanwhile or the session ended.
    const wakeForBurst = async () => {
      burst = false
      const orgs = burstOrgs.splice(0)
      if (!stillPending || endedPause || !burstMarker || burstMarker === lastMarker) return
      // Due until its prompt enters (0.3.3); a newer burst takes its place
      // and keeps the organizations both touched.
      const all = [...(due?.orgs ?? [])]
      for (const o of orgs) if (!all.includes(o)) all.push(o)
      due = { marker: burstMarker, orgs: all }
      await deliver()
    }
    // A due wake-up starts its turn now, unless the session is running one
    // of its own (then the first idle check sends it), or the engine dropped
    // it a moment ago. Delivered only when the prompt entered.
    const deliver = async () => {
      if (!due || delivering || endedPause || !stillPending) return
      const now = await $.clock.now()
      if (turnLive(now)) return
      if (now < retryAt) return
      // A turn is open but shows no life (0.3.8): forget it and deliver. The
      // engine may still be running it (one long command); then it queues
      // the prompt behind it, and it counts as delivered at the next turn.
      const pastStale = running.size > 0
      if (pastStale) {
        clearStaleTurn()
        showSubmit(STUCK_NOTE)
      }
      const d = due
      delivering = true
      try {
        const answer = await within(
          $.prompt.submit({ text: wakePrompt(d.orgs) }).then(
            r => ('drop' in r && r.drop !== undefined ? 'dropped' : 'entered'),
            () => 'dropped' as const,
          ),
          SUBMIT_ANSWER_MS,
        )
        // What became of it, on the status line and to Dashera (0.3.8).
        await recordDelivery(answer ?? 'queued', pastStale ? 'a turn looked stuck; wake-up' : 'wake-up')
        // No answer in time: it waits in the engine's queue, which runs it
        // once the session is idle.
        if (answer === 'dropped') {
          retryAt = (await $.clock.now()) + RETRY_DROPPED_MS
          return
        }
        // Entered: the next check tells Dashera (0.3.6). Queued: it enters
        // with the next turn, and is told then (a turn that started while
        // the submit was answering is that turn).
        // Past a stale turn, "entered" may mean queued behind it: delivered
        // only once a turn of its own has started.
        const started = running.size > 0 && runningSince >= now
        if (started || (answer === 'entered' && !pastStale)) deliveredPending = d.marker
        else queuedMarker = d.marker
        lastMarker = d.marker
        lastWakeAt = now
        // A burst that re-raised the same marker while this submit was
        // answering is the same wake-up: done too.
        if (due === d || due?.marker === d.marker) due = null
      } finally {
        delivering = false
      }
    }
    // Stand-down (0.3.5): whether this copy stands down, and when it asks again.
    let standingDown = false
    let probeAt = Number.NEGATIVE_INFINITY
    let sendWhere = true
    let rememberedAt = Number.NEGATIVE_INFINITY
    let whereDroppedAt = 0
    let waitedForId = 0
    // The lease (0.3.8): true when this copy may check now (it holds the
    // lease, took it, or $.state can't be read); false while another copy
    // holds it, or while this copy hands it over after its prompts dropped.
    const leaseTurn = async (now: number): Promise<boolean> => {
      if (broken && now - brokenAt <= LEASE_STALE_MS) return false
      const held = await within($.state.get(LEASE), 2000)
      if (!held) return true
      const step = leaseStep(held.value, { instance, startedAt }, now, broken)
      if (step === 'wait') return false
      const w = await writeLease({ instance, startedAt, renewedAt: now }, held.version)
      // Another copy wrote first: the next tick reads what stands.
      return !(w && !w.isSet)
    }
    endChecks = async (release: boolean) => {
      interval?.cancel()
      interval = null
      for (const t of timers) t.cancel()
      timers.clear()
      checkSoon = null
      due = null
      if (!release) return
      const held = await within($.state.get(LEASE), 2000)
      if (held && held.value?.instance === instance) await writeLease(RELEASED, held.version)
    }
    const tick = async () => {
      if (polling || !interval) return
      // Never check before this conversation's id is known (up to ~30 s):
      // a check without it can't be told apart from the agent's others.
      if (!where.sessionId && waitedForId < 6) {
        waitedForId += 1
        if (waitedForId === 1 || waitedForId === 3) void gather()
        return
      }
      // A connector that refused the details may have been updated: offer
      // them again every 5 minutes.
      if (!sendWhere && Date.now() - whereDroppedAt > 5 * 60_000) sendWhere = true
      polling = true
      try {
        const at = await $.clock.now()
        // One live copy (0.3.8): no check while another copy holds the lease.
        if (!(await leaseTurn(at))) {
          say(broken ? BROKEN_STATUS : OTHER_COPY_STATUS)
          stillPending = false
          due = null
          return
        }
        if (endedPause) return
        // Stood down (0.3.5): only the occasional check, in case the copy
        // Dashera wakes went away.
        if (standingDown && at < probeAt) return
        // Continuity: the id now (a resume or a /clear changes it, and no
        // session.start says so). A changed one names the id it continues.
        const idNow = await within($.session.id(), 2000)
        if (idNow && where.sessionId && idNow !== where.sessionId) {
          const from = connectedId ?? where.sessionId
          if (endedBy !== 'clear' && from !== idNow) {
            previousId = from
            previousSince = at
          }
          endedBy = null
          where.sessionId = idNow
          transcript = null
          titleReadAt = Number.NEGATIVE_INFINITY
          contextReadAt = Number.NEGATIVE_INFINITY
          contextTokens = null
          lastSentContext = null
          lastSentTitle = null
          sessionCode = null
          codePrefix = null
          codeConnected = false
        }
        // Resumed in a new process: the id this conversation itself last
        // connected under, read from its own transcript. Never the folder's.
        if (resumed && !previousId && where.sessionId) {
          resumed = false
          const path = resumedTranscript ?? (await findTranscript())
          const head = path
            ? await within(
                $.process.run(['head', '-c', String(RESUME_HEAD_BYTES), path], { timeoutMs: 3000 }),
                4000,
              )
            : undefined
          const ids = head && head.exitCode === 0 ? transcriptSessionIds(head.stdout) : []
          if (ids.some(x => x !== where.sessionId)) {
            const store = conversationsOf(await within($.store.get(CONVERSATIONS_KEY), 2000))
            const from = resumedFrom(store, ids, where.sessionId, Date.now())
            if (from) {
              previousId = from
              previousSince = at
            }
          }
        }
        if (previousId && at - previousSince > PREVIOUS_SEND_MS) previousId = null
        if (at - titleReadAt >= TITLE_REFRESH_MS) {
          titleReadAt = at
          await readTitle()
        }
        const tools = await $.tool.list()
        const found = wakeTools(tools, lastGood)
        // Context size (0.3.10): read only for a Dashera that takes it.
        if (found.some(takesContext) && at - contextReadAt >= CONTEXT_REFRESH_MS) {
          contextReadAt = at
          await readContext()
        }
        // The Dashera connectors (0.3.9): a wake_status beside check_in or
        // advance_cursor under one prefix.
        connectors = dasheraConnectors(tools.map(t => t.name))
        // The Dashera connectors' prefixes, so their calls read "Using Dashera".
        for (const t of found) {
          const p = /dashera/i.test(t.description + t.name) ? mcpPrefix(t.name) : null
          if (p) dasheraPrefixes.add(p)
        }
        if (found.length === 0) {
          // Connected to a Dashera that predates it, or not at all.
          say(
            tools.some(t => /dashera/i.test(t.name + t.description) && /__whoami$/.test(t.name))
              ? 'Live on Dashera: waiting for Dashera to offer it'
              : 'Live on Dashera: add the Dashera connector to turn it on',
          )
          return
        }
        // In auto mode a check no message of the user's asked for is refused,
        // by $.tool.call and $.mcp.call alike, unless a permission allow rule
        // covers the tool (found by the HG agent, 2 Nov). With two Dashera
        // connectors only one may be allowed, so try each, the last one that
        // answered first.
        const ask = async (name: string, extra: Record<string, string | boolean | number>): Promise<Reply> => {
          const server = name.replace(/^mcp__/, '').replace(/__wake_status$/, '')
          try {
            const r = await $.mcp.call(server, 'wake_status', extra)
            const text = r.content
              .map(b => ((b as { type?: string }).type === 'text' ? (b as { text: string }).text : ''))
              .join('\n')
            return { text: text || JSON.stringify(r.structuredContent ?? null), failed: r.isError }
          } catch (err) {
            selfCalls += 1
            try {
              const r = await $.tool.call({
                tool: name as `mcp__${string}__${string}`,
                ...extra,
              } as { tool: `mcp__${string}__${string}` })
              const text = r.text ?? JSON.stringify(r.result ?? null)
              return { text, failed: r.deny !== undefined || !!r.isError }
            } catch {
              return { text: String(err), failed: true }
            } finally {
              selfCalls -= 1
            }
          }
        }
        // A check that never answers must not stop the next ones: in a cloud
        // session a hung call held every later check for 6 minutes and the
        // session showed as not live (HG, 2 Nov 2026). Give up after 12 s,
        // inside one 15-second tick; the next tick asks again.
        const TIMED_OUT: Reply = { text: 'timed out', failed: true }
        const askWithin = async (name: string, extra: Record<string, string | boolean | number>) =>
          (await within(ask(name, extra), 12_000)) ?? TIMED_OUT
        let answer: Answer | null = null
        let refused: Reply | undefined
        // The conversation's title goes with the details, when it changed.
        const sending = titleToSend(title, lastSentTitle)
        const extra = sendWhere ? { ...where, ...(sending ? { title: sending } : {}) } : {}
        // The turn report (0.3.6) rides on this same check; never from a
        // copy that stands down.
        const turnValue = standingDown
          ? null
          : turnStartedAtToSend(turnLive(at), runningSince, at, turnSent)
        const deliveredValue = standingDown ? null : deliveredPending
        const resultValue = standingDown ? null : deliveryPending
        // Activity (0.3.7): only beside a running turn's start, never "none".
        const contextValue = standingDown
          ? null
          : contextToSend(contextTokens, lastSentContext, lastSentContextAt, at)
        const activityValue =
          turnValue && turnValue !== 'none' && activity && activity.at >= runningSince ? activity : null
        let reported: { turn: string | null; delivered: string | null; result: DeliveryResult | null } | null = null
        for (const t of found) {
          // Continuity: only to a Dashera whose tool takes it (an older tool
          // list refuses an unknown field), and never instead of the rest.
          const prev = sendWhere && previousId && takesPrevious(t) ? previousId : null
          // Which copy asks, only to a Dashera that takes it (0.3.1).
          const withInstance = sendWhere && takesInstance(t) ? { ...extra, instance } : extra
          const turn = sendWhere && turnValue && takesTurnStarted(t) ? turnValue : null
          const delivered = sendWhere && deliveredValue && takesDelivered(t) ? deliveredValue : null
          const act = turn && activityValue && takesActivity(t) ? activityValue : null
          const result = sendWhere && resultValue && takesDeliveryResult(t) ? resultValue : null
          const isBroken = sendWhere && broken && takesDeliveryBroken(t)
          const base: Record<string, string | boolean | number> = {
            ...withInstance,
            ...(turn ? { turnStartedAt: turn } : {}),
            ...(act ? { activity: act.label, activityAt: new Date(act.at).toISOString() } : {}),
            ...(delivered ? { deliveredMarker: delivered } : {}),
            ...(result ? { deliveryResult: result } : {}),
            ...(isBroken ? { deliveryBroken: true } : {}),
            ...(sendWhere && contextValue !== null && takesContext(t) ? { contextTokens: contextValue } : {}),
          }
          let reply = await askWithin(t.name, prev ? { ...base, previousSessionId: prev } : base)
          if (reply === TIMED_OUT) return
          if (prev && (reply.failed || !parse(reply.text))) {
            reply = await askWithin(t.name, base)
            if (reply === TIMED_OUT) return
          }
          let withDetails = sendWhere
          // A session whose connector loaded its tool list before Dashera took
          // session details refuses the extra fields: ask plainly from now on.
          if (sendWhere && (reply.failed || !parse(reply.text))) {
            const first = reply
            reply = await askWithin(t.name, {})
            withDetails = false
            if (reply === TIMED_OUT) return
            if (!reply.failed && parse(reply.text) && dropWhereAfter(first, reply)) {
              sendWhere = false
              whereDroppedAt = Date.now()
            }
          }
          answer = reply.failed ? null : parse(reply.text)
          if (answer) {
            lastGood = t.name
            if (withDetails && sending) lastSentTitle = sending
            if (withDetails) reported = { turn, delivered, result }
            break
          }
          refused ??= reply
        }
        // Dashera got the turn report: the same is not sent again.
        if (answer && reported) {
          if (reported.turn) turnSent = reported.turn
          if (reported.delivered && deliveredPending === reported.delivered) deliveredPending = null
          if (reported.result && deliveryPending === reported.result) deliveryPending = null
        }
        // Dashera got the context size: sent again only when it moves.
        if (answer && reported && contextValue !== null && found.some(t => t.name === lastGood && takesContext(t))) {
          lastSentContext = contextValue
          lastSentContextAt = at
        }
        if (!answer) {
          // Say why, and what to allow, instead of going quiet.
          const reason = blockedReason(refused?.text)
          say(`Live on Dashera: paused (${reason}; allow ${found[0]!.name})`)
          // Once per session, when a permission setting is what blocks it,
          // have the agent ask its person for the one-tool rule, so they
          // only say yes (2 Nov 2026: "one-click Live on Dashera").
          if (!askedForRule && reason !== 'the connector refused the check') {
            askedForRule = true
            // A refused or failed submit just means no reminder this time.
            void within(
              $.prompt.submit({ text: ruleRequest(found[0]!.name, reason) }).then(
                r => ('drop' in r && r.drop !== undefined ? 'dropped' : 'entered') as DeliveryResult,
                () => 'dropped' as const,
              ),
              SUBMIT_ANSWER_MS,
            ).then(r => recordDelivery(r ?? 'queued', 'prompt'))
          }
          return
        }
        // Ended on purpose (0.2.15): say so and stop checking until the next
        // prompt in this conversation.
        if (answer.ended) {
          endedPause = true
          sessionCode = null
          codeConnected = false
          say(ENDED_STATUS)
          return
        }
        // Another copy is the one Dashera wakes (0.3.5): stop checking, say
        // so once, and ask again only every STAND_DOWN_RECHECK_MS. Nothing
        // this copy held is delivered.
        if (answer.standDown === true) {
          if (!standingDown) {
            standingDown = true
            say(STAND_DOWN_STATUS)
          }
          // The copy Dashera wakes reports this conversation's turns now.
          turnSent = null
          deliveredPending = null
          queuedMarker = null
          deliveryPending = null
          activity = null
          probeAt = at + STAND_DOWN_RECHECK_MS
          stillPending = false
          due = null
          return
        }
        // Alone again: back to checking as usual.
        standingDown = false
        // Older Dashera (one live session) may still say standingBy.
        sessionCode = safeSessionCode(answer.session?.code)
        // Writes get the code only through the connector that gave it, and
        // only while this conversation is connected and live (0.3.9).
        codePrefix = lastGood ? mcpPrefix(lastGood) : null
        codeConnected = !!sessionCode && answer.connected !== false && !answer.standingBy
        // Continuity: connected under this id now. Remember it (here and in
        // the plugin's store, per conversation id) so a later id can name it.
        if (answer.connected !== false && sessionCode && where.sessionId) {
          previousId = null
          if (connectedId !== where.sessionId || at - rememberedAt > 10 * 60_000) {
            connectedId = where.sessionId
            rememberedAt = at
            const id = where.sessionId
            void (async () => {
              const store = conversationsOf(await within($.store.get(CONVERSATIONS_KEY), 2000))
              await within($.store.set(CONVERSATIONS_KEY, rememberConversation(store, id, Date.now())), 2000)
              // 0.3.0's per-folder ids are never read again: cleared.
              const legacy = await within($.store.get(LEGACY_CONTINUITY_KEY), 2000)
              if (legacy && typeof legacy === 'object' && Object.keys(legacy).length > 0) {
                await within($.store.set(LEGACY_CONTINUITY_KEY, {}), 2000)
              }
            })()
          }
        }
        // Renamed on its card in Dashera: this conversation takes the name
        // at its next prompt.
        const fromDashera = titleFromDashera(answer, title)
        if (fromDashera) pendingTitle = fromDashera
        const label = sessionCode ? ` · ${sessionCode}` : ''
        say(
          answer.connected === false
            ? 'Dashera: not connected (paste the connect message to make this a live session)'
            : answer.standingBy
            ? 'Live on Dashera: standing by (a newer session is live)'
            : answer.pending
              ? `Dashera: new work waiting${label}`
              : `Live on Dashera${label}`,
        )
        // Only addressed items make an answer pending: Dashera leaves out
        // what addresses another session, and quiet posts (listed at
        // check_in, they wake nobody).
        stillPending = answer.pending === true && !answer.standingBy && answer.connected !== false
        // Handled meanwhile (the agent's own turn checked in): nothing is due.
        if (!stillPending) due = null
        if (stillPending && answer.marker && answer.marker !== lastMarker) {
          burstMarker = answer.marker
          for (const o of safeOrgIds(answer.organizationIds)) if (!burstOrgs.includes(o)) burstOrgs.push(o)
          if (!burst) {
            burst = true
            const now = await $.clock.now()
            // Wait out the burst, never closer than MIN_GAP_MS to the last
            // wake, and never longer than WAKE_MAX_WAIT_MS from this, its
            // first item: later items join it and never restart the wait.
            const wait = Math.min(
              WAKE_MAX_WAIT_MS,
              Math.max(WAKE_DEBOUNCE_MS, lastWakeAt + MIN_GAP_MS - now),
            )
            after(wait, () => void wakeForBurst())
          }
        }
        // A wake-up held by a turn, or dropped, goes now if it can.
        if (due) await deliver()
        // Not connected, and the agent tried to connect it (0.3.5): the
        // note, once per conversation, when the session is idle.
        const conv = where.sessionId
        if (answer.connected === false && engaged && conv && !notedFor.has(conv) && !turnLive(at)) {
          const note = notConnectedNote(sessionCode, typeof answer.refused === 'string')
          const tries = noteTries.get(conv) ?? 0
          if (note && tries < NOT_CONNECTED_TRIES) {
            noteTries.set(conv, tries + 1)
            const sent = await within(
              $.prompt.submit({ text: note }).then(
                r => !('drop' in r && r.drop !== undefined),
                () => false,
              ),
              SUBMIT_ANSWER_MS,
            )
            await recordDelivery(sent === undefined ? 'queued' : sent ? 'entered' : 'dropped', 'prompt')
            // No answer in time: it waits in the engine's queue.
            if (sent !== false) {
              notedFor.add(conv)
              engaged = false
            }
          }
        }
      } catch {
        // The connector may be reconnecting; the next tick tries again.
      } finally {
        polling = false
      }
    }
    // The checks: every POLL_MS, the first after 5 s. A turn ended: check a
    // second later, so a held wake-up goes at once.
    interval = $.clock.every(POLL_MS, () => void tick())
    after(5_000, () => void tick())
    checkSoon = () => {
      if (interval) after(1_000, () => void tick())
    }
    return started
  })
}
