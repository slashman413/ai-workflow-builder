import React from 'react';

/**
 * Feature 3: the agent workflow builder view. Renders the scaffolded DAG as an
 * ordered list of steps with their dependencies. This is intentionally a
 * read-first view of the generated skeleton; drag-to-edit is a roadmap item
 * (see README "Roadmap") — the backend already validates arbitrary edited
 * graphs via PUT /workflow.
 */
export function WorkflowView({ workflow, onReset }) {
  return (
    <section className="card">
      <h2>3. Your agent workflow</h2>
      <p className="wf-name">{workflow.name}</p>

      <ol className="nodes">
        {workflow.nodes.map((node) => (
          <li key={node.id} className={`node node-${node.type}`}>
            <div className="node-head">
              <span className="badge">{node.type}</span>
              <strong>{node.name}</strong>
            </div>
            {node.dependsOn?.length > 0 && (
              <div className="deps">after: {node.dependsOn.join(', ')}</div>
            )}
            {node.config && Object.keys(node.config).length > 0 && (
              <pre className="config">{JSON.stringify(node.config, null, 2)}</pre>
            )}
          </li>
        ))}
      </ol>

      <div className="actions">
        <button className="ghost" onClick={onReset}>
          Start over
        </button>
      </div>
    </section>
  );
}
