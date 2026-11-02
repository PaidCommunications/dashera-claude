import type { Register } from 'claude-code'

// Dashera wake-ups (1 Nov 2026). Every 30 seconds, between turns, ask the
// Dashera connector's wake_status tool "is anything new waiting for me?".
// It answers yes/no and an opaque marker, nothing else. When the answer is
// yes with a marker not seen before, start one turn with the fixed prompt
// below. The check is a plain tool call outside any model turn, so waiting
// costs no AI tokens; only the turn it starts does.

const PROMPT =
  'Live on Dashera: something new is waiting for you. Run check_in (naming the organization if you work in more than one), handle what it lists, then call advance_cursor.'
const POLL_MS = 30_000
// Never two wake-ups closer than this, however busy Dashera gets.
const MIN_GAP_MS = 2 * 60_000

// Connectors added from claude.ai are named by an id
// (mcp__618e79f2-...__wake_status), so the tool is found by its own name,
// and among several by the one whose description says Dashera.
const isWakeTool = (name: string) => /(^|__)wake_status$/.test(name)

function pickWakeTool<T extends { name: string; description: string }>(
  tools: readonly T[],
): T | undefined {
  const all = tools.filter(t => isWakeTool(t.name))
  return all.find(t => /dashera/i.test(t.description + t.name)) ?? all[0]
}

type Answer = { pending?: boolean; marker?: string | null }

function parse(text: string | undefined): Answer | null {
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1)) as Answer
  } catch {
    return null
  }
}

export const register: Register = on => {
  let lastMarker: string | null = null
  let lastWakeAt = Number.NEGATIVE_INFINITY
  let polling = false

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

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Where this session runs, for the agent's card in Dashera: the
    // computer, the app and the folder. Never content. Each check sends it,
    // so an agent open in two places answers each new item once.
    const where: Record<string, string> = {}
    try {
      where.sessionId = await $.session.id()
    } catch {
      // No id: Dashera treats the check as from an unnamed session.
    }
    const surface = (e as { surface?: string }).surface
    where.app =
      surface === 'desktop'
        ? 'Claude app'
        : surface === 'vscode'
          ? 'VS Code'
          : surface === 'mobile'
            ? 'Claude mobile'
            : 'terminal'
    try {
      const cwd = await $.session.cwd()
      where.folder = cwd.split('/').filter(Boolean).pop() ?? cwd
    } catch {
      // The folder is a nicety.
    }
    for (const argv of [
      ['scutil', '--get', 'ComputerName'],
      ['hostname', '-s'],
    ]) {
      try {
        const r = await $.process.run(argv, { timeoutMs: 2000 })
        if (r.exitCode === 0 && r.stdout.trim()) {
          where.machine = r.stdout.trim().slice(0, 80)
          break
        }
      } catch {
        // Not every host lets a plugin run a command: the card shows the app.
      }
    }
    const tick = async () => {
      if (polling) return
      polling = true
      try {
        const tools = await $.tool.list()
        const tool = pickWakeTool(tools)
        if (!tool) {
          // Connected to a Dashera that predates it, or not at all.
          $.ui.status(
            tools.some(t => /dashera/i.test(t.name + t.description) && /__whoami$/.test(t.name))
              ? 'Live on Dashera: waiting for Dashera to offer it'
              : 'Live on Dashera: add the Dashera connector to turn it on',
          )
          return
        }
        const result = await $.tool.call({
          tool: tool.name as `mcp__${string}__${string}`,
          ...where,
        } as { tool: `mcp__${string}__${string}` })
        if (result.deny !== undefined || result.isError) {
          $.ui.status('Live on Dashera: paused (the connector refused the check)')
          return
        }
        // The answer as the model would read it; else the raw MCP result.
        const answer =
          parse(result.text) ?? parse(JSON.stringify(result.result ?? null))
        if (!answer) return
        $.ui.status(answer.pending ? 'Dashera: new work waiting' : 'Live on Dashera')
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
          void $.prompt.submit({ text: PROMPT })
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
