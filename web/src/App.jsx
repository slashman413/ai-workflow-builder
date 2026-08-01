/**
 * App orchestrates the auth-aware workspace:
 *
 *   - signed out → the sign-in shell (OAuth shells for GitHub/Google).
 *   - signed in  → org-scoped workspace: project list, the three-stage flow
 *     (prompt → grill → build), and the LLM key vault.
 *
 * RBAC views (mirroring the backend role matrix):
 *   - Owner      → everything, including deleting projects/vault keys.
 *   - Architect  → create/answer/scaffold + manage vault keys.
 *   - Viewer     → read-only: browse projects, view grill state and
 *     workflows; no create form, no answer form, no build, no vault.
 *
 * State is deliberately kept flat and lifted here; each stage is a dumb view.
 */

import React, { useEffect, useState } from 'react';
import { api, ApiError } from './api/client.js';
import { useAppAuth } from './auth/AuthProvider.jsx';
import { AuthBar } from './components/AuthBar.jsx';
import { PromptInput } from './components/PromptInput.jsx';
import { GrillPanel } from './components/GrillPanel.jsx';
import { WorkflowView } from './components/WorkflowView.jsx';
import { VaultPanel } from './components/VaultPanel.jsx';
import { RoleGate } from './components/RoleGate.jsx';
import { hasRole } from './auth/roles.js';

export function App() {
  const { isLoaded, isSignedIn, orgId, role } = useAppAuth();
  const [stage, setStage] = useState('prompt'); // 'prompt' | 'grill' | 'build'
  const [project, setProject] = useState(null);
  const [grill, setGrill] = useState(null);
  const [workflow, setWorkflow] = useState(null);
  const [projects, setProjects] = useState([]);
  const [error, setError] = useState(null);

  const canWrite = isSignedIn && hasRole(role?.name, 'architect');
  const isViewer = isSignedIn && role?.name === 'viewer';

  // Reload the org-scoped workspace whenever the session or org changes.
  useEffect(() => {
    if (!isSignedIn) {
      setProject(null);
      setGrill(null);
      setWorkflow(null);
      setStage('prompt');
      setProjects([]);
      return;
    }
    api
      .listProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, [isSignedIn, orgId]);

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
    setWorkflow(null);
    setStage('grill');
    setProjects(await api.listProjects());
  });

  const loadProject = guard(async (id) => {
    const p = await api.getProject(id);
    setProject(p);
    setGrill(await api.grill(id));
    const wf = await api.getWorkflow(id);
    setWorkflow(wf ?? null);
    setStage(wf ? 'build' : 'grill');
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

      <AuthBar />

      {error && <div className="error" role="alert">{error}</div>}

      {isSignedIn && (
        <RoleGate min="viewer">
          <section className="card project-list">
            <h2>Workspace projects</h2>
            {projects.length === 0 ? (
              <p className="empty">No projects in this workspace yet.</p>
            ) : (
              <ul>
                {projects.map((p) => (
                  <li key={p.id}>
                    <button type="button" className="project-row" onClick={() => loadProject(p.id)}>
                      <span className="project-title">{p.prompt}</span>
                      <span className="project-meta">{new Date(p.updatedAt).toLocaleString()}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {isViewer && (
              <p className="readonly-note">
                You have <strong>Viewer</strong> access — this workspace is read-only. Ask an Owner or Architect to
                create or edit projects.
              </p>
            )}
          </section>

          {stage === 'prompt' && (
            <RoleGate
              min="architect"
              fallback={
                <section className="card">
                  <p className="readonly-note">Open a project above to view its grill state and workflow.</p>
                </section>
              }
            >
              <PromptInput onSubmit={start} />
            </RoleGate>
          )}

          {stage === 'grill' && grill && (
            <GrillPanel grill={grill} onSubmit={submitAnswers} onBuild={build} readOnly={!canWrite} />
          )}

          {stage === 'build' && workflow && <WorkflowView workflow={workflow} onReset={reset} />}

          <VaultPanel />
        </RoleGate>
      )}
    </main>
  );
}
