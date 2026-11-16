/**
 * The lease (0.3.8): which copy of the plugin checks for this session.
 * Session-scoped ($.state), so it never spans conversations.
 */
export type LiveCopyLease = { instance: string; startedAt: number; renewedAt: number }

declare module 'claude-code' {
  interface PluginState {
    dashera: { liveCopy: LiveCopyLease }
  }
}
