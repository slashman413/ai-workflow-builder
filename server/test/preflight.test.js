/**
 * preflight.test.js — the static Pre-Flight AST validator (Increment 4).
 *
 * The pre-flight gate (preflightWorkflow) is the enhanced static validator
 * run before any publish. It layers, on top of the structural validator:
 *   - reachability analysis (islands, unreachable nodes, dead-end nodes);
 *   - schema parameter matching per node type;
 *   - tool-boundary constraints (persona permissions + tools.json allow-list);
 *   - the security boundary (executable payload markers are refused).
 *
 * This suite pins the merged contract used by PublishService and the
 * /workflow/preflight endpoint.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preFlightCheck, preflightWorkflow } from '../src/domain/workflow/preflight.js';

/** A minimal valid workflow — input → agent → output. */
function baseWorkflow() {
  return {
    id: 'wf_preflight',
    name: 'Preflight workflow',
    nodes: [
      { id: 'collect', type: 'input', name: 'Collect', config: { sources: ['inbox.csv'], mode: 'file' }, dependsOn: [] },
      { id: 'draft', type: 'agent', name: 'Draft', config: { objective: 'summarise the sources', provider: 'openai', persona_id: 'research-agent' }, dependsOn: ['collect'] },
      { id: 'emit', type: 'output', name: 'Emit', config: { targets: ['report.md'] }, dependsOn: ['draft'] },
    ],
  };
}

/** Persona + tool fixture mirroring the agency-agents catalog shape. */
function catalogContext() {
  return {
    personas: [
      { id: 'research-agent', slug: 'research-agent', name: 'Research Agent', tools: ['web-search', 'url-fetch'] },
      { id: 'backend-architect', slug: 'backend-architect', name: 'Backend Architect', tools: ['code-review'] },
    ],
    tools: [
      { id: 'web-search', label: 'Web search' },
      { id: 'url-fetch', label: 'URL fetch' },
      { id: 'code-review', label: 'Code review' },
      { id: 'sql-query', label: 'SQL query' },
    ],
  };
}

test('a structurally valid, bound, schema-clean workflow passes pre-flight', () => {
  const result = preflightWorkflow(baseWorkflow(), catalogContext());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.errors.length, 0);
  assert.match(result.summary, /^ok/);
  assert.equal(result.security.executedCode, false);
  assert.ok(Array.isArray(result.checks));
  assert.ok(result.checks.every((c) => typeof c.passed === 'boolean'));
});

test('cycles and dangling references are reported by the structural layer', () => {
  const cyclic = baseWorkflow();
  cyclic.nodes[2].dependsOn = ['draft'];
  cyclic.nodes[1].dependsOn = ['emit']; // emit → draft → emit
  const result = preflightWorkflow(cyclic, catalogContext());
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === 'CYCLE'), 'cycle must be detected');

  const dangling = baseWorkflow();
  dangling.nodes[1].dependsOn = ['does-not-exist'];
  const result2 = preflightWorkflow(dangling, catalogContext());
  assert.ok(result2.errors.some((e) => e.code === 'DANGLING_DEPENDENCY'));

  const duplicate = baseWorkflow();
  duplicate.nodes.push({ ...duplicate.nodes[0] });
  const result3 = preflightWorkflow(duplicate, catalogContext());
  assert.ok(result3.errors.some((e) => e.code === 'DUPLICATE_ID'));
});

test('reachability: islands and dead-end nodes are surfaced', () => {
  const wf = baseWorkflow();
  wf.nodes.push({ id: 'orphan', type: 'agent', name: 'Orphan', config: { objective: 'never runs' }, dependsOn: [] });
  const result = preflightWorkflow(wf, catalogContext());
  // An island is a warning (non-blocking for the editor, blocking for export).
  assert.ok(result.warnings.some((w) => w.code === 'DISCONNECTED_NODE'));
  assert.ok(result.warnings.some((w) => w.code === 'UNREACHABLE_FROM_INPUT'));
  assert.ok(result.warnings.some((w) => w.code === 'NO_PATH_TO_OUTPUT'));

  // preFlightCheck exposes the executable flag.
  const check = preFlightCheck(wf);
  assert.equal(check.executable, false);
});

test('schema parameter matching: missing required config is an error', () => {
  const wf = baseWorkflow();
  delete wf.nodes[0].config.sources; // input requires sources
  delete wf.nodes[2].config.targets; // output requires targets
  const result = preflightWorkflow(wf, catalogContext());
  assert.equal(result.valid, false);
  const codes = result.errors.map((e) => e.code);
  assert.ok(codes.includes('MISSING_CONFIG'), `missing MISSING_CONFIG: ${codes}`);
  assert.equal(result.checks.find((c) => c.name === 'schema').passed, false);
});

test('schema parameter matching: unknown config keys warn, tool nodes need rules', () => {
  const wf = baseWorkflow();
  wf.nodes[1].config.targt = 'typo-key'; // unknown key
  const result = preflightWorkflow(wf, catalogContext());
  assert.ok(result.warnings.some((w) => w.code === 'UNKNOWN_CONFIG_KEY'));

  // Tool node with neither constraints nor criteria → blocking.
  const wf2 = baseWorkflow();
  wf2.nodes[1] = { id: 'check', type: 'tool', name: 'Check', config: {}, dependsOn: ['collect'] };
  const result2 = preflightWorkflow(wf2, catalogContext());
  assert.ok(result2.errors.some((e) => e.code === 'MISSING_CONFIG'));
});

test('tool-boundary: persona permissions must cover the declared tools', () => {
  const ctx = catalogContext();

  // Agent with a persona and only permitted tools → pass.
  const ok = baseWorkflow();
  ok.nodes[1].config.tools = ['web-search', 'url-fetch'];
  assert.equal(preflightWorkflow(ok, ctx).valid, true);

  // Agent using a tool its persona does not permit → fail.
  const forbidden = baseWorkflow();
  forbidden.nodes[1].config.tools = ['code-review'];
  const result = preflightWorkflow(forbidden, ctx);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === 'TOOL_NOT_PERMITTED'));
});

test('tool-boundary: unknown tools fail closed, even when the catalog is empty', () => {
  const ctx = catalogContext();
  const unknownTool = baseWorkflow();
  unknownTool.nodes[1].config.tools = ['rm-rf-everything'];
  const result = preflightWorkflow(unknownTool, ctx);
  assert.ok(result.errors.some((e) => e.code === 'UNKNOWN_TOOL'));

  // Empty catalog + declared tools → blocked until the catalog is synced.
  const emptyCtx = { personas: [], tools: [] };
  const result2 = preflightWorkflow(unknownTool, emptyCtx);
  assert.equal(result2.valid, false);
  assert.ok(result2.errors.some((e) => e.code === 'UNKNOWN_TOOL'));
});

test('persona binding: unknown persona id is an error, unbound agent warns', () => {
  const ctx = catalogContext();

  const ghost = baseWorkflow();
  ghost.nodes[1].config.persona_id = 'agency-agents:engineering/nonexistent';
  const ghostResult = preflightWorkflow(ghost, ctx);
  assert.ok(ghostResult.errors.some((e) => e.code === 'MISSING_PERSONA'));

  const unbound = baseWorkflow();
  delete unbound.nodes[1].config.persona_id;
  const unboundResult = preflightWorkflow(unbound, ctx);
  assert.ok(unboundResult.warnings.some((w) => w.code === 'UNBOUND_AGENT'));
  assert.equal(unboundResult.valid, true); // warning alone never blocks
});

test('security boundary: executable payload markers are refused', () => {
  const ctx = catalogContext();

  for (const key of ['exec', 'script', 'command', 'shell', 'eval', 'binary']) {
    const attempt = baseWorkflow();
    attempt.nodes[1].config[key] = 'anything';
    const result = preflightWorkflow(attempt, ctx);
    assert.ok(
      result.errors.some((e) => e.code === 'SECURITY_BOUNDARY'),
      `config key "${key}" must be refused`,
    );
    assert.equal(result.security.executedCode, false);
  }

  // Value patterns that look like code injection are refused too.
  const injection = baseWorkflow();
  injection.nodes[1].config.objective = 'run os.system("rm -rf /") and summarise';
  const result = preflightWorkflow(injection, ctx);
  assert.ok(result.errors.some((e) => e.code === 'SECURITY_BOUNDARY'));
});

test('pre-flight is pure static analysis: nothing is executed, ever', () => {
  const wf = baseWorkflow();
  wf.nodes[0].config.sources = ['$(touch /tmp/pwned)'];
  const result = preflightWorkflow(wf, catalogContext());
  assert.equal(typeof result.valid, 'boolean');
  assert.ok(Array.isArray(result.errors));
  assert.equal(result.security.executedCode, false);
  assert.equal(result.security.boundary, 'static-only');
});

test('empty workflow and non-object input fail cleanly', () => {
  const empty = preflightWorkflow({ id: 'x', name: 'x', nodes: [] }, catalogContext());
  assert.equal(empty.valid, false);
  assert.ok(empty.errors.some((e) => e.code === 'EMPTY'));

  const notObject = preflightWorkflow(null, catalogContext());
  assert.equal(notObject.valid, false);
  assert.ok(Array.isArray(notObject.errors));
});
