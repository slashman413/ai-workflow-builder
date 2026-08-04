import React, { useMemo } from 'react';
import { ReactFlow, Background, BackgroundVariant, Controls, MiniMap, Handle, Position } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { layoutWorkflow } from '../WorkflowView.jsx';

/**
 * PipelineView.jsx — the live execution graph (read-only React Flow).
 *
 * Reuses the editor's deterministic layered layout; each node is colored by
 * its step status:
 *   queued (no step yet) → gray      running → pulsing blue
 *   success → green                  error → red (with the error message)
 *   skipped → dimmed                 cancelled → dark
 *
 * Clicking a node selects it for the StepPanel.
 */

const STATUS_CLASS = {
  running: 'run-running',
  success: 'run-success',
  error: 'run-error',
  skipped: 'run-skipped',
  cancelled: 'run-cancelled',
};

const STATUS_LABEL = {
  running: 'running',
  success: 'success',
  error: 'error',
  skipped: 'skipped',
  cancelled: 'cancelled',
};

function RunNode({ data, selected }) {
  const { label, type, status, durationMs, error } = data;
  const cls = STATUS_CLASS[status] ?? 'run-queued';
  return (
    <div className={`wf-node wf-${type} ${cls} ${selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Left} className="wf-handle" />
      <div className="wf-node-head">
        <span className="badge">{type}</span>
        <strong>{label}</strong>
      </div>
      <div className="run-node-meta">
        <span className={`run-dot ${cls}`} />
        {status ? STATUS_LABEL[status] ?? status : 'queued'}
        {durationMs != null && durationMs > 0 && <span className="run-duration">{(durationMs / 1000).toFixed(2)}s</span>}
      </div>
      {error && <div className="run-node-error" title={error}>{error.slice(0, 120)}</div>}
      <Handle type="source" position={Position.Right} className="wf-handle" />
    </div>
  );
}

const nodeTypes = { run: RunNode };

/**
 * @param {object} props
 * @param {object} props.workflow the saved workflow (node ids/labels/types)
 * @param {Array<object>} props.steps execution_steps for the current run
 * @param {string|null} props.executionStatus run status (drives queued color)
 * @param {(nodeId: string) => void} props.onSelectNode
 * @param {string|null} props.selectedNodeId
 */
export function PipelineView({ workflow, steps, executionStatus, onSelectNode, selectedNodeId }) {
  const { rfNodes, rfEdges } = useMemo(() => {
    const { rfNodes: baseNodes, rfEdges: edges } = layoutWorkflow(workflow);
    const byNode = new Map(steps.map((s) => [s.nodeId, s]));
    const nodes = baseNodes.map((n) => {
      const step = byNode.get(n.id);
      return {
        ...n,
        type: 'run',
        data: {
          ...n.data,
          status: step?.status ?? null,
          durationMs: step?.durationMs ?? null,
          error: step?.errorMessage ?? null,
        },
      };
    });
    return { rfNodes: nodes, rfEdges: edges };
  }, [workflow, steps]);

  return (
    <div className="canvas-pane pipeline-pane">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        onNodeClick={(_e, node) => onSelectNode(node.id)}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
        <Controls />
        <MiniMap pannable zoomable nodeColor={(n) => {
          const status = n.data?.status;
          if (status === 'error') return '#e5484d';
          if (status === 'success') return '#30a46c';
          if (status === 'running') return '#0091ff';
          return '#9aa0ab';
        }} />
      </ReactFlow>
      {executionStatus === 'running' && <div className="pipeline-live-badge">● live</div>}
    </div>
  );
}
