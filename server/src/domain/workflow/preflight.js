/**
 * preflight.js — static pre-flight validation of a Workflow DAG.
 *
 * The runtime validator (validateWorkflow.js) answers one question: "is this
 * graph well-formed enough to persist and run?" The pre-flight check answers
 * the harder question the product brief cares about: "is this graph actually
 * SHIPPABLE?" It layers structural analysis on top of the validator:
 *
 *   1. CYCLE / DANGLING_DEPENDENCY / …  — delegated to validateWorkflow (the
 *      runtime contract must never disagree with the pre-flight report).
 *   2. DISCONNECTED_NODE                — an island: a node with no incoming
 *      AND no outgoing edges while the graph has >1 node. It will never run
 *      and never feed anyone.
 *   3. UNREACHABLE_FROM_INPUT           — a node with no path from any input
 *      node (it can only ever see an empty context).
 *   4. NO_PATH_TO_OUTPUT                — a node that no output node consumes
 *      (its work is computed and thrown away).
 *   5. MISSING_PERSONA / UNBOUND_AGENT  — agent nodes must point at a persona
 *      the catalog actually knows. The catalog is injected (knownAgentIds) so
 *      this module stays a pure function of its inputs.
 *
 * The module is deliberately dependency-free: no repositories, no HTTP, no
 * crypto. Callers (HTTP adapter, publish service) supply the catalog ids.
 *
 * Output shape:
 *   { ok, errors, warnings, stats, executable }
 *     ok          — true when there are no ERRORS (warnings allowed)
 *     executable  — true when the DAG can run: ok AND every node is reachable
 *                   from an input AND every node reaches an output
 *     errors      — blocking findings (valid:false implies a broken graph)
 *     warnings    — non-blocking findings (disconnected islands, unbound agents)
 */

import { validateWorkflow } from '../workflow/validateWorkflow.js';
import { edgesOf, rootNodes, leafNodes, NODE_TYPES } from '../workflow/workflow.js';

/**
 * @typedef {Object} PreflightOptions
 * @property {Set<string>} [knownAgentIds] Known persona ids from the catalog.
 *   When provided (catalog installed), agent nodes referencing an unknown id
 *   become a blocking MISSING_PERSONA error and agent nodes without any
 *   persona binding become an UNBOUND_AGENT warning. When omitted, binding
 *   checks are skipped (the checker cannot know what the catalog contains).
 * @property {Set<string>} [knownLensIds] Known cognitive lens ids.
 *   A node's `config.lens_id` referencing an unknown lens is a blocking
 *   MISSING_LENS error.
 */

/**
 * Run the full pre-flight report.
 *
 * @param {import('../workflow/workflow.js').Workflow} workflow
 * @param {PreflightOptions} [opts]
 * @returns {{ ok: boolean, executable: boolean, errors: object[],
 *             warnings: object[], stats: object }}
 */
export function preFlightCheck(workflow, { knownAgentIds = null, knownLensIds = null } = {}) {
  const errors = [];
  const warnings = [];

  // 1. Structural contract — never diverge from the runtime validator.
  const structural = validateWorkflow(workflow);
  errors.push(...structural.errors);

  // The analysis below needs a resolvable graph; bail early with the
  // structural findings when the graph shape is unusable.
  const structurallyUsable =
    structural.valid &&
    Array.isArray(workflow?.nodes) &&
    workflow.nodes.length > 0 &&
    workflow.nodes.every((n) => n && typeof n.id === 'string' && n.id.trim());

  const stats = structurallyUsable ? computeStats(workflow) : { nodes: 0, edges: 0, byType: {}, depth: 0, components: 0 };

  if (!structurallyUsable) {
    return { ok: errors.length === 0, executable: false, errors, warnings, stats };
  }

  // 2. Reachability analysis over the resolved graph.
  const reach = reachability(workflow);
  if (workflow.nodes.length > 1) {
    for (const island of reach.islands) {
      warnings.push({
        code: 'DISCONNECTED_NODE',
        message: `Node "${island}" has no incoming or outgoing dependencies — it will never run and never feed another node.`,
        nodeId: island,
      });
    }
  }
  for (const node of workflow.nodes) {
    if (!reach.reachableFromInput.has(node.id)) {
      warnings.push({
        code: 'UNREACHABLE_FROM_INPUT',
        message: `Node "${node.id}" is not reachable from any input node — it starts with an empty context.`,
        nodeId: node.id,
      });
    }
    if (!reach.reachesOutput.has(node.id)) {
      warnings.push({
        code: 'NO_PATH_TO_OUTPUT',
        message: `Node "${node.id}" does not feed any output node — its work is discarded.`,
        nodeId: node.id,
      });
    }
  }

  // 3. Persona / lens binding checks (only when the catalog is known).
  if (knownAgentIds || knownLensIds) {
    for (const node of workflow.nodes) {
      if (node.type !== 'agent') continue;
      const cfg = node.config ?? {};
      const personaRef = cfg.persona_id ?? cfg.agentId ?? null;
      if (knownAgentIds && personaRef != null && !knownAgentIds.has(String(personaRef))) {
        errors.push({
          code: 'MISSING_PERSONA',
          message: `Agent node "${node.id}" references persona "${personaRef}" which is not in the installed catalog. Re-pin it from the marketplace.`,
          nodeId: node.id,
        });
      } else if (knownAgentIds && personaRef == null && knownAgentIds.size > 0) {
        warnings.push({
          code: 'UNBOUND_AGENT',
          message: `Agent node "${node.id}" has no persona binding — it will run with a generic prompt instead of a marketplace persona.`,
          nodeId: node.id,
        });
      }
      const lensRef = cfg.lens_id ?? null;
      if (knownLensIds && lensRef != null && !knownLensIds.has(String(lensRef))) {
        errors.push({
          code: 'MISSING_LENS',
          message: `Agent node "${node.id}" references lens "${lensRef}" which is not in the installed catalog.`,
          nodeId: node.id,
        });
      }
    }
  }

  // 4. Executability: a runnable graph needs every node connected to the
  //    pipeline. Islands and unreachable nodes are warnings for the editor,
  //    but for an EXPORT they are a defect the publisher refuses silently.
  const allConnected =
    reach.islands.length === 0 &&
    workflow.nodes.every((n) => reach.reachableFromInput.has(n.id) && reach.reachesOutput.has(n.id));

  return {
    ok: errors.length === 0,
    executable: errors.length === 0 && allConnected,
    errors,
    warnings,
    stats,
  };
}

/* ---------------------------------------------------------------------------
 * preflightWorkflow — the ENHANCED publish gate (Increment 4)
 *
 * Used by the publisher and the /workflow/preflight endpoint. Layers schema
 * parameter matching, tool-boundary checks (persona permissions from the
 * marketplace tools.json allow-list) and the security boundary reassertion on
 * top of the shared structural + reachability analysis.
 *
 * Signature (compat contract with PublishService):
 *   preflightWorkflow(workflow, { personas, tools })
 *     personas: [{ id, tools: string[], division, ... }]  (marketplace)
 *     tools:    [{ id, ... }]                             (tools.json allow-list)
 *
 * Returns: { valid, summary, errors, warnings, checks, security }
 *   valid    — no ERRORS (warnings allowed) — publish may proceed
 *   checks   — [{ name, passed, count }] per analysis category
 *   security — { boundary, executedCode, blocked } reassertion report
 *
 * Fail-closed rule: when the catalog context is empty (not synced), any agent
 * node that DECLARES tool usage fails with UNKNOWN_TOOL — a publish can never
 * silently ship a tool the platform cannot vouch for.
 * ------------------------------------------------------------------------ */

/**
 * Per-node-type config schema: required keys + allowed optional keys.
 * `types` drive CONFIG_TYPE checks; `enums` drive CONFIG_VALUE checks;
 * `minItems` drives CONFIG_VALUE on arrays that must not be empty.
 */
const NODE_CONFIG_SCHEMA = Object.freeze({
  input: {
    required: ['sources'],
    optional: ['mode'],
    types: { sources: 'string[]', mode: 'string' },
    minItems: { sources: 0 },
  },
  agent: {
    required: [],
    optional: [
      'objective', 'provider', 'model', 'temperature', 'systemPrompt', 'maxTokens',
      'fallback', 'personaId', 'persona_id', 'personaName', 'persona_name',
      'lensId', 'lens_id', 'catalog_version', 'tools', 'toolId',
    ],
    types: {
      objective: 'string', provider: 'string', model: 'string', temperature: 'number',
      systemPrompt: 'string', maxTokens: 'number', fallback: 'string',
      personaId: 'string', persona_id: 'string', lensId: 'string', lens_id: 'string',
      tools: 'string[]', toolId: 'string',
    },
    enums: { provider: ['openai', 'anthropic'] },
  },
  tool: {
    required: [],
    optional: ['constraints', 'criteria', 'toolId'],
    types: { constraints: 'string[]', criteria: 'string[]', toolId: 'string' },
  },
  branch: {
    required: [],
    optional: ['cases'],
    types: { cases: 'string[]' },
  },
  output: {
    required: ['targets'],
    optional: [],
    types: { targets: 'string[]' },
    minItems: { targets: 1 },
  },
});

/**
 * Config keys that would smuggle executable instructions into the build
 * pipeline — the security boundary. The server NEVER executes user code; a
 * workflow whose config carries these markers is refused at the gate.
 */
const FORBIDDEN_CONFIG_KEYS = Object.freeze([
  'code', 'script', 'command', 'shell', 'exec', 'eval', 'spawn', 'system',
  'sandbox', 'docker', 'container', 'binary',
]);
/** Value patterns that look like code injection attempts. */
const FORBIDDEN_VALUE_PATTERNS = [
  /(^|[^a-z])(system|exec|eval|popen|spawn|subprocess|child_process)\s*\(/i,
];

/** Is a config value plain JSON data (serializable)? */
function isSerializable(value) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return false;
  if (typeof value === 'object' && value !== null) {
    try {
      JSON.stringify(value);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

/** Does a value match a type spec ('string' | 'number' | 'string[]')? */
function typeMatches(value, spec) {
  if (spec === 'string') return typeof value === 'string';
  if (spec === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (spec === 'string[]') return Array.isArray(value) && value.every((v) => typeof v === 'string');
  return true;
}

/**
 * The full pre-flight gate (publish + /workflow/preflight).
 *
 * @param {import('../workflow/workflow.js').Workflow|null} workflow
 * @param {{ personas?: object[], tools?: object[] }} [catalog]
 * @returns {{ valid: boolean, summary: string, errors: object[],
 *             warnings: object[], checks: object, security: object }}
 */
export function preflightWorkflow(workflow, { personas = [], tools = [] } = {}) {
  const errors = [];
  const warnings = [];
  const personaIds = new Set(personas.map((p) => p.id).filter(Boolean));
  const toolIds = new Set(tools.map((t) => t.id).filter(Boolean));
  const personaByRef = (ref) => personas.find((p) => p.id === ref);

  // 1. Structural — cycles, dangling refs, duplicate ids (validateWorkflow).
  const structural = validateWorkflow(workflow);
  errors.push(...structural.errors);

  // 2. Reachability — islands and dead-end nodes (non-blocking warnings).
  let reachWarnings = 0;
  if (structural.valid && Array.isArray(workflow?.nodes) && workflow.nodes.length > 0) {
    const reach = reachability(workflow);
    if (workflow.nodes.length > 1) {
      for (const island of reach.islands) {
        warnings.push({
          code: 'DISCONNECTED_NODE',
          message: `Node "${island}" has no incoming or outgoing dependencies — it will never run and never feed another node.`,
          nodeId: island,
        });
        reachWarnings += 1;
      }
    }
    for (const node of workflow.nodes) {
      if (!reach.reachableFromInput.has(node.id)) {
        warnings.push({
          code: 'UNREACHABLE_FROM_INPUT',
          message: `Node "${node.id}" is not reachable from any input node — it starts with an empty context.`,
          nodeId: node.id,
        });
        reachWarnings += 1;
      }
      if (!reach.reachesOutput.has(node.id)) {
        warnings.push({
          code: 'NO_PATH_TO_OUTPUT',
          message: `Node "${node.id}" does not feed any output node — its work is discarded.`,
          nodeId: node.id,
        });
        reachWarnings += 1;
      }
    }
  }

  // 3. Schema parameter matching per node type.
  let schemaErrors = 0;
  let schemaWarnings = 0;
  if (Array.isArray(workflow?.nodes)) {
    for (const node of workflow.nodes) {
      if (!node || typeof node.id !== 'string') continue;
      if (node.config != null && (typeof node.config !== 'object' || Array.isArray(node.config))) {
        errors.push({ code: 'CONFIG_TYPE', message: `Node "${node.id}" config must be an object.`, nodeId: node.id });
        schemaErrors += 1;
        continue;
      }
      const schema = NODE_CONFIG_SCHEMA[node.type];
      if (!schema) continue; // type-level errors already reported
      const cfg = node.config ?? {};
      // Serializability first — undefined/function values are never accepted.
      for (const [key, value] of Object.entries(cfg)) {
        if (!isSerializable(value)) {
          errors.push({
            code: 'NON_SERIALIZABLE_CONFIG',
            message: `Node "${node.id}" config key "${key}" is not JSON-serializable (${typeof value}) — config must be plain data.`,
            nodeId: node.id,
          });
          schemaErrors += 1;
        }
      }
      // Missing required keys are ERRORS (a config without its required
      // parameters would generate a broken node).
      for (const key of schema.required) {
        const present = Array.isArray(cfg[key]) ? cfg[key].length > 0 : cfg[key] !== undefined;
        if (!present) {
          errors.push({
            code: 'MISSING_CONFIG',
            message: `Node "${node.id}" (${node.type}) is missing required config "${key}".`,
            nodeId: node.id,
          });
          schemaErrors += 1;
        }
      }
      // A tool node must have at least one rule to check.
      if (node.type === 'tool' && !Array.isArray(cfg.constraints) && !Array.isArray(cfg.criteria)) {
        errors.push({
          code: 'MISSING_CONFIG',
          message: `Tool node "${node.id}" needs config.constraints or config.criteria — a rule node with no rules would pass everything.`,
          nodeId: node.id,
        });
        schemaErrors += 1;
      }
      // Type + enum + minItems checks per declared schema.
      const types = schema.types ?? {};
      for (const [key, spec] of Object.entries(types)) {
        const value = cfg[key];
        if (value === undefined) continue; // missing handled above
        if (!typeMatches(value, spec)) {
          errors.push({
            code: 'CONFIG_TYPE',
            message: `Node "${node.id}" config "${key}" must be ${spec} (got ${Array.isArray(value) ? `array of ${typeof value[0]}` : typeof value}).`,
            nodeId: node.id,
          });
          schemaErrors += 1;
        }
      }
      for (const [key, allowed] of Object.entries(schema.enums ?? {})) {
        const value = cfg[key];
        if (value === undefined || allowed.includes(value)) continue;
        errors.push({
          code: 'CONFIG_VALUE',
          message: `Node "${node.id}" config "${key}" must be one of: ${allowed.join(', ')} (got "${value}").`,
          nodeId: node.id,
        });
        schemaErrors += 1;
      }
      for (const [key, min] of Object.entries(schema.minItems ?? {})) {
        const value = cfg[key];
        if (Array.isArray(value) && value.length < min) {
          errors.push({
            code: 'CONFIG_VALUE',
            message: `Node "${node.id}" config "${key}" must contain at least ${min} item${min === 1 ? '' : 's'}.`,
            nodeId: node.id,
          });
          schemaErrors += 1;
        }
      }
      // Unknown keys are WARNINGS (forward-compatible, generator ignores them).
      const allowed = new Set([...schema.required, ...schema.optional]);
      for (const key of Object.keys(cfg)) {
        if (!allowed.has(key)) {
          warnings.push({
            code: 'UNKNOWN_CONFIG_KEY',
            message: `Node "${node.id}" config key "${key}" is not in the ${node.type} schema — it will be ignored by the generator.`,
            nodeId: node.id,
          });
          schemaWarnings += 1;
        }
      }
    }
  }

  // 4. Persona binding + tool-boundary checks against the marketplace.
  let toolErrors = 0;
  if (Array.isArray(workflow?.nodes)) {
    for (const node of workflow.nodes) {
      if (!node) continue;
      const cfg = node.config ?? {};
      const personaRef = cfg.persona_id ?? cfg.personaId ?? null;
      if (personaRef != null) {
        if (!personaIds.has(String(personaRef))) {
          errors.push({
            code: 'MISSING_PERSONA',
            message: `Node "${node.id}" references persona "${personaRef}" which is not in the installed catalog. Re-pin it from the marketplace.`,
            nodeId: node.id,
          });
          toolErrors += 1;
        }
      } else if (node.type === 'agent' && personaIds.size > 0) {
        // Catalog is known and the agent chose no persona — worth a warning:
        // it will run with a generic prompt instead of a marketplace persona.
        warnings.push({
          code: 'UNBOUND_AGENT',
          message: `Agent node "${node.id}" has no persona binding — it will run with a generic prompt instead of a marketplace persona.`,
          nodeId: node.id,
        });
      }
      const persona = personaRef != null ? personaByRef(String(personaRef)) : null;
      const declaredTools = [
        ...(Array.isArray(cfg.tools) ? cfg.tools.map(String) : []),
        ...(typeof cfg.toolId === 'string' ? [cfg.toolId] : []),
      ];
      for (const tool of declaredTools) {
        if (!toolIds.has(tool)) {
          errors.push({
            code: 'UNKNOWN_TOOL',
            message: `Node "${node.id}" references tool "${tool}" which is not in the marketplace allow-list${toolIds.size === 0 ? ' (catalog not synced — publish is blocked until it is)' : ''}.`,
            nodeId: node.id,
          });
          toolErrors += 1;
        } else if (persona && !(persona.tools ?? []).includes(tool)) {
          errors.push({
            code: 'TOOL_NOT_PERMITTED',
            message: `Node "${node.id}" uses tool "${tool}" which persona "${personaRef}" does not permit.`,
            nodeId: node.id,
          });
          toolErrors += 1;
        }
      }
      // Catalog drift defense-in-depth: the persona's own tags must resolve.
      if (persona) {
        for (const tag of persona.tools ?? []) {
          if (!toolIds.has(String(tag))) {
            warnings.push({
              code: 'CATALOG_TOOL_DRIFT',
              message: `Persona "${personaRef}" references tool "${tag}" that is missing from the allow-list (catalog drift).`,
              nodeId: node.id,
            });
          }
        }
      }
    }
  }

  // 5. Security boundary reassertion — no executable payload markers.
  const blocked = [];
  if (Array.isArray(workflow?.nodes)) {
    for (const node of workflow.nodes) {
      if (!node || node.config == null) continue;
      const hits = [];
      for (const [key, value] of Object.entries(node.config)) {
        if (FORBIDDEN_CONFIG_KEYS.includes(String(key).toLowerCase())) {
          hits.push(`key "${key}"`);
        }
        if (typeof value === 'string' && FORBIDDEN_VALUE_PATTERNS.some((re) => re.test(value))) {
          hits.push(`value of "${key}"`);
        }
      }
      if (hits.length > 0) {
        errors.push({
          code: 'SECURITY_BOUNDARY',
          message: `Node "${node.id}" violates the security boundary (${hits.join(', ')}) — executable payloads are never accepted.`,
          nodeId: node.id,
        });
        blocked.push(node.id);
      }
    }
  }

  const checks = [
    { name: 'structural', passed: structural.errors.length === 0, count: structural.errors.length },
    { name: 'reachability', passed: reachWarnings === 0, count: reachWarnings },
    { name: 'schema', passed: schemaErrors === 0, count: schemaErrors + schemaWarnings },
    { name: 'toolBoundary', passed: toolErrors === 0, count: toolErrors },
    { name: 'security', passed: blocked.length === 0, count: blocked.length },
  ];
  const security = {
    executedCode: false,
    boundary: 'static-only',
    blocked,
  };
  const valid = errors.length === 0;
  const summary = valid
    ? `ok: ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`
    : `Pre-flight failed: ${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`;

  return { valid, summary, errors, warnings, checks, security };
}

/* ---------------------------------------------------------------------------
 * Graph analysis helpers (pure)
 * ------------------------------------------------------------------------ */

/**
 * Compute the reachability summary of the DAG:
 *   - reachableFromInput: node ids with a directed path from any input node
 *   - reachesOutput:      node ids with a directed path to any output node
 *   - islands:            node ids with no incoming AND no outgoing edges
 */
function reachability(workflow) {
  const nodes = workflow.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outgoing = new Map(nodes.map((n) => [n.id, []]));
  const incoming = new Map(nodes.map((n) => [n.id, []]));
  for (const { from, to } of edgesOf(workflow)) {
    if (byId.has(from) && byId.has(to)) {
      outgoing.get(from).push(to);
      incoming.get(to).push(from);
    }
  }

  const islandCheck = (id) => outgoing.get(id).length === 0 && incoming.get(id).length === 0;

  const reachableFromInput = new Set();
  const stack = [...rootNodes(workflow).filter((n) => n.type === 'input').map((n) => n.id)];
  while (stack.length) {
    const id = stack.pop();
    if (reachableFromInput.has(id)) continue;
    reachableFromInput.add(id);
    for (const next of outgoing.get(id)) stack.push(next);
  }

  const reachesOutput = new Set();
  // Reverse walk from every output node.
  const outputIds = leafNodes(workflow).filter((n) => n.type === 'output').map((n) => n.id);
  const rev = new Map(nodes.map((n) => [n.id, []]));
  for (const [id, deps] of incoming) {
    for (const d of deps) rev.get(d).push(id);
  }
  const stack2 = [...outputIds];
  while (stack2.length) {
    const id = stack2.pop();
    if (reachesOutput.has(id)) continue;
    reachesOutput.add(id);
    for (const prev of incoming.get(id)) stack2.push(prev);
  }

  const islands = nodes.filter((n) => islandCheck(n.id) && nodes.length > 1).map((n) => n.id);
  return { reachableFromInput, reachesOutput, islands };
}

/** Aggregate graph statistics for the pre-flight report header. */
function computeStats(workflow) {
  const byType = {};
  for (const n of workflow.nodes) byType[n.type] = (byType[n.type] ?? 0) + 1;

  // Longest-path depth via memoized DFS over the dependency graph.
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  const depsOf = new Map(workflow.nodes.map((n) => [n.id, n.dependsOn ?? []]));
  const memo = new Map();
  const depthOf = (id) => {
    if (memo.has(id)) return memo.get(id);
    const deps = depsOf.get(id) ?? [];
    const d = deps.length ? Math.max(...deps.map(depthOf)) + 1 : 0;
    memo.set(id, d);
    return d;
  };
  const depth = Math.max(0, ...workflow.nodes.map((n) => depthOf(n.id)));

  // Connected components via union-find over the undirected edge set.
  const parent = new Map(workflow.nodes.map((n) => [n.id, n.id]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => parent.set(find(a), find(b));
  for (const { from, to } of edgesOf(workflow)) {
    if (byId.has(from) && byId.has(to)) union(from, to);
  }
  const components = new Set([...parent.keys()].map(find)).size;

  return {
    nodes: workflow.nodes.length,
    edges: edgesOf(workflow).length,
    byType,
    depth,
    components,
    nodeTypes: [...NODE_TYPES],
  };
}
