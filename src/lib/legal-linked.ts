// No imports on purpose: src/site/config.ts reads this, and the proxy reads that.

/**
 * The legal pages are linked (site footer) and acceptance is asked for at
 * signup — both together, never one without the other. Off while the texts
 * are the pre-review drafts with [[placeholders]]: an acceptance recorded now
 * would point at a document with blanks in it. On in the same change that
 * publishes the lawyer's version (deploy/ROLLBACK.md).
 */
export const LEGAL_LINKED = false
