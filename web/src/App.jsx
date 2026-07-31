import React, { useState } from 'react';
import { api, ApiError } from './api/client.js';
import { PromptInput } from './components/PromptInput.jsx';
import { GrillPanel } from './components/GrillPanel.jsx';
import { WorkflowView } from './components/WorkflowView.jsx';

/**
 * App orchestrates the three-stage flow that mirrors the backend use cases:
 *   1. PROMPT   — the user types a one-line goal.
 *   2. GRILL    — the "grill me" panel refines it into a ready spec.
 *   3. BUILD    — a starter workflow is scaffolded and shown.
 *
 * State is deliberately kept flat and lifted here; each stage is a dumb view.
 */
export function App() {
  const [stage, setStage] = useState('prompt'); // 'prompt' | 'grill' | 'build'
  const [project, setProject] = useState(null);
  const [grill, setGrill] = useState(null);
  const [workflow, setWorkflow] = useState(null);
  const [error, setError] = useState(null);

  const guard = (fn) => async (...args) => {
    setError(null);
    try {
      await fn(...args);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  const start = guard(async (prompt) => {
    const p = await api.createProject(prompt);
    setProject(p);
    setGrill(await api.grill(p.id));
    setStage('grill');
  });

  const submitAnswers = guard(async (answers) => {
    await api.answer(project.id, answers);
    setGrill(await api.grill(project.id));
  });

  const build = guard(async () => {
    const wf = await api.scaffold(project.id, !grill.ready);
    setWorkflow(wf);
    setStage('build');
  });

  const reset = () => {
    setStage('prompt');
    setProject(null);
    setGrill(null);
    setWorkflow(null);
    setError(null);
  };

  return (
    <main className="app">
      <header>
        <h1>AI Workflow Builder</h1>
        <p className="tagline">Prompt → grill me → agent workflow.</p>
      </header>

      {error && <div className="error" role="alert">{error}</div>}

      {stage === 'prompt' && <PromptInput onSubmit={start} />}

      {stage === 'grill' && grill && (
        <GrillPanel grill={grill} onSubmit={submitAnswers} onBuild={build} />
      )}

      {stage === 'build' && workflow && (
        <WorkflowView workflow={workflow} onReset={reset} />
      )}
    </main>
  );
}
