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

const isWakeTool = (name: string) =>
  /dashera/i.test(name) && /(^|__)wake_status$/.test(name)

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
    const tick = async () => {
      if (polling) return
      polling = true
      try {
        const tools = await $.tool.list()
        const tool = tools.find(t => isWakeTool(t.name))
        if (!tool) {
          // Connected to a Dashera that predates wake-ups, or not at all.
          $.ui.status(
            tools.some(t => /dashera/i.test(t.name))
              ? 'Live on Dashera: waiting for Dashera to offer it'
              : 'Live on Dashera: add the Dashera connector to turn it on',
          )
          return
        }
        const result = await $.tool.call({
          tool: tool.name as `mcp__${string}__${string}`,
        })
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
