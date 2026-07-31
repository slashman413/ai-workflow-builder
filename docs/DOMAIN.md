# Domain model

The ubiquitous language of AI Workflow Builder. These terms mean the same thing
in code, docs, and UI.

## Aggregates & entities

### Project
The root a user works with. Bundles the raw prompt, the accumulating grill
answers, and the latest derived spec snapshot.

```
Project {
  id: string
  prompt: string                     // the original one-line goal
  answers: Record<questionId, text>  // grill answers gathered so far
  spec: Spec | null                  // derived snapshot (see below)
  createdAt, updatedAt: ISO string
}
```

`answers` + `prompt` are the **source of truth**; `spec` is always re-derivable
from them, so it can be regenerated at any time and never drifts.

### Spec
The structured contract produced by grilling. Everything downstream reads the
Spec, never the raw prompt.

```
Spec {
  goal: string
  why: string
  inputs: string[]
  outputs: string[]
  constraints: string[]
  successCriteria: string[]
  edgeCases: string[]
  ready: boolean                 // all *critical* dimensions covered
  openQuestions: string[]        // human-readable labels still open
}
```

### Workflow (aggregate)
A directed acyclic graph of agent steps. Protects two invariants: **unique node
ids** and **acyclicity**.

```
Workflow { id, name, nodes: WorkflowNode[] }
WorkflowNode {
  id: string
  type: 'input' | 'agent' | 'tool' | 'branch' | 'output'
  name: string
  config?: object
  dependsOn: string[]            // ids of upstream nodes; edges are derived
}
```

Edges are derived from `dependsOn` so the graph has a single source of truth.

## Spec dimensions (what "grill me" probes)

The grill engine interrogates a prompt across these dimensions. A dimension is
**covered** when either the prompt already signals it (keyword heuristic) or all
of its critical questions are answered.

| Dimension        | Critical? | Question asked when uncovered |
| ---------------- | --------- | ----------------------------- |
| `goal`           | ✅        | The single concrete outcome a run must produce |
| `inputs`         | ✅        | Exact inputs and where they come from |
| `outputs`        | ✅        | The exact artifact + format to emit |
| `success`        | ✅        | How you'd know a run was correct |
| `constraints`    | —         | Hard limits (cost, latency, data that can't leave) |
| `edge_cases`     | —         | Behaviour on missing/empty input or step failure |

A Spec is **ready** when every *critical* dimension is covered. Non-critical
gaps become warnings/`openQuestions`, not blockers — we ship when the essentials
are pinned.

## Domain events (conceptual)

Not yet emitted as messages, but these are the meaningful business facts the
system recognises, useful when an executor/event log is added later:

- `ProjectCreated`
- `AnswersRecorded`
- `SpecBecameReady`
- `WorkflowScaffolded`
- `WorkflowSaved`

## Invariants (enforced in code)

1. A prompt must be a non-empty string (`ProjectService.createProject`).
2. `answers` merge, never replace, across submissions.
3. A workflow node's `type` must be one of `NODE_TYPES`.
4. Node ids are unique within a workflow.
5. Every `dependsOn` reference resolves to an existing node; no self-dependency.
6. The dependency graph is acyclic (`topoSort` must succeed).
7. A workflow is only scaffolded from a **ready** spec unless `force` is passed.
