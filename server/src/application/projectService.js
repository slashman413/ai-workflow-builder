/**
 * projectService.js — use cases spanning prompt → grill → spec → workflow.
 *
 * Services coordinate domain logic and repositories. They contain NO
 * persistence or HTTP detail; those arrive via the injected repositories
 * (constructor injection). This is the only layer allowed to orchestrate
 * across the three domain modules.
 */

import { nextQuestions, assessReadiness, coverageScore } from '../domain/grill/grillEngine.js';
import { buildSpec, suggestNodes } from '../domain/spec/specBuilder.js';
import { validateWorkflow } from '../domain/workflow/validateWorkflow.js';

export class ProjectService {
  /**
   * @param {{ projects: any, workflows: any }} repos
   */
  constructor({ projects, workflows }) {
    this.projects = projects;
    this.workflows = workflows;
  }

  /** Start a new project from a one-line prompt. */
  createProject(prompt) {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new AppError('INVALID_PROMPT', 'Prompt must be a non-empty string.');
    }
    const spec = buildSpec(prompt, {});
    return this.projects.create({ prompt: prompt.trim(), answers: {}, spec });
  }

  getProject(id) {
    const project = this.projects.get(id);
    if (!project) throw new AppError('NOT_FOUND', `Project ${id} not found.`, 404);
    return project;
  }

  listProjects() {
    return this.projects.list();
  }

  /** The "grill me" step: return the next questions + progress for a project. */
  grill(id, { deep = false } = {}) {
    const project = this.getProject(id);
    const questions = nextQuestions(project.prompt, project.answers, { deep });
    const readiness = assessReadiness(project.prompt, project.answers);
    return {
      projectId: id,
      questions,
      coverage: coverageScore(project.prompt, project.answers),
      ...readiness,
    };
  }

  /** Record answers to grill questions and re-derive the spec snapshot. */
  answer(id, answers) {
    const project = this.getProject(id);
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
      throw new AppError('INVALID_ANSWERS', 'answers must be an object of questionId -> text.');
    }
    const merged = { ...project.answers, ...answers };
    const spec = buildSpec(project.prompt, merged);
    return this.projects.update(id, { answers: merged, spec });
  }

  /**
   * Compile the current spec into a starter workflow. Refuses if the spec is
   * not ready — the whole point of grilling is to not build on sand. Caller can
   * force it with `{ force: true }` (documented escape hatch).
   */
  scaffoldWorkflow(id, { force = false } = {}) {
    const project = this.getProject(id);
    const spec = buildSpec(project.prompt, project.answers);
    if (!spec.ready && !force) {
      throw new AppError(
        'SPEC_NOT_READY',
        `Spec still has open questions: ${spec.openQuestions.join(', ')}. Answer them or pass force=true.`,
        409,
      );
    }
    const workflow = {
      id: `wf_${id}`,
      name: spec.goal.slice(0, 60) || 'Untitled workflow',
      nodes: suggestNodes(spec),
    };
    return this.workflows.save(id, workflow);
  }

  /** Persist a user-edited workflow after validating its invariants. */
  saveWorkflow(id, workflow) {
    this.getProject(id); // existence check
    const result = validateWorkflow(workflow);
    if (!result.valid) {
      throw new AppError('INVALID_WORKFLOW', 'Workflow failed validation.', 422, result.errors);
    }
    return this.workflows.save(id, { ...workflow, id: workflow.id ?? `wf_${id}` });
  }

  getWorkflow(id) {
    this.getProject(id);
    return this.workflows.getByProject(id);
  }

  deleteProject(id) {
    const ok = this.projects.remove(id);
    if (!ok) throw new AppError('NOT_FOUND', `Project ${id} not found.`, 404);
    return { deleted: true, id };
  }
}

/** Domain/application error carrying an HTTP-friendly status + details. */
export class AppError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
