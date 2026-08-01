/**
 * specYaml.js — render a Spec into the `spec.yaml` scaffolded into every
 * published repository.
 *
 * Pure transformation (Spec → YAML string) using the `yaml` dependency
 * already carried by the server. The published spec.yaml is the durable,
 * human-readable record of what the workflow was built for — the same
 * document the Grill-Me loop produced — so a repo exported from
 * workflow-builders.com is self-describing.
 */

import YAML from 'yaml';

/**
 * @param {import('../spec/specBuilder.js').Spec} spec
 * @param {object} [meta] Extra top-level metadata (projectId, generatedAt).
 * @returns {string} YAML document.
 */
export function renderSpecYaml(spec = {}, meta = {}) {
  const doc = {
    'x-workflow-builders': {
      generator: 'ai-workflow-builder',
      version: meta.version ?? '0.1.0',
      ...(meta.projectId ? { projectId: meta.projectId } : {}),
      ...(meta.generatedAt ? { generatedAt: meta.generatedAt } : {}),
    },
    spec: {
      goal: String(spec.goal ?? ''),
      why: String(spec.why ?? ''),
      ready: Boolean(spec.ready),
      inputs: Array.isArray(spec.inputs) ? spec.inputs.map(String) : [],
      outputs: Array.isArray(spec.outputs) ? spec.outputs.map(String) : [],
      constraints: Array.isArray(spec.constraints) ? spec.constraints.map(String) : [],
      successCriteria: Array.isArray(spec.successCriteria) ? spec.successCriteria.map(String) : [],
      edgeCases: Array.isArray(spec.edgeCases) ? spec.edgeCases.map(String) : [],
      openQuestions: Array.isArray(spec.openQuestions) ? spec.openQuestions.map(String) : [],
    },
  };
  return YAML.stringify(doc, { indent: 2, lineWidth: 0 });
}
