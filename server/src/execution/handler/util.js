/**
 * handler/util.js — pure helpers shared by the built-in node handlers.
 * Kept dependency-free so handlers stay individually testable.
 */

/** Deep-get a dotted path (a.b.0.c) from a JSON value. */
export function deepGet(value, path) {
  const parts = String(path).split('.');
  let cur = value;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}
