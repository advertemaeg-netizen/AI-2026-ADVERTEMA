// No imports on purpose: src/site/config.ts reads this, and the proxy reads that.

/**
 * The legal pages are linked (site footer) and acceptance is asked for at
 * signup — both together, never one without the other. On since 2026-10-21,
 * when the reviewed texts were published. A constant, not an environment
 * variable: turning it off again is a commit, a build and a deploy
 * (deploy/ROLLBACK.md).
 */
export const LEGAL_LINKED = true
