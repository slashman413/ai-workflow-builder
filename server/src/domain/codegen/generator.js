/**
 * generator.js — compile a Spec + Workflow into an executable Python project.
 *
 * The generator is a pure transformation: in comes the workflow DAG (the same
 * shape specBuilder.js produces), out comes a complete, self-contained Python
 * project as a map of { relativePath → fileContents }. Nothing is written to
 * disk here — callers own the filesystem.
 *
 * Node type → Python function mapping:
 *   input   → data loading (file path, URL, API, or user input)
 *   agent   → LLM call via the openai (or anthropic) client, keyed off
 *             OPENAI_API_KEY / ANTHROPIC_API_KEY
 *   tool    → rule checks (constraints / success criteria)
 *   branch  → edge-case handling with try/except
 *   output  → deliver results (file, email draft, webhook)
 *
 * The generated `main.py` embeds a `NODES` registry in topological order and
 * a `main()` executor that threads results through a shared context dict, so
 * the compiled project is runnable as-is and unit-testable with pytest.
 */

import { validateWorkflow } from '../workflow/validateWorkflow.js';
import { topoSort } from '../workflow/topoSort.js';

/** Default model per provider when a node does not pin one. */
const DEFAULT_MODELS = Object.freeze({
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
});

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';

/**
 * @param {import('./schema.js').CodegenInput} input
 * @returns {import('./schema.js').CodegenResult}
 */
export function generate({ spec = {}, workflow } = {}) {
  const validation = validateWorkflow(workflow);
  if (!validation.valid) {
    const detail = validation.errors.map((e) => `${e.code}: ${e.message}`).join('; ');
    throw new Error(`Cannot generate code for an invalid workflow: ${detail}`);
  }
  const sorted = topoSort(workflow);
  if (!sorted.ok) {
    throw new Error(`Cannot generate code for a cyclic workflow: ${sorted.cycle.join(', ')}`);
  }

  const plan = buildPlan(workflow, sorted.order);
  const providers = detectProviders(workflow.nodes);

  const files = {
    'main.py': renderMainPy({ workflow, spec, plan, providers }),
    'tests/test_workflow.py': renderTestsPy({ plan, providers }),
    'requirements.txt': renderRequirements(providers),
    'README.md': renderReadme({ workflow, spec, plan }),
    '.env.example': renderEnvExample(providers),
  };

  const agents = workflow.nodes.filter((n) => n.type === 'agent').length;
  const tools = workflow.nodes.filter((n) => n.type === 'tool').length;
  const summary = `Generated ${plural(Object.keys(files).length, 'file')}, ${plural(agents, 'agent')}, ${plural(tools, 'tool')}`;
  return { files, summary };
}

/* ---------------------------------------------------------------------------
 * Planning
 * ------------------------------------------------------------------------ */

/**
 * Compile every node to a Python function name, in topological order, with
 * collision-free identifiers (node ids like `input.collect` and `a_b` both
 * sanitize to the same base, so later duplicates get a numeric suffix).
 *
 * @param {import('../workflow/workflow.js').Workflow} workflow
 * @param {string[]} order
 * @returns {import('./schema.js').NodePlan}
 */
function buildPlan(workflow, order) {
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  const used = new Set();
  const entries = [];
  const functionByNodeId = new Map();
  for (const id of order) {
    const node = byId.get(id);
    let functionName = `run_${sanitizeIdentifier(id)}`;
    let suffix = 2;
    while (used.has(functionName)) functionName = `run_${sanitizeIdentifier(id)}_${suffix++}`;
    used.add(functionName);
    functionByNodeId.set(id, functionName);
    entries.push({ node, functionName });
  }
  return { entries, functionByNodeId, providers: detectProviders(workflow.nodes) };
}

/** Turn any node id into a valid, readable Python identifier base. */
function sanitizeIdentifier(id) {
  let cleaned = String(id)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!cleaned) cleaned = 'node';
  if (/^[0-9]/.test(cleaned)) cleaned = `node_${cleaned}`;
  return cleaned;
}

/** Which LLM provider modules does this workflow need? */
function detectProviders(nodes) {
  const providers = new Set();
  for (const node of nodes) {
    if (node.type !== 'agent') continue;
    const provider = node.config?.provider === 'anthropic' ? 'anthropic' : 'openai';
    providers.add(provider);
  }
  return providers;
}

/* ---------------------------------------------------------------------------
 * Python rendering
 * ------------------------------------------------------------------------ */

/** Render a JS string as a Python string literal (JSON escapes are valid Python). */
function pyString(value) {
  return JSON.stringify(String(value));
}

/** Render an arbitrary JS config value as a Python literal. */
function pyLiteral(value) {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : '0';
  if (typeof value === 'string') return pyString(value);
  if (Array.isArray(value)) return `[${value.map(pyLiteral).join(', ')}]`;
  if (typeof value === 'object') {
    const pairs = Object.entries(value).map(([k, v]) => `${pyString(k)}: ${pyLiteral(v)}`);
    return `{${pairs.join(', ')}}`;
  }
  return pyString(String(value));
}

/** Render a list of strings as a Python list literal (one per line, PEP 8). */
function pyStringList(items) {
  if (!items || items.length === 0) return '[]';
  const inner = items.map((item) => `    ${pyString(item)},`).join('\n');
  return `[\n${inner}\n]`;
}

/** Keep docstrings inside an 88-char budget so generated code stays PEP 8. */
function clip(text, max = 72) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}...`;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function renderMainPy({ workflow, spec, plan, providers }) {
  const workflowName = workflow.name || workflow.id || 'workflow';
  const goal = spec.goal || '';
  const providerImports = [...providers].sort().map((p) => `import ${p}`).join('\n');
  const functions = plan.entries.map((entry) => renderNodeFunction(entry)).join('\n\n');
  const registry = renderNodeRegistry(plan.entries);

  return String.raw`"""Generated workflow executor — ${workflowName}.

Spec goal: ${goal}
Generated by ai-workflow-builder. Regenerate from the builder instead of
editing this file by hand.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import urllib.request
from pathlib import Path
from typing import Any

${providerImports}

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("workflow")

OUTPUTS_DIR = Path("outputs")


def _serialize(value: Any) -> str:
    """Best-effort JSON serialization of any node result."""
    return json.dumps(value, ensure_ascii=False, indent=2, default=str)


def _load_source(source: str) -> Any:
    """Load one input source: URL, existing file path, or literal value."""
    if source.startswith(("http://", "https://")):
        with urllib.request.urlopen(source, timeout=30) as response:
            return response.read().decode("utf-8", errors="replace")
    if os.path.exists(source):
        return Path(source).read_text(encoding="utf-8")
    return source


def _build_prompt(objective: str, context: str) -> str:
    """Compose the LLM prompt from the node objective and current context."""
    return (
        "Objective: {}\n\n"
        "Context so far:\n{}\n\n"
        "Produce the best possible result for the objective."
    ).format(objective, context)


def _check_rule(rule: str, ctx: dict[str, Any]) -> bool:
    """Heuristic rule check: every significant word of the rule is present."""
    text = _serialize(ctx).lower()
    words = [word for word in re.split(r"\W+", rule.lower()) if len(word) > 3]
    return all(word in text for word in words)


def _write_target(target: str, ctx: dict[str, Any]) -> str:
    """Deliver results to a file, an email draft, or a webhook."""
    payload = _serialize(ctx)
    slug = re.sub(r"[^a-z0-9]+", "-", target.lower()).strip("-") or "output"
    if target.startswith(("http://", "https://")):
        request = urllib.request.Request(
            target,
            data=json.dumps({"target": target, "payload": json.loads(payload)}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            return "webhook {} -> {}".format(target, response.status)
    OUTPUTS_DIR.mkdir(exist_ok=True)
    if "@" in target:
        path = OUTPUTS_DIR / "{}.eml".format(slug)
        path.write_text("To: {}\nSubject: Workflow result\n\n{}\n".format(target, payload), encoding="utf-8")
        return "email draft written to {}".format(path)
    path = OUTPUTS_DIR / "{}.json".format(slug)
    path.write_text(payload, encoding="utf-8")
    return "file written to {}".format(path)


${functions}


# Node registry — plain data so tests can introspect the workflow graph.
NODES: list[dict[str, Any]] = [${registry}]


def main() -> dict[str, Any]:
    """Execute every node in topological order, sharing results through ctx."""
    ctx: dict[str, Any] = {}
    for node in NODES:
        function = globals()[node["function_name"]]
        logger.info("running %s (%s)", node["id"], node["type"])
        try:
            ctx[node["id"]] = function(ctx)
        except Exception as exc:  # noqa: BLE001
            logger.exception("node %s failed", node["id"])
            raise SystemExit("workflow aborted at {}: {}".format(node["id"], exc)) from exc
    return ctx


if __name__ == "__main__":
    result = main()
    if "--json" in sys.argv:
        print(_serialize(result))
    else:
        logger.info("workflow finished")
`;
}

/** Render one node as a Python function. */
function renderNodeFunction(entry) {
  const { node } = entry;
  switch (node.type) {
    case 'input':
      return renderInputFn(entry);
    case 'agent':
      return renderAgentFn(entry);
    case 'tool':
      return renderToolFn(entry);
    case 'branch':
      return renderBranchFn(entry);
    case 'output':
      return renderOutputFn(entry);
    default:
      throw new Error(`Cannot generate code for node "${node.id}": unknown type "${node.type}".`);
  }
}

function renderInputFn(entry) {
  const { node, functionName } = entry;
  const config = node.config ?? {};
  const sources = Array.isArray(config.sources) ? config.sources : [];
  const doc = clip(`${node.name || 'Collect inputs'}.`);
  const collectLine =
    config.mode === 'user'
      ? `        collected[source] = input("Provide a value for {}: ".format(source))`
      : `        collected[source] = _load_source(source)`;
  return String.raw`def ${functionName}(ctx: dict[str, Any]) -> dict[str, Any]:
    """${doc}"""
    sources: list[str] = ${pyStringList(sources)}
    collected: dict[str, Any] = {}
    for source in sources:
${collectLine}
    logger.info("input node %s loaded %d sources", ${pyString(node.id)}, len(collected))
    return collected`;
}

function renderAgentFn(entry) {
  const { node, functionName } = entry;
  const config = node.config ?? {};
  const provider = config.provider === 'anthropic' ? 'anthropic' : 'openai';
  const objective = config.objective || node.name || 'achieve the goal';
  const doc = clip(`${node.name || 'Agent'}: ${objective}.`);
  const model = config.model ? pyString(config.model) : `os.environ.get("OPENAI_MODEL", ${pyString(DEFAULT_MODELS.openai)})`;
  const temperature = Number.isFinite(config.temperature) ? String(config.temperature) : String(DEFAULT_TEMPERATURE);
  const systemPrompt = pyString(config.systemPrompt || DEFAULT_SYSTEM_PROMPT);
  const promptLines = `    prompt = _build_prompt(
        objective=${pyString(objective)},
        context=_serialize(ctx),
    )`;

  if (provider === 'anthropic') {
    const anthropicModel =
      config.model ? pyString(config.model) : `os.environ.get("ANTHROPIC_MODEL", ${pyString(DEFAULT_MODELS.anthropic)})`;
    return String.raw`def ${functionName}(ctx: dict[str, Any]) -> str:
    """${doc}"""
${promptLines}
    client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
    response = client.messages.create(
        model=${anthropicModel},
        max_tokens=${config.maxTokens ?? 1024},
        messages=[{"role": "user", "content": prompt}],
    )
    content = "".join(getattr(part, "text", "") for part in response.content)
    logger.info("agent node %s returned %d characters", ${pyString(node.id)}, len(content))
    return content`;
  }

  return String.raw`def ${functionName}(ctx: dict[str, Any]) -> str:
    """${doc}"""
${promptLines}
    client = openai.OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    response = client.chat.completions.create(
        model=${model},
        messages=[
            {"role": "system", "content": ${systemPrompt}},
            {"role": "user", "content": prompt},
        ],
        temperature=${temperature},
    )
    content = response.choices[0].message.content or ""
    logger.info("agent node %s returned %d characters", ${pyString(node.id)}, len(content))
    return content`;
}

function renderToolFn(entry) {
  const { node, functionName } = entry;
  const config = node.config ?? {};
  const rules = Array.isArray(config.constraints)
    ? config.constraints
    : Array.isArray(config.criteria)
      ? config.criteria
      : [];
  const kind = config.constraints ? 'constraint' : 'criterion';
  const doc = clip(`${node.name || 'Check rules'}.`);
  return String.raw`def ${functionName}(ctx: dict[str, Any]) -> dict[str, Any]:
    """${doc}"""
    rules: list[str] = ${pyStringList(rules)}
    results: dict[str, bool] = {}
    for rule in rules:
        results[rule] = _check_rule(rule, ctx)
    logger.info("tool node %s checked %d ${kind}s", ${pyString(node.id)}, len(results))
    return {"results": results, "passed": all(results.values())}`;
}

function renderBranchFn(entry) {
  const { node, functionName } = entry;
  const config = node.config ?? {};
  const cases = Array.isArray(config.cases) ? config.cases : [];
  const doc = clip(`${node.name || 'Handle edge cases'}.`);
  return String.raw`def ${functionName}(ctx: dict[str, Any]) -> dict[str, Any]:
    """${doc}"""
    cases: list[str] = ${pyStringList(cases)}
    report: dict[str, Any] = {"node_id": ${pyString(node.id)}, "errors": [], "warnings": []}
    try:
        for case in cases:
            if _check_rule(case, ctx):
                report["warnings"].append("edge case detected: {}".format(case))
    except Exception as exc:  # noqa: BLE001
        report["errors"].append("{}: {}".format(type(exc).__name__, exc))
    logger.info(
        "branch node %s reported %d errors, %d warnings",
        ${pyString(node.id)},
        len(report["errors"]),
        len(report["warnings"]),
    )
    return report`;
}

function renderOutputFn(entry) {
  const { node, functionName } = entry;
  const config = node.config ?? {};
  const targets = Array.isArray(config.targets) ? config.targets : [];
  const doc = clip(`${node.name || 'Emit outputs'}.`);
  return String.raw`def ${functionName}(ctx: dict[str, Any]) -> dict[str, Any]:
    """${doc}"""
    targets: list[str] = ${pyStringList(targets)}
    delivered: dict[str, str] = {}
    for target in targets:
        delivered[target] = _write_target(target, ctx)
    logger.info("output node %s delivered %d targets", ${pyString(node.id)}, len(delivered))
    return delivered`;
}

/** Render the NODES registry as a Python list literal (one node per line). */
function renderNodeRegistry(entries) {
  return entries
    .map((entry) => {
      const { node, functionName } = entry;
      return `\n    {\n        "id": ${pyString(node.id)},\n        "type": ${pyString(node.type)},\n        "name": ${pyString(node.name || node.id)},\n        "function_name": ${pyString(functionName)},\n        "config": ${pyLiteral(node.config ?? {})},\n    },`;
    })
    .join('');
}

/* ---------------------------------------------------------------------------
 * tests/test_workflow.py
 * ------------------------------------------------------------------------ */

function renderTestsPy({ plan, providers }) {
  const tests = [];

  tests.push(`def test_node_registry_is_well_formed() -> None:
    """Every NODES entry is plain data with a resolvable function."""
    assert len(main.NODES) >= 1
    for node in main.NODES:
        assert {"id", "type", "name", "function_name", "config"} <= set(node)
        assert callable(getattr(main, node["function_name"], None))


def test_main_runs_nodes_in_topological_order(monkeypatch: pytest.MonkeyPatch) -> None:
    """main() executes every node function once, in registry order."""
    calls: list[str] = []
    for node in main.NODES:
        function_name = node["function_name"]

        def spy(ctx: dict[str, Any], _name: str = function_name) -> dict[str, Any]:
            calls.append(_name)
            return {"spied": _name}

        monkeypatch.setattr(main, function_name, spy)
    main.main()
    assert calls == [node["function_name"] for node in main.NODES]


def test_serialize_round_trips_values() -> None:
    """_serialize produces parseable JSON for mixed values."""
    payload = main._serialize({"a": 1, "b": [1, 2, 3], "c": {"deep": True}})
    assert json.loads(payload)["c"]["deep"] is True


def test_load_source_reads_files_and_passes_literals(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """_load_source reads local files and passes non-file values through."""
    data_file = tmp_path / "input.txt"
    data_file.write_text("file contents", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    assert main._load_source("input.txt") == "file contents"
    assert main._load_source("no such file anywhere") == "no such file anywhere"`);

  if (plan.entries.some((e) => e.node.type === 'input')) {
    tests.push(`

def test_input_node_loads_every_source(monkeypatch: pytest.MonkeyPatch) -> None:
    """Input nodes resolve every configured source."""
    function = node_function("input")
    seen: list[str] = []
    monkeypatch.setattr(main, "_load_source", lambda source: seen.append(source) or "data:{}".format(source))
    result = function({})
    assert list(result) == node_config("input").get("sources", [])
    assert all(value.startswith("data:") for value in result.values())`);
  }

  if (providers.has('openai')) {
    tests.push(`

def test_agent_node_returns_openai_message_content(monkeypatch: pytest.MonkeyPatch) -> None:
    """Agent nodes call OpenAI and surface the assistant's message."""
    fake_openai = mock.Mock()
    fake_openai.OpenAI.return_value.chat.completions.create.return_value = fake_openai_response("agent answer")
    monkeypatch.setattr(main, "openai", fake_openai)
    result = node_function("agent")({})
    assert result == "agent answer"`);
  }

  if (providers.has('anthropic')) {
    tests.push(`

def test_agent_node_returns_anthropic_text(monkeypatch: pytest.MonkeyPatch) -> None:
    """Anthropic-backed agent nodes return the concatenated text parts."""
    text_part = mock.Mock()
    text_part.text = "claude answer"
    fake_client = mock.Mock()
    fake_client.messages.create.return_value.content = [text_part]
    fake_anthropic = mock.Mock()
    fake_anthropic.Anthropic.return_value = fake_client
    monkeypatch.setattr(main, "anthropic", fake_anthropic)
    result = node_function("agent")({})
    assert result == "claude answer"`);
  }

  if (plan.entries.some((e) => e.node.type === 'tool')) {
    tests.push(`

def test_tool_nodes_report_rule_results() -> None:
    """Tool nodes evaluate every rule and summarize pass/fail."""
    result = node_function("tool")({})
    assert isinstance(result, dict)
    assert "results" in result and "passed" in result
    assert isinstance(result["passed"], bool)`);
  }

  if (plan.entries.some((e) => e.node.type === 'branch')) {
    tests.push(`

def test_branch_nodes_catch_exceptions(monkeypatch: pytest.MonkeyPatch) -> None:
    """Branch nodes convert raised exceptions into error reports."""
    if not node_config("branch").get("cases"):
        pytest.skip("branch node has no cases")

    def boom(rule: str, ctx: dict[str, Any]) -> bool:
        raise RuntimeError("boom")

    monkeypatch.setattr(main, "_check_rule", boom)
    report = node_function("branch")({})
    assert report["errors"], "expected at least one captured error"`);
  }

  if (plan.entries.some((e) => e.node.type === 'output')) {
    tests.push(`

def test_output_nodes_deliver_to_targets(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Output nodes persist results to outputs/ without hitting the network."""
    function = node_function("output")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(main, "OUTPUTS_DIR", tmp_path / "outputs")
    fake_response = mock.Mock()
    fake_response.status = 200
    monkeypatch.setattr(main.urllib.request, "urlopen", lambda *args, **kwargs: fake_response)
    result = function({})
    assert isinstance(result, dict)
    assert main.OUTPUTS_DIR.exists()`);
  }

  return String.raw`"""Tests for the generated workflow executor.

Run from the project root with:

    python -m pytest tests/
"""

import json
import unittest.mock as mock
from pathlib import Path
from typing import Any

import pytest

import main


def node_config(node_type: str) -> dict[str, Any]:
    """Return the config of the first node with the given type."""
    for node in main.NODES:
        if node["type"] == node_type:
            return node["config"]
    return {}


def node_function(node_type: str) -> Any:
    """Resolve the executable function for the first node of a type."""
    for node in main.NODES:
        if node["type"] == node_type:
            return getattr(main, node["function_name"])
    return None


def fake_openai_response(text: str) -> Any:
    """Build a fake OpenAI chat completion response."""
    message = mock.Mock()
    message.content = text
    choice = mock.Mock()
    choice.message = message
    response = mock.Mock()
    response.choices = [choice]
    return response

${tests.join('\n')}
`;
}

/* ---------------------------------------------------------------------------
 * requirements.txt / README.md / .env.example
 * ------------------------------------------------------------------------ */

function renderRequirements(providers) {
  const lines = ['# Generated by ai-workflow-builder — requires Python >= 3.10'];
  if (providers.has('openai')) lines.push('openai>=1.40.0');
  if (providers.has('anthropic')) lines.push('anthropic>=0.34.0');
  lines.push('pytest>=8.0.0');
  return `${lines.join('\n')}\n`;
}

function renderReadme({ workflow, spec, plan }) {
  const workflowName = workflow.name || workflow.id || 'workflow';
  const rows = plan.entries
    .map(
      (entry) =>
        `| ${entry.node.id} | ${entry.node.type} | ${entry.node.name || ''} | \`${entry.functionName}\` |`,
    )
    .join('\n');
  const inputs = (spec.inputs ?? []).map((i) => `- ${i}`).join('\n') || '- _(none)_';
  const outputs = (spec.outputs ?? []).map((o) => `- ${o}`).join('\n') || '- _(none)_';
  return String.raw`# ${workflowName}

Executable Python workflow generated by **ai-workflow-builder** from a
workflow spec. Do not edit generated files by hand — regenerate from the
builder instead.

## Spec

- **Goal**: ${spec.goal || '_(not provided)_'}
- **Inputs**:
${inputs}
- **Outputs**:
${outputs}

## Generated project layout

| File | Purpose |
|------|---------|
| \`main.py\` | Single-file workflow executor (run this) |
| \`tests/test_workflow.py\` | pytest suite covering every node type |
| \`requirements.txt\` | Python dependencies |
| \`.env.example\` | Environment variable template (API keys) |

## Node → function map

| Node | Type | Name | Python function |
|------|------|------|-----------------|
${rows}

Each function receives the shared context \`ctx\` (results of every upstream
node, keyed by node id) and returns its own result, which \`main()\` stores
back into \`ctx\`. The executor runs nodes in topological order.

## Setup

\`\`\`bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
\`\`\`

Then set your API keys in the environment:

\`\`\`bash
export OPENAI_API_KEY=sk-...        # required for agent nodes
# export ANTHROPIC_API_KEY=sk-ant-...  # only if an agent uses provider=anthropic
\`\`\`

## Run

\`\`\`bash
python main.py            # human-readable log output
python main.py --json     # machine-readable JSON on stdout
\`\`\`

Outputs land in \`outputs/\` (files and email drafts). Webhook targets POST
the serialized context to the given URL.

## Test

\`\`\`bash
pytest
\`\`\`

The suite mocks the LLM clients, so it runs without API keys or network
access.
`;
}

function renderEnvExample(providers) {
  const lines = ['# API keys — agent nodes read these from the environment.'];
  if (providers.has('openai')) {
    lines.push('OPENAI_API_KEY=', `OPENAI_MODEL=${DEFAULT_MODELS.openai}`);
  }
  if (providers.has('anthropic')) {
    lines.push('ANTHROPIC_API_KEY=', `ANTHROPIC_MODEL=${DEFAULT_MODELS.anthropic}`);
  }
  return `${lines.join('\n')}\n`;
}
