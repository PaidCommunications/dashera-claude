/**
 * This plugin's version, sent with every check (0.2.15, Julian, 7 Nov 2026)
 * so Dashera can say when a session's heartbeat is out of date. A hooks
 * module can't read .claude-plugin/plugin.json, so the version lives here
 * too: bump both together (tests/version.test.ts checks this file's shape;
 * the release step checks they match).
 */
export const PLUGIN_VERSION = '0.3.6'
