import type { Register } from 'claude-code'

// Dashera wake-ups (1 Nov 2026). Every 15 seconds (30 until 5 Nov 2026), between turns, ask the
// Dashera connector's wake_status tool "is anything new waiting for me?".
// It answers yes/no and an opaque marker, nothing else. When the answer is
// yes with a marker not seen before, start one turn with the fixed prompt
// below. The check is a plain tool call outside any model turn, so waiting
// costs no AI tokens; only the turn it starts does.
//
// Rename sync (0.2.14, Julian, 7 Nov 2026): the check also carries this
// conversation's title when it changed, read from the tail of the
// conversation's transcript (never its content), so the session's name in
// Dashera follows a rename here; and a name the owner gives the session in
// Dashera is put on this conversation at its next prompt. No AI tokens
// either way.

/**
 * The turn a wake-up starts. The first in a session reads everything; later
 * ones are one line naming where (Julian, 2 Nov 2026: each wake-up re-read
 * the whole playbook and rules, about 10 KB, in every organization). The
 * Dashera connector's own instructions say what that line means too, so it
 * holds after the conversation is summarized.
 */
export function wakePrompt(
  first: boolean,
  organizations?: string[],
  session?: string | null,
): string {
  const orgs = (organizations ?? []).filter(Boolean)
  const where = orgs.length > 0 ? `: ${orgs.join(', ')}` : ''
  // Later wake-ups are one line (Julian, 2 Nov 2026); the first one says
  // what that line means for the rest of the session. The session code is
  // given once: the plugin fills it in on later calls itself.
  if (!first) return `New activity in Dashera${where}.`
  const lead =
    orgs.length > 0
      ? `Live on Dashera: something new is waiting for you in ${orgs.join(' and ')}.`
      : 'Live on Dashera: something new is waiting for you.'
  const pass = session
    ? ` This session's code is ${session}: pass session: "${session}" to check_in, advance_cursor and name_my_session, so it reads and marks only its own items.`
    : ''
  return `${lead} Run check_in (naming the organization if you work in more than one), handle what it lists, then call advance_cursor.${pass} Later wake-ups only say "New activity in Dashera" and where: do the same for each organization named.`
}
const POLL_MS = 15_000
// Never two wake-ups closer than this, however busy Dashera gets.
const MIN_GAP_MS = 2 * 60_000

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
  return first.failed && /session|machine|folder|\bapp\b/i.test(first.text ?? '') &&
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

/** The one turn that asks the person for the rule; nothing changes without their yes. */
export function ruleRequest(tool: string, reason: string): string {
  return `Live on Dashera can't check for new work in this conversation: ${reason}. Ask the person you work with, once and in plain words, whether to add "${tool}" to "permissions" > "allow" in ~/.claude/settings.json. It lets only that yes/no check through, nothing else. Change the file only after they say yes, keep it valid JSON, and tell them it takes effect within 30 seconds with no restart. If they say no, drop it; they can switch this conversation out of auto mode instead.`
}

type Answer = {
  pending?: boolean
  marker?: string | null
  organizations?: string[]
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
}
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
  let woken = false
  let sessionCode: string | null = null
  // Rename sync (0.2.14): this conversation's title as its transcript last
  // said, the title last sent to Dashera, and a name the owner gave the
  // session in Dashera, waiting to go on this conversation.
  let title: string | null = null
  let lastSentTitle: string | null = null
  let pendingTitle: string | null = null

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
  on('classic.UserPromptSubmit', async ($, e, next) => followDashera(await next(e))).catch(
    ($, e, next) => next(e),
  )
  on('classic.SessionStart', async ($, e, next) => followDashera(await next(e))).catch(
    ($, e, next) => next(e),
  )

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
    // Where this session runs, for the agent's card in Dashera: the
    // computer, the app and the folder. Never content. Gathered in the
    // background with a time limit each, so nothing here can ever hold up
    // the checks (a host command can wait on the app indefinitely).
    const where: Record<string, string> = {}
    const surface = (e as { surface?: string }).surface
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
    let sendWhere = true
    let whereDroppedAt = 0
    let waitedForId = 0
    const tick = async () => {
      if (polling) return
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
            try {
              const r = await $.tool.call({
                tool: name as `mcp__${string}__${string}`,
                ...extra,
              } as { tool: `mcp__${string}__${string}` })
              const text = r.text ?? JSON.stringify(r.result ?? null)
              return { text, failed: r.deny !== undefined || !!r.isError }
            } catch {
              return { text: String(err), failed: true }
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
        for (const t of found) {
          let reply = await askWithin(t.name, extra)
          let withDetails = sendWhere
          if (reply === TIMED_OUT) return
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
            break
          }
          refused ??= reply
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
        // Older Dashera (one live session) may still say standingBy.
        sessionCode = answer.session?.code ?? null
        // Renamed on its card in Dashera: this conversation takes the name
        // at its next prompt.
        const fromDashera = titleFromDashera(answer, title)
        if (fromDashera) pendingTitle = fromDashera
        const label = answer.session?.code ? ` · ${answer.session.code}` : ''
        $.ui.status(
          answer.connected === false
            ? 'Dashera: not connected (paste the connect message to make this a live session)'
            : answer.standingBy
            ? 'Live on Dashera: standing by (a newer session is live)'
            : answer.pending
              ? `Dashera: new work waiting${label}`
              : `Live on Dashera${label}`,
        )
        const now = await $.clock.now()
        if (
          answer.pending &&
          answer.marker &&
          answer.marker !== lastMarker &&
          now - lastWakeAt >= MIN_GAP_MS
        ) {
          lastMarker = answer.marker
          lastWakeAt = now
          // Queued: it starts its own turn once the session is idle.
          const text = wakePrompt(!woken, answer.organizations, answer.session?.code)
          woken = true
          void $.prompt.submit({ text }).catch(() => {})
        }
      } catch {
        // The connector may be reconnecting; the next tick tries again.
      } finally {
        polling = false
      }
    }
    $.clock.every(POLL_MS, () => void tick())
    $.clock.after(5_000, () => void tick())
    return started
  })
}
