/**
 * questionBank.js — the knowledge that drives the "grill me" feature.
 *
 * A raw prompt like "summarise my emails" is under-specified. Before we can
 * turn it into an agent workflow we must interrogate it along a fixed set of
 * SPEC DIMENSIONS. Each dimension knows:
 *   - how to *detect* whether the prompt already answers it (a cheap keyword
 *     heuristic — deliberately conservative: when unsure, it asks), and
 *   - which clarifying questions to ask when it does not.
 *
 * This module is pure data + pure functions. It has ZERO dependencies so it
 * can be unit-tested in isolation and reused on the client if desired.
 */

/**
 * @typedef {Object} Question
 * @property {string} id          Stable identifier (dimension-scoped).
 * @property {string} dimension   Which spec dimension this probes.
 * @property {string} prompt      The question shown to the user.
 * @property {boolean} critical   If true the spec is not "ready" until answered.
 */

/**
 * @typedef {Object} Dimension
 * @property {string} id
 * @property {string} label
 * @property {boolean} critical
 * @property {RegExp[]} signals   If any signal matches the prompt we assume the
 *                                dimension is already (partially) addressed.
 * @property {Question[]} questions
 */

/** @type {Dimension[]} */
export const DIMENSIONS = [
  {
    id: 'goal',
    label: 'Goal',
    critical: true,
    signals: [/\bso that\b/i, /\bin order to\b/i, /\bgoal\b/i, /\bobjective\b/i],
    questions: [
      {
        id: 'goal.outcome',
        dimension: 'goal',
        critical: true,
        prompt: 'What is the single concrete outcome a successful run must produce?',
      },
      {
        id: 'goal.why',
        dimension: 'goal',
        critical: false,
        prompt: 'Why does this matter — what decision or action does the output feed?',
      },
    ],
  },
  {
    id: 'inputs',
    label: 'Inputs',
    critical: true,
    signals: [/\binput\b/i, /\bfrom\b/i, /\bgiven\b/i, /\buploads?\b/i, /\bfile\b/i, /\bapi\b/i],
    questions: [
      {
        id: 'inputs.source',
        dimension: 'inputs',
        critical: true,
        prompt: 'What are the exact inputs (files, URLs, API responses, user text) and where do they come from?',
      },
      {
        id: 'inputs.shape',
        dimension: 'inputs',
        critical: false,
        prompt: 'What format/shape are those inputs in (JSON, CSV, free text, images)?',
      },
    ],
  },
  {
    id: 'outputs',
    label: 'Outputs',
    critical: true,
    signals: [/\boutput\b/i, /\breturn\b/i, /\bproduce\b/i, /\breport\b/i, /\bsummary\b/i, /\bemail\b/i],
    questions: [
      {
        id: 'outputs.shape',
        dimension: 'outputs',
        critical: true,
        prompt: 'What exact artifact should the workflow emit, and in what format?',
      },
      {
        id: 'outputs.destination',
        dimension: 'outputs',
        critical: false,
        prompt: 'Where should the output go (screen, file, webhook, another system)?',
      },
    ],
  },
  {
    id: 'constraints',
    label: 'Constraints',
    critical: false,
    signals: [/\bmust not\b/i, /\bnever\b/i, /\bwithin\b/i, /\blimit\b/i, /\bbudget\b/i, /\bprivacy\b/i, /\bpii\b/i],
    questions: [
      {
        id: 'constraints.hard',
        dimension: 'constraints',
        critical: false,
        prompt: 'What hard constraints apply (cost ceiling, latency, data that must never leave, tools you cannot use)?',
      },
    ],
  },
  {
    id: 'success',
    label: 'Success criteria',
    critical: true,
    signals: [/\bsuccess\b/i, /\bcorrect\b/i, /\baccurate\b/i, /\bdone when\b/i, /\bacceptance\b/i],
    questions: [
      {
        id: 'success.measure',
        dimension: 'success',
        critical: true,
        prompt: 'How will you know a run was correct — what would make you reject the output?',
      },
    ],
  },
  {
    id: 'edge_cases',
    label: 'Edge cases',
    critical: false,
    signals: [/\bif\b/i, /\bwhen\b.*\bfails?\b/i, /\bempty\b/i, /\bmissing\b/i, /\berror\b/i, /\bretry\b/i],
    questions: [
      {
        id: 'edge_cases.failure',
        dimension: 'edge_cases',
        critical: false,
        prompt: 'What should happen when an input is missing, empty, or a step fails?',
      },
    ],
  },
];

/** Look up a question definition by id across all dimensions. */
export function findQuestion(questionId) {
  for (const dim of DIMENSIONS) {
    const q = dim.questions.find((q) => q.id === questionId);
    if (q) return q;
  }
  return null;
}
