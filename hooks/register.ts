import type { Register } from 'claude-code'

// Dashera wake-ups (1 Nov 2026). Every 30 seconds, between turns, ask the
// Dashera connector's wake_status tool "is anything new waiting for me?".
// It answers yes/no and an opaque marker, nothing else. When the answer is
// yes with a marker not seen before, start one turn with the fixed prompt
// below. The check is a plain tool call outside any model turn, so waiting
// costs no AI tokens; only the turn it starts does.

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
  // Several live sessions each get their own items (2 Nov 2026): the code
  // tells Dashera which one is asking.
  const code = session ? ` (session ${session})` : ''
  // Later wake-ups are one line (Julian, 2 Nov 2026); the first one says
  // what that line means for the rest of the session.
  if (!first) return `New activity in Dashera${where}${code}.`
  const lead =
    orgs.length > 0
      ? `Live on Dashera: something new is waiting for you in ${orgs.join(' and ')}.`
      : 'Live on Dashera: something new is waiting for you.'
  const pass = session
    ? ` This session's code is ${session}: pass session: "${session}" to check_in, advance_cursor and name_my_session, so it reads and marks only its own items.`
    : ''
  return `${lead} Run check_in (naming the organization if you work in more than one), handle what it lists, then call advance_cursor.${pass} Later in this session a wake-up only says "New activity in Dashera" and where: then run check_in with brief: true for each organization named (or for each you work in, if none is named), handle it, and call advance_cursor.`
}
const POLL_MS = 30_000
// Never two wake-ups closer than this, however busy Dashera gets.
const MIN_GAP_MS = 2 * 60_000

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
    const gather = async () => {
      const id = await within($.session.id(), 3000)
      if (id) where.sessionId = id
      const cwd = await within($.session.cwd(), 3000)
      if (cwd) where.folder = cwd.split('/').filter(Boolean).pop() ?? cwd
      for (const argv of [
        ['scutil', '--get', 'ComputerName'],
        ['hostname', '-s'],
      ]) {
        const r = await within($.process.run(argv, { timeoutMs: 2000 }), 3000)
        if (r && r.exitCode === 0 && r.stdout.trim()) {
          where.machine = r.stdout.trim().slice(0, 80)
          break
        }
      }
    }
    // On the plugin's own timer, after the start-up step has finished.
    $.clock.after(1000, () => void gather())
    let sendWhere = true
    const tick = async () => {
      if (polling) return
      polling = true
      try {
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
        let answer: Answer | null = null
        let refused: Reply | undefined
        for (const t of found) {
          let reply = await ask(t.name, sendWhere ? where : {})
          // A session whose connector loaded its tool list before Dashera took
          // session details refuses the extra fields: ask plainly from now on.
          if (sendWhere && (reply.failed || !parse(reply.text))) {
            reply = await ask(t.name, {})
            if (!reply.failed && parse(reply.text)) sendWhere = false
          }
          answer = reply.failed ? null : parse(reply.text)
          if (answer) {
            lastGood = t.name
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
        const label = answer.session?.code ? ` · ${answer.session.code}` : ''
        $.ui.status(
          answer.standingBy
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
