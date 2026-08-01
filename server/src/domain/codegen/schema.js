/**
 * schema.js — the code generator's contract: what goes in and what comes out.
 *
 * The codegen domain turns a Spec + Workflow (both pure data) into an
 * executable Python project (also pure data). Nothing here touches the
 * filesystem — callers decide where to write the generated files, which keeps
 * the generator trivially testable and side-effect free.
 */

/**
 * @typedef {Object} CodegenInput
 * @property {import('../spec/specBuilder.js').Spec} [spec]  The refined spec.
 *   Optional: the generator only needs it for metadata (goal, documentation).
 * @property {import('../workflow/workflow.js').Workflow} workflow  The DAG of
 *   nodes to compile. Must pass {@link ../workflow/validateWorkflow.js} —
 *   the generator throws otherwise.
 */

/**
 * @typedef {Object} CodegenResult
 * @property {Record<string, string>} files  Map of relative path (e.g.
 *   `main.py`, `tests/test_workflow.py`) → full file contents. Paths use
 *   forward slashes and are relative to the generated project root.
 * @property {string} summary  One-line human summary, e.g.
 *   `Generated 5 files, 3 agents, 2 tools`.
 */

/**
 * @typedef {Object} NodePlanEntry
 * @property {import('../workflow/workflow.js').WorkflowNode} node  The source node.
 * @property {string} functionName  Sanitized, collision-free Python function
 *   name compiled from the node id (e.g. `input.collect` → `run_input_collect`).
 */

/**
 * @typedef {Object} NodePlan
 * @property {NodePlanEntry[]} entries  One entry per node, in topological
 *   execution order (the order `main.py` will run them).
 * @property {Map<string, string>} functionByNodeId  Node id → function name.
 * @property {Set<string>} providers  Provider modules the generated project
 *   must depend on (`openai`, `anthropic`).
 */

/**
 * @typedef {Object} GeneratedMain
 * @property {string} module  Python module source for `main.py`.
 * @property {string} tests  Python test source for `tests/test_workflow.py`.
 * @property {string} requirements  Contents for `requirements.txt`.
 * @property {string} readme  Contents for `README.md`.
 * @property {string} envExample  Contents for `.env.example`.
 */

export {};
