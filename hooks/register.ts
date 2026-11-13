import type { Register } from 'claude-code'
import { PLUGIN_VERSION } from './version'

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

/** Whether this Dashera takes previousSessionId (its tool list says so). */
export const takesPrevious = (t: { description: string }) => /previousSessionId/.test(t.description)

// Connectors added from claude.ai are named by an id
// (mcp__618e79f2-...__wake_status), so the tool is found by its own name,
// and among several by the one whose description says Dashera.
const isWakeTool = (name: string) => /(^|__)wake_status$/.test(name)
// The Dashera tools that take this session's code (2 Nov 2026).
export const takesSession = (name: string) =>
  /^mcp__.+__(check_in|advance_cursor|name_my_session)$/.test(name)

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
  // Rename sync (0.2.14): this conversation's title as its transcript last
  // said, the title last sent to Dashera, and a name the owner gave the
  // session in Dashera, waiting to go on this conversation.
  let title: string | null = null
  let lastSentTitle: string | null = null
  let pendingTitle: string | null = null
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
      if (running.size === 0) {
        runningSince = await $.clock.now()
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
      // Idle again: check now rather than at the next tick.
      checkSoon?.()
    }
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.SessionStart', async ($, e, next) => {
    // A resumed conversation (continuity): it may go on under a new id.
    // Only a resume: a compact keeps the id, a fork is a new conversation.
    const c = e as { source?: string; transcript_path?: string }
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
    return next(e)
  }).catch(($, e, next) => next(e))

  // Only this plugin's own yes/no question goes through without a dialog;
  // the model's calls and every other tool are decided as before.
  on('tool.check', async ($, e, next) => {
    if (isWakeTool(e.tool) && next.origin?.plugin === $.plugin.name) {
      return { decision: 'allow', reason: 'Live on Dashera check (yes or no only)' }
    }
    return next(e)
  }).catch(($, e, next) =>
    // If this hook ever fails, the usual permission decision stands.
    next(e),
  )

  // Fill in this session's code on the tools that take it, so the agent
  // needn't remember it. All three are safe to send again (a read, and two
  // writes that only move forward or set a name), so when an old tool list
  // refuses the argument the call goes on as the agent wrote it.
  on('tool.call', async ($, e, next) => {
    const args = e as unknown as Record<string, unknown>
    // The model connecting this conversation itself (0.3.5); never this
    // plugin's own checks.
    const origin = (next as unknown as { origin?: { plugin?: string } }).origin
    if (isConnectTool(e.tool) && selfCalls === 0 && origin?.plugin !== $.plugin.name) engaged = true
    if (!sessionCode || !takesSession(e.tool) || typeof args.session === 'string') return next(e)
    try {
      const r = await next({ ...e, session: sessionCode } as typeof e)
      if (!('deny' in r && r.deny !== undefined) && !refusedSession(r)) return r
    } catch {
      // Refused before it ran: send it as written below.
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
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
    $.clock.after(1000, () => void gather())
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
      if (running.size > 0 && now - runningSince < STUCK_TURN_MS) return
      if (now < retryAt) return
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
        // No answer in time: it waits in the engine's queue, which runs it
        // once the session is idle.
        if (answer === 'dropped') {
          retryAt = (await $.clock.now()) + RETRY_DROPPED_MS
          return
        }
        // Entered: the next check tells Dashera (0.3.6). Queued: it enters
        // with the next turn, and is told then (a turn that started while
        // the submit was answering is that turn).
        if (answer === 'entered' || (running.size > 0 && runningSince >= now)) deliveredPending = d.marker
        else queuedMarker = d.marker
        lastMarker = d.marker
        lastWakeAt = now
        if (due === d) due = null
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
    const tick = async () => {
      if (polling || endedPause) return
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
          lastSentTitle = null
          sessionCode = null
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
        if (found.length === 0) {
          // Connected to a Dashera that predates it, or not at all.
          $.ui.status(
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
        const ask = async (name: string, extra: Record<string, string>): Promise<Reply> => {
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
        const askWithin = async (name: string, extra: Record<string, string>) =>
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
          : turnStartedAtToSend(running.size > 0, runningSince, at, turnSent)
        const deliveredValue = standingDown ? null : deliveredPending
        let reported: { turn: string | null; delivered: string | null } | null = null
        for (const t of found) {
          // Continuity: only to a Dashera whose tool takes it (an older tool
          // list refuses an unknown field), and never instead of the rest.
          const prev = sendWhere && previousId && takesPrevious(t) ? previousId : null
          // Which copy asks, only to a Dashera that takes it (0.3.1).
          const withInstance = sendWhere && takesInstance(t) ? { ...extra, instance } : extra
          const turn = sendWhere && turnValue && takesTurnStarted(t) ? turnValue : null
          const delivered = sendWhere && deliveredValue && takesDelivered(t) ? deliveredValue : null
          const base: Record<string, string> = {
            ...withInstance,
            ...(turn ? { turnStartedAt: turn } : {}),
            ...(delivered ? { deliveredMarker: delivered } : {}),
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
            if (withDetails) reported = { turn, delivered }
            break
          }
          refused ??= reply
        }
        // Dashera got the turn report: the same is not sent again.
        if (answer && reported) {
          if (reported.turn) turnSent = reported.turn
          if (reported.delivered && deliveredPending === reported.delivered) deliveredPending = null
        }
        if (!answer) {
          // Say why, and what to allow, instead of going quiet.
          const reason = blockedReason(refused?.text)
          $.ui.status(`Live on Dashera: paused (${reason}; allow ${found[0]!.name})`)
          // Once per session, when a permission setting is what blocks it,
          // have the agent ask its person for the one-tool rule, so they
          // only say yes (2 Nov 2026: "one-click Live on Dashera").
          if (!askedForRule && reason !== 'the connector refused the check') {
            askedForRule = true
            // A refused or failed submit just means no reminder this time.
            void $.prompt.submit({ text: ruleRequest(found[0]!.name, reason) }).catch(() => {})
          }
          return
        }
        // Ended on purpose (0.2.15): say so and stop checking until the next
        // prompt in this conversation.
        if (answer.ended) {
          endedPause = true
          sessionCode = null
          $.ui.status(ENDED_STATUS)
          return
        }
        // Another copy is the one Dashera wakes (0.3.5): stop checking, say
        // so once, and ask again only every STAND_DOWN_RECHECK_MS. Nothing
        // this copy held is delivered.
        if (answer.standDown === true) {
          if (!standingDown) {
            standingDown = true
            $.ui.status(STAND_DOWN_STATUS)
          }
          // The copy Dashera wakes reports this conversation's turns now.
          turnSent = null
          deliveredPending = null
          queuedMarker = null
          probeAt = at + STAND_DOWN_RECHECK_MS
          stillPending = false
          due = null
          return
        }
        // Alone again: back to checking as usual.
        standingDown = false
        // Older Dashera (one live session) may still say standingBy.
        sessionCode = safeSessionCode(answer.session?.code)
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
        $.ui.status(
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
            $.clock.after(wait, () => void wakeForBurst())
          }
        }
        // A wake-up held by a turn, or dropped, goes now if it can.
        if (due) await deliver()
        // Not connected, and the agent tried to connect it (0.3.5): the
        // note, once per conversation, when the session is idle.
        const conv = where.sessionId
        if (answer.connected === false && engaged && conv && !notedFor.has(conv) && running.size === 0) {
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
    $.clock.every(POLL_MS, () => void tick())
    $.clock.after(5_000, () => void tick())
    // A turn ended: check a second later, so a held wake-up goes at once.
    checkSoon = () => $.clock.after(1_000, () => void tick())
    return started
  })
}
