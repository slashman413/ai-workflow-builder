import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate } from '../src/domain/codegen/generator.js';
import { suggestNodes } from '../src/domain/spec/specBuilder.js';

/** A spec covering every dimension, like specBuilder.test.js uses. */
function sampleSpec() {
  return {
    goal: 'build a weekly newsletter from my starred repos',
    why: 'keep up with the ecosystem without manual effort',
    inputs: ['github starred repos', 'my reading list'],
    outputs: ['markdown digest', 'email draft'],
    constraints: ['only public repos', 'max 10 items'],
    successCriteria: ['every starred repo appears once'],
    edgeCases: ['repo archived', 'duplicate repos'],
    ready: true,
    openQuestions: [],
  };
}

/** A workflow with all five node types, straight from the spec builder. */
function fullWorkflow() {
  return {
    id: 'wf_newsletter',
    name: 'Newsletter digest',
    nodes: suggestNodes(sampleSpec()),
  };
}

/** Compile one Python file for syntax validity; skips when python3 is absent. */
function assertPythonValid(t, content, label) {
  let python3;
  try {
    python3 = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
  } catch {
    t.skip('python3 not available — skipping Python syntax check');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'codegen-'));
  try {
    writeFileSync(join(dir, 'module.py'), content);
    execFileSync(python3, ['-m', 'py_compile', join(dir, 'module.py')], { stdio: 'pipe' });
  } catch (err) {
    assert.fail(`generated ${label} is not valid Python:\n${err.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('generate produces the full project file set', () => {
  const { files, summary } = generate({ spec: sampleSpec(), workflow: fullWorkflow() });
  assert.deepEqual(Object.keys(files).sort(), [
    '.env.example',
    '.github/workflows/ci.yml',
    '.gitignore',
    'README.md',
    'interfaces.py',
    'main.py',
    'requirements.txt',
    'tests/test_workflow.py',
  ]);
  for (const [path, content] of Object.entries(files)) {
    assert.equal(typeof content, 'string', `${path} must be a string`);
    assert.ok(content.length > 0, `${path} must not be empty`);
  }
  assert.equal(summary, 'Generated 8 files, 1 agent, 2 tools');
});

test('main.py maps every node type to the right Python pattern', () => {
  const { files } = generate({ spec: sampleSpec(), workflow: fullWorkflow() });
  const main = files['main.py'];

  assert.match(main, /def run_input_collect\(ctx: dict\[str, Any\]\) -> dict\[str, Any\]:/);
  assert.match(main, /_load_source\(source\)/); // input → data loading

  assert.match(main, /def run_agent_goal\(ctx: dict\[str, Any\]\) -> str:/);
  assert.match(main, /openai\.OpenAI\(api_key=os\.environ\.get\("OPENAI_API_KEY"\)\)/);
  assert.match(main, /chat\.completions\.create\(/); // agent → LLM call

  assert.match(main, /def run_tool_constraints\(ctx: dict\[str, Any\]\) -> dict\[str, Any\]:/);
  assert.match(main, /_check_rule\(rule, ctx\)/); // tool → rule check

  assert.match(main, /def run_branch_edgecases\(ctx: dict\[str, Any\]\) -> dict\[str, Any\]:/);
  assert.match(main, /try:/); // branch → try/except
  assert.match(main, /except Exception as exc:/);
  assert.match(main, /report\["errors"\]\.append/);

  assert.match(main, /def run_output_deliver\(ctx: dict\[str, Any\]\) -> dict\[str, Any\]:/);
  assert.match(main, /_write_target\(target, ctx\)/); // output → write/save
});

test('generated main.py is a runnable, well-formed Python module', (t) => {
  const { files } = generate({ spec: sampleSpec(), workflow: fullWorkflow() });
  const main = files['main.py'];

  // PEP 8 style signals
  assert.match(main, /\n\n\ndef /); // two blank lines before top-level defs
  assert.match(main, /"""Generated workflow executor/); // module docstring
  assert.ok(!/\t/.test(main), 'no tab indentation');

  // The executor wiring: registry in topological order + main() runner.
  const registryOrder = [...main.matchAll(/"function_name": "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(registryOrder, [
    'run_input_collect',
    'run_agent_goal',
    'run_tool_constraints',
    'run_branch_edgecases',
    'run_tool_validation',
    'run_output_deliver',
  ]);
  assert.match(main, /^def main\(continue_on_error: bool = False\) -> dict\[str, Any\]:/m);
  assert.match(main, /ctx\[node\["id"\]\] = function\(ctx\)/);
  assert.match(main, /if __name__ == "__main__":/);

  assertPythonValid(t, main, 'main.py');
});

test('generated pytest suite covers every node type and compiles', (t) => {
  const { files } = generate({ spec: sampleSpec(), workflow: fullWorkflow() });
  const tests = files['tests/test_workflow.py'];

  assert.match(tests, /^import pytest$/m);
  assert.match(tests, /^import main$/m);
  assert.match(tests, /import unittest\.mock as mock/);

  for (const expected of [
    'test_node_registry_is_well_formed',
    'test_main_runs_nodes_in_topological_order',
    'test_load_source_reads_files_and_passes_literals',
    'test_input_node_loads_every_source',
    'test_agent_node_returns_openai_message_content',
    'test_tool_nodes_report_rule_results',
    'test_branch_nodes_catch_exceptions',
    'test_output_nodes_deliver_to_targets',
  ]) {
    assert.ok(tests.includes(expected), `missing test ${expected}`);
  }
  assert.match(tests, /monkeypatch\.setattr\(main, "openai", fake_openai\)/); // LLM client mocked

  assertPythonValid(t, tests, 'tests/test_workflow.py');
});

test('requirements.txt and .env.example reflect the providers in use', () => {
  const { files } = generate({ spec: sampleSpec(), workflow: fullWorkflow() });
  assert.match(files['requirements.txt'], /^openai>=1\.40\.0$/m);
  assert.match(files['requirements.txt'], /^pytest>=8\.0\.0$/m);
  assert.ok(!files['requirements.txt'].includes('anthropic'));
  assert.match(files['.env.example'], /^OPENAI_API_KEY=$/m);
  assert.ok(!files['.env.example'].includes('ANTHROPIC_API_KEY'));

  // A workflow without agent nodes must not depend on any LLM SDK.
  const kept = fullWorkflow().nodes.filter((n) => n.type !== 'agent');
  const keptIds = new Set(kept.map((n) => n.id));
  const noAgents = {
    id: 'wf',
    name: 'no agents',
    nodes: kept.map((n) => ({ ...n, dependsOn: (n.dependsOn ?? []).filter((d) => keptIds.has(d)) })),
  };
  const lean = generate({ workflow: noAgents });
  assert.ok(!lean.files['main.py'].includes('import openai'));
  assert.ok(!lean.files['requirements.txt'].includes('openai'));
  assert.ok(!lean.files['requirements.txt'].includes('anthropic'));
  assertPythonValid({ skip: () => {} }, lean.files['main.py'], 'lean main.py');
});

test('anthropic provider generates anthropic client code', () => {
  const workflow = fullWorkflow();
  workflow.nodes[1] = {
    ...workflow.nodes[1],
    config: { provider: 'anthropic', objective: 'draft the newsletter' },
  };
  const { files } = generate({ spec: sampleSpec(), workflow });

  assert.match(files['main.py'], /anthropic\.Anthropic\(api_key=os\.environ\.get\("ANTHROPIC_API_KEY"\)\)/);
  assert.match(files['main.py'], /messages\.create\(/);
  assert.ok(!files['main.py'].includes('import openai'));
  assert.match(files['requirements.txt'], /^anthropic>=0\.34\.0$/m);
  assert.ok(!files['requirements.txt'].includes('openai'));
  assert.match(files['.env.example'], /^ANTHROPIC_API_KEY=$/m);
  assert.match(files['tests/test_workflow.py'], /test_agent_node_returns_anthropic_text/);
  assertPythonValid({ skip: () => {} }, files['main.py'], 'anthropic main.py');
});

test('agent node config (model, temperature, system prompt) is honored', () => {
  const workflow = fullWorkflow();
  workflow.nodes[1] = {
    ...workflow.nodes[1],
    config: { objective: 'draft', model: 'gpt-4.1', temperature: 0.2, systemPrompt: 'You are a terse editor.' },
  };
  const { files } = generate({ workflow });
  const main = files['main.py'];
  assert.match(main, /model="gpt-4\.1"/);
  assert.match(main, /temperature=0\.2/);
  assert.match(main, /"content": "You are a terse editor\."/);
});

test('node ids sanitize to valid, collision-free Python identifiers', () => {
  const workflow = {
    id: 'wf',
    name: 'collisions',
    nodes: [
      { id: 'input.collect', type: 'input', name: 'A', dependsOn: [] },
      { id: 'input_collect', type: 'input', name: 'B', dependsOn: [] }, // collides after sanitize
      { id: '3d-print', type: 'tool', name: 'C', dependsOn: [] }, // starts with a digit
      { id: '!!!', type: 'output', name: 'D', dependsOn: [] },
    ],
  };
  const { files } = generate({ workflow });
  const main = files['main.py'];
  assert.match(main, /def run_input_collect\(/);
  assert.match(main, /def run_input_collect_2\(/);
  assert.match(main, /def run_node_3d_print\(/);
  assert.match(main, /def run_node\(/);
  assertPythonValid({ skip: () => {} }, main, 'collision main.py');
});

test('spec metadata (goal, inputs, outputs) flows into docs', () => {
  const { files } = generate({ spec: sampleSpec(), workflow: fullWorkflow() });
  assert.match(files['main.py'], /Spec goal: build a weekly newsletter from my starred repos/);
  assert.match(files['README.md'], /build a weekly newsletter from my starred repos/);
  assert.match(files['README.md'], /- github starred repos/);
  assert.match(files['README.md'], /- markdown digest/);
  assert.match(files['README.md'], /\| input\.collect \| input \| Collect inputs \| `run_input_collect` \|/);
});

test('generation is deterministic for the same inputs', () => {
  const a = generate({ spec: sampleSpec(), workflow: fullWorkflow() });
  const b = generate({ spec: sampleSpec(), workflow: fullWorkflow() });
  assert.deepEqual(a, b);
});

test('invalid workflows are rejected with a descriptive error', () => {
  assert.throws(() => generate({ workflow: { id: 'x', name: 'x', nodes: [] } }), /EMPTY/);
  const cyclic = {
    id: 'x',
    name: 'x',
    nodes: [
      { id: 'a', type: 'agent', name: 'A', dependsOn: ['b'] },
      { id: 'b', type: 'agent', name: 'B', dependsOn: ['a'] },
    ],
  };
  assert.throws(() => generate({ workflow: cyclic }), /CYCLE/);
  assert.throws(() => generate({}), /NOT_AN_OBJECT/);
  assert.throws(() => generate(), /NOT_AN_OBJECT/);
});

test('minimal input -> agent -> output chain still generates a working project', (t) => {
  const minimal = {
    id: 'wf_min',
    name: 'Minimal',
    nodes: [
      { id: 'input.collect', type: 'input', name: 'Collect inputs', config: { sources: ['data.csv'] }, dependsOn: [] },
      { id: 'agent.goal', type: 'agent', name: 'Summarize', config: { objective: 'summarize the data' }, dependsOn: ['input.collect'] },
      { id: 'output.deliver', type: 'output', name: 'Emit outputs', config: { targets: ['summary.md'] }, dependsOn: ['agent.goal'] },
    ],
  };
  const { files, summary } = generate({ workflow: minimal });
  assert.equal(summary, 'Generated 8 files, 1 agent, 0 tools');
  assert.match(files['main.py'], /sources: list\[str\] = \[\n    "data\.csv",\n\]/);
  assert.match(files['tests/test_workflow.py'], /test_output_nodes_deliver_to_targets/);
  assertPythonValid(t, files['main.py'], 'minimal main.py');
  assertPythonValid(t, files['tests/test_workflow.py'], 'minimal tests');
});

test('generated project ships typed interfaces (interfaces.py)', () => {
  const { files } = generate({ spec: sampleSpec(), workflow: fullWorkflow() });
  const types = files['interfaces.py'];
  for (const symbol of ['WorkflowContext', 'NodeSpec', 'WorkflowFn', 'InputNodeResult', 'ToolNodeResult', 'OutputNodeResult', 'NodeResult']) {
    assert.ok(types.includes(symbol), `interfaces.py must define ${symbol}`);
  }
  // The registry is typed and imports resolve from the generated project.
  const main = files['main.py'];
  assert.match(main, /from interfaces import NodeSpec, WorkflowContext, WorkflowFn/);
  assert.match(main, /NODES: list\[NodeSpec\] =/);
  assertPythonValid({ skip: () => {} }, types, 'interfaces.py');
});

test('agent nodes carry a retry + fallback handler', () => {
  const { files } = generate({ spec: sampleSpec(), workflow: fullWorkflow() });
  const main = files['main.py'];
  assert.match(main, /LLM_MAX_RETRIES = 2/);
  assert.match(main, /RETRY_BACKOFF_SECONDS = 2/);
  assert.match(main, /DEFAULT_AGENT_FALLBACK/);
  assert.match(main, /def _call_openai\(/);
  assert.match(main, /def _call_anthropic\(/);
  assert.match(main, /fallback=DEFAULT_AGENT_FALLBACK\.format\(attempts=LLM_MAX_RETRIES\)/);
  // A node with an explicit fallback pins its own text.
  const wf = fullWorkflow();
  wf.nodes[1] = { ...wf.nodes[1], config: { objective: 'draft', fallback: 'no LLM today' } };
  const explicit = generate({ workflow: wf });
  assert.match(explicit.files['main.py'], /fallback="no LLM today"/);
  // main() accepts the workflow-level continue-on-error fallback.
  assert.match(main, /def main\(continue_on_error: bool = False\)/);
  assert.match(main, /--continue-on-error/);
  assertPythonValid({ skip: () => {} }, main, 'main.py');
});

test('generated pytest suite covers fallback + continue-on-error + types', (t) => {
  const { files } = generate({ spec: sampleSpec(), workflow: fullWorkflow() });
  const tests = files['tests/test_workflow.py'];
  for (const expected of [
    'test_agent_node_falls_back_when_llm_unavailable',
    'test_main_continue_on_error_records_failures',
    'test_types_module_exposes_typed_interfaces',
  ]) {
    assert.ok(tests.includes(expected), `missing generated test ${expected}`);
  }
  assertPythonValid(t, tests, 'tests/test_workflow.py');
});

test('generated project ships GitHub Actions CI and .gitignore', () => {
  const { files } = generate({ spec: sampleSpec(), workflow: fullWorkflow() });
  const ci = files['.github/workflows/ci.yml'];
  assert.match(ci, /name: CI/);
  assert.match(ci, /actions\/checkout@v4/);
  assert.match(ci, /pip install -r requirements.txt/);
  assert.match(ci, /python -m pytest -q/);
  assert.match(files['.gitignore'], /__pycache__/);
  assert.match(files['.gitignore'], /\.venv/);
});
