/**
 * grillEngine.js — the deterministic core of the "grill me" feature.
 *
 * Given a raw prompt and the answers gathered so far, it decides which
 * clarifying questions still need asking and whether the spec is ready to be
 * compiled into a workflow. It is a PURE function of its inputs: same prompt +
 * same answers => same questions. That determinism is what makes the feature
 * testable and reproducible; an optional LLM adapter can layer richer questions
 * on top later (see docs/adr/0004), but the guarantee lives here.
 */

import { DIMENSIONS } from './questionBank.js';

/** A dimension is "covered" if the prompt signals it OR every critical
 * question in it has a non-empty answer. */
function isDimensionCovered(dimension, prompt, answers) {
  const signalled = dimension.signals.some((re) => re.test(prompt));
  const criticalQs = dimension.questions.filter((q) => q.critical);
  const allCriticalAnswered =
    criticalQs.length > 0 && criticalQs.every((q) => hasAnswer(answers, q.id));
  return signalled || allCriticalAnswered;
}

function hasAnswer(answers, questionId) {
  const v = answers?.[questionId];
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Produce the next batch of questions to ask.
 *
 * We never re-ask a question that already has an answer. A dimension that the
 * prompt already signals is skipped entirely unless the caller wants a deep
 * grill (`{ deep: true }`), in which case its non-critical questions surface
 * too.
 *
 * @param {string} prompt
 * @param {Record<string,string>} [answers]
 * @param {{ deep?: boolean }} [opts]
 * @returns {import('./questionBank.js').Question[]}
 */
export function nextQuestions(prompt, answers = {}, opts = {}) {
  const out = [];
  for (const dim of DIMENSIONS) {
    const covered = isDimensionCovered(dim, prompt, answers);
    for (const q of dim.questions) {
      if (hasAnswer(answers, q.id)) continue;
      // Always chase unanswered *critical* questions of uncovered dimensions.
      if (!covered && q.critical) out.push(q);
      // In deep mode, also chase the rest.
      else if (opts.deep && !hasAnswer(answers, q.id)) out.push(q);
    }
  }
  return out;
}

/**
 * A spec is READY when every critical dimension is covered. Non-critical gaps
 * are reported as warnings but do not block progress — an architect ships when
 * the essentials are pinned, not when every box is ticked.
 *
 * @returns {{ ready: boolean, missing: string[], warnings: string[], coverage: Record<string, boolean> }}
 */
export function assessReadiness(prompt, answers = {}) {
  const coverage = {};
  const missing = [];
  const warnings = [];
  for (const dim of DIMENSIONS) {
    const covered = isDimensionCovered(dim, prompt, answers);
    coverage[dim.id] = covered;
    if (!covered) {
      if (dim.critical) missing.push(dim.id);
      else warnings.push(dim.id);
    }
  }
  return { ready: missing.length === 0, missing, warnings, coverage };
}

/** Convenience: how far through the grill are we, 0..1 (critical dims only). */
export function coverageScore(prompt, answers = {}) {
  const critical = DIMENSIONS.filter((d) => d.critical);
  const covered = critical.filter((d) => isDimensionCovered(d, prompt, answers)).length;
  return critical.length === 0 ? 1 : covered / critical.length;
}
