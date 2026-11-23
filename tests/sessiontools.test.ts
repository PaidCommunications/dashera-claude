import { expect, test } from 'claude-code/testing'
import { NEVER_FILL, SESSION_WRITE_TOOLS } from '../hooks/register'
import { DASHERA_COMMIT, DASHERA_SESSION_TOOLS } from './dashera-session-tools.snapshot'

// SESSION_WRITE_TOOLS in step with Dashera (0.3.9). The plugin never sees an
// MCP tool's schema at run time, so this holds the lists to a snapshot of
// Dashera's tools.ts. When it fails after a regenerated snapshot, add the
// tool to SESSION_WRITE_TOOLS (its session is the caller's own) or to
// NEVER_FILL (its session names another session). Regenerate:
// scripts/sync-session-tools.ts (see the README).

const REGEN = `(snapshot from Dashera ${DASHERA_COMMIT}; see scripts/sync-session-tools.ts)`
const writes = DASHERA_SESSION_TOOLS.filter(t => t.access === 'write').map(t => t.name)
const reads = DASHERA_SESSION_TOOLS.filter(t => t.access === 'read').map(t => t.name)
const problem = (what: string, names: string[]) => (names.length ? `${what}: ${names.join(', ')} ${REGEN}` : '')

test('the snapshot lists Dashera tools that take session', () => {
  expect(writes.length).toBeGreaterThan(100)
  expect(writes).toContain('post_channel_message')
})

test('every Dashera write tool with session is on SESSION_WRITE_TOOLS or NEVER_FILL', () => {
  const missing = writes.filter(n => !SESSION_WRITE_TOOLS.has(n) && !NEVER_FILL.has(n))
  expect(problem('Dashera write tools that take session but are on neither SESSION_WRITE_TOOLS nor NEVER_FILL', missing)).toBe('')
})

test('every tool on SESSION_WRITE_TOOLS is a Dashera write tool that takes session', () => {
  const stale = [...SESSION_WRITE_TOOLS].filter(n => !writes.includes(n))
  expect(problem('SESSION_WRITE_TOOLS names tools Dashera no longer lists as writes taking session', stale)).toBe('')
})

test('no read tool is filled, and no tool is on both lists', () => {
  const filledReads = reads.filter(n => SESSION_WRITE_TOOLS.has(n))
  expect(problem('read tools on SESSION_WRITE_TOOLS', filledReads)).toBe('')
  const both = [...SESSION_WRITE_TOOLS].filter(n => NEVER_FILL.has(n))
  expect(problem('tools on both SESSION_WRITE_TOOLS and NEVER_FILL', both)).toBe('')
})
