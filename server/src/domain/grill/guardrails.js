/**
 * guardrails.js — the Grill-Me financial DoS ceilings.
 *
 * The clarification loop is free to the user but NOT free to the operator:
 * every round of questions and answers is LLM-shaped work that costs money at
 * scale. These two ceilings turn the grill loop from an unbounded spend into
 * a bounded one. They are enforced in the SERVICE layer (the answer use case),
 * which makes them impossible to bypass by calling the API directly — SSE is
 * a presentation detail, the ceiling is the business rule.
 *
 *   turns      — an answer round consumes one turn; a session may use at most
 *                MAX_TURNS turns.
 *   tokensUsed — every round adds the estimated tokens of the prompt + the
 *                answers recorded; a session may not exceed MAX_TOKENS.
 *
 * Both are cumulative counters persisted on the project's latest
 * grill_sessions row (see 0005_catalog_schema.sql). Exceeding either yields
 * HTTP 429 with a Retry-After hint.
 */

export const GUARDRAILS = Object.freeze({
  maxTurns: 5,
  maxTokens: 15_000,
});

/**
 * Cheap deterministic token estimate: ~4 chars per token. Deliberately
 * conservative (over-counts, never under-counts) so the ceiling is a true
 * ceiling even for CJK-heavy answers where chars/token ≈ 1.
 *
 * @param {...(string|string[]|undefined)} inputs
 * @returns {number}
 */
export function estimateTokens(...inputs) {
  let chars = 0;
  for (const input of inputs) {
    if (typeof input === 'string') chars += input.length;
    else if (Array.isArray(input)) for (const s of input) if (typeof s === 'string') chars += s.length;
  }
  return Math.ceil(chars / 4);
}

/**
 * Evaluate whether a new answer round fits inside the ceilings.
 *
 * @param {{ turns: number, tokensUsed: number }} usage  cumulative counters.
 * @param {number} incomingTokens  estimated tokens the new round will add.
 * @returns {{ ok: true } | { ok: false, code: 'TURN_LIMIT'|'TOKEN_LIMIT', message: string }}
 */
export function checkGuardrails(usage, incomingTokens = 0) {
  const turns = usage?.turns ?? 0;
  const tokensUsed = usage?.tokensUsed ?? 0;

  if (turns + 1 > GUARDRAILS.maxTurns) {
    return {
      ok: false,
      code: 'TURN_LIMIT',
      message: `Grill session limit reached: at most ${GUARDRAILS.maxTurns} turns per session.`,
    };
  }
  if (tokensUsed + incomingTokens > GUARDRAILS.maxTokens) {
    return {
      ok: false,
      code: 'TOKEN_LIMIT',
      message: `Grill session token budget exhausted: at most ${GUARDRAILS.maxTokens.toLocaleString()} tokens per session.`,
    };
  }
  return { ok: true };
}
