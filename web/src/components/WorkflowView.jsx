import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  addEdge,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../api/client.js';
import { DND_MIME } from './MarketplaceSidebar.jsx';

/**
 * WorkflowView.jsx — the interactive visual graph canvas (Increment 3).
 *
 * Upgraded from the read-only ordered list to a React Flow canvas:
 *   - nodes are draggable/connectable; edges encode `dependsOn`;
 *   - personas dropped from the Agent Marketplace embed IMMUTABLE references
 *     (`config.persona_id`, `config.lens_id`, `config.catalog_version`) —
 *     the node points at the catalog row, it never copies it;
 *   - every node shows a pinned catalog version badge when its persona came
 *     from a versioned catalog snapshot;
 *   - Save round-trips the graph back to the backend's workflow validator;
 *   - Simulate runs the SAFE mock-handler preview (no user code executes).
 *
 * Viewers get read-only canvas (pan/zoom/select); Architects+ can drag,
 * connect, save, and simulate.
 */

const shortRef = (v) => (v ? (v.startsWith('bundle-') ? 'bundle' : `${v.slice(0, 7)}…`) : '—');

/** Layered layout: x by dependency depth, y by index inside the layer. */
function layoutWorkflow(workflow) {
  const nodes = workflow.nodes ?? [];
  const depsOf = new Map(nodes.map((n) => [n.id, n.dependsOn ?? []]));
  const depth = new Map();
  const calc = (id) => {
    if (depth.has(id)) return depth.get(id);
    const deps = depsOf.get(id) ?? [];
    const d = deps.length ? Math.max(...deps.map(calc)) + 1 : 0;
    depth.set(id, d);
    return d;
  };
  nodes.forEach((n) => calc(n.id));

  const layers = new Map();
  nodes.forEach((n) => {
    const d = depth.get(n.id) ?? 0;
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d).push(n);
  });

  const rfNodes = nodes.map((n) => {
    const cfg = n.config ?? {};
    const d = depth.get(n.id) ?? 0;
    const idx = layers.get(d).indexOf(n);
    return {
      id: n.id,
      type: 'wfb',
      position: { x: d * 300 + 40, y: idx * 130 + 40 },
      data: {
        type: n.type,
        label: n.name ?? n.id,
        config: cfg,
        persona: cfg.persona_id
          ? { id: cfg.persona_id, name: cfg.persona_name ?? cfg.persona_id, emoji: cfg.persona_emoji ?? null }
          : null,
        lens: cfg.lens_id ? { id: cfg.lens_id, name: cfg.lens_name ?? cfg.lens_id } : null,
        version: cfg.catalog_version ?? null,
      },
    };
  });

  const rfEdges = nodes.flatMap((n) =>
    (n.dependsOn ?? []).map((src) => ({
      id: `e-${src}-${n.id}`,
      source: src,
      target: n.id,
      type: 'smoothstep',
      animated: true,
      markerEnd: { type: MarkerType.ArrowClosed },
    })),
  );

  return { rfNodes, rfEdges };
}

/** Round-trip the canvas back into the persisted Workflow aggregate. */
function toWorkflow(rfNodes, rfEdges, original) {
  return {
    id: original.id,
    name: original.name,
    nodes: rfNodes.map((n) => ({
      id: n.id,
      type: n.data.type,
      name: n.data.label,
      config: n.data.config ?? {},
      dependsOn: rfEdges.filter((e) => e.target === n.id).map((e) => e.source),
    })),
  };
}

/** Custom node: type badge, persona/lens refs, pinned version badge. */
function WorkflowNode({ data, selected }) {
  const { type, label, persona, lens, version, config } = data;
  const hasIncoming = type !== 'input';
  const hasOutgoing = type !== 'output';
  return (
    <div className={`wf-node wf-${type} ${selected ? 'selected' : ''}`}>
      {hasIncoming && <Handle type="target" position={Position.Left} className="wf-handle" />}
      <div className="wf-node-head">
        <span className="badge">{type}</span>
        <strong>{label}</strong>
      </div>
      {persona && (
        <div className="wf-node-ref" title={`persona_id: ${persona.id}`}>
          <span className="persona-emoji">{persona.emoji ?? '🤖'}</span>
          <span className="ref-name">{persona.name}</span>
          {version && <span className="ver-badge ok">{shortRef(version)}</span>}
        </div>
      )}
      {lens && (
        <div className="wf-node-lens" title={`lens_id: ${lens.id}`}>
          🔭 <span className="ref-name">{lens.name}</span>
        </div>
      )}
      {config && Object.keys(config).length > 0 && (
        <pre className="config wf-node-config">{JSON.stringify(config, null, 1).slice(0, 260)}</pre>
      )}
      {hasOutgoing && <Handle type="source" position={Position.Right} className="wf-handle" />}
    </div>
  );
}

const nodeTypes = { wfb: WorkflowNode };

function Canvas({ workflow, projectId, canEdit, onReset }) {
  const { screenToFlowPosition } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [simResult, setSimResult] = useState(null);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const workflowRef = useRef(workflow);

  // Re-sync the canvas whenever a (different) workflow is loaded.
  useEffect(() => {
    workflowRef.current = workflow;
    const { rfNodes, rfEdges } = layoutWorkflow(workflow);
    setNodes(rfNodes);
    setEdges(rfEdges);
    setSimResult(null);
    setMessage(null);
    setSelected(null);
  }, [workflow?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const guard = (fn) => async (...args) => {
    setError(null);
    try {
      await fn(...args);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onConnect = useCallback(
    (conn) => {
      if (!canEdit) return;
      setEdges((eds) => addEdge({ ...conn, type: 'smoothstep', animated: true, markerEnd: { type: MarkerType.ArrowClosed } }, eds));
    },
    [canEdit, setEdges],
  );

  const onDrop = useCallback(
    (e) => {
      if (!canEdit) return;
      e.preventDefault();
      const raw = e.dataTransfer.getData(DND_MIME);
      if (!raw) return;
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        return;
      }
      if (payload.kind !== 'persona' || !payload.personaId) return;
      const id = `agent-${Math.random().toString(36).slice(2, 8)}`;
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const config = {
        persona_id: payload.personaId,
        persona_name: payload.name,
        objective: payload.name,
      };
      if (payload.emoji) config.persona_emoji = payload.emoji;
      if (payload.lensId) {
        config.lens_id = payload.lensId;
        config.lens_name = payload.lensName ?? payload.lensId;
      }
      if (payload.version) config.catalog_version = payload.version;
      const newNode = {
        id,
        type: 'wfb',
        position,
        data: {
          type: 'agent',
          label: payload.name,
          config,
          persona: { id: payload.personaId, name: payload.name, emoji: payload.emoji ?? null },
          lens: payload.lensId ? { id: payload.lensId, name: payload.lensName ?? payload.lensId } : null,
          version: payload.version ?? null,
        },
      };
      setNodes((nds) => [...nds, newNode]);
      setMessage(`Dropped “${payload.name}” — persona_id ${payload.personaId} embedded.`);
    },
    [canEdit, screenToFlowPosition, setNodes],
  );

  const onDragOver = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onNodeClick = useCallback((_e, node) => setSelected(node), []);

  const save = guard(async () => {
    const wf = toWorkflow(nodes, edges, workflowRef.current);
    const saved = await api.saveWorkflow(projectId, wf);
    setMessage(`Saved — server validated ${saved.nodes.length} node${saved.nodes.length === 1 ? '' : 's'}.`);
  });

  const simulate = guard(async () => {
    const wf = toWorkflow(nodes, edges, workflowRef.current);
    setSimResult(await api.simulate(wf));
  });

  return (
    <section className="card canvas-card">
      <div className="canvas-head">
        <h2>Agent workflow canvas</h2>
        <span className="wf-name">{workflow.name}</span>
      </div>

      <div className="canvas-pane" onDrop={onDrop} onDragOver={onDragOver}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          nodesDraggable={canEdit}
          nodesConnectable={canEdit}
          elementsSelectable
          fitView
          fitViewOptions={{ padding: 0.25 }}
          minZoom={0.3}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
          <Controls />
          <MiniMap pannable zoomable nodeColor={(n) => (n.data?.type === 'agent' ? '#6ea8fe' : '#9aa0ab')} />
        </ReactFlow>
      </div>

      {canEdit && <p className="canvas-hint">Drop personas from the marketplace onto the canvas; drag between handles to wire dependencies.</p>}
      {!canEdit && <p className="readonly-note">Viewer — this canvas is read-only.</p>}
      {message && <p className="done">{message}</p>}
      {error && <div className="error" role="alert">{error}</div>}

      <div className="canvas-footer">
        {canEdit && (
          <>
            <button type="button" onClick={save}>Save workflow</button>
            <button type="button" className="ghost" onClick={simulate}>Simulate (safe preview)</button>
          </>
        )}
        <button type="button" className="ghost" onClick={onReset}>Start over</button>
      </div>

      {simResult && (
        <div className="sim-result">
          <h3>
            Simulation {simResult.success ? '✓' : '✗'} — {simResult.note ?? ''}
          </h3>
          {simResult.success && (
            <ol className="sim-steps">
              {simResult.steps.map((s) => (
                <li key={s.id}>
                  <strong>{s.id}</strong>
                  <pre className="config">{JSON.stringify(s.output, null, 1).slice(0, 300)}</pre>
                </li>
              ))}
            </ol>
          )}
          {!simResult.success && (
            <ul className="sim-errors">
              {simResult.errors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {selected && (
        <div className="node-inspector">
          <h3>Node: {selected.data.label}</h3>
          <dl>
            <dt>id</dt><dd><code>{selected.id}</code></dd>
            <dt>type</dt><dd><code>{selected.data.type}</code></dd>
            {selected.data.persona && (
              <>
                <dt>persona_id</dt><dd><code>{selected.data.persona.id}</code></dd>
              </>
            )}
            {selected.data.lens && (
              <>
                <dt>lens_id</dt><dd><code>{selected.data.lens.id}</code></dd>
              </>
            )}
            {selected.data.version && (
              <>
                <dt>catalog version</dt><dd><code>{selected.data.version}</code></dd>
              </>
            )}
          </dl>
        </div>
      )}
    </section>
  );
}

/** Provider wrapper so the canvas can use useReactFlow(). */
export function WorkflowView(props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

export { toWorkflow, layoutWorkflow };
