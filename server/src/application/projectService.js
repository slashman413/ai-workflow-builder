/**
 * projectService.js — use cases spanning prompt → grill → spec → workflow.
 *
 * Services coordinate domain logic and repositories. They contain NO
 * persistence or HTTP detail; those arrive via the injected repositories
 * (constructor injection). This is the only layer allowed to orchestrate
 * across the three domain modules.
 *
 * Multi-tenant isolation (Increment 2): every use case takes the caller's
 * `orgId` and threads it into every repository call. The repositories scope
 * every query by org, so a foreign-org id behaves exactly like a missing id
 * (404). `assertOrg` is a service-level backstop: even if a future controller
 * forgets to pass the tenant, the request dies here instead of leaking into
 * the empty tenant.
 *
 * Grill guardrails (Increment 3): the clarification loop is free to the user
 * but NOT free to the operator. `answer()` enforces the ceilings from
 * domain/grill/guardrails.js (≤5 turns, ≤15,000 estimated tokens per
 * session) in the SERVICE layer — cumulative counters persisted on the
 * latest grill_sessions row — so the ceiling is the business rule and cannot
 * be bypassed by calling the API directly, SSE stream or batch endpoint
 * alike. Exceeding a ceiling answers HTTP 429 GRILL_LIMIT.
 */

import { nextQuestions, assessReadiness, coverageScore } from '../domain/grill/grillEngine.js';
import { buildSpec, suggestNodes } from '../domain/spec/specBuilder.js';
import { validateWorkflow } from '../domain/workflow/validateWorkflow.js';
import { GUARDRAILS, estimateTokens, checkGuardrails } from '../domain/grill/guardrails.js';
import { AppError, assertOrg } from './errors.js';

export class ProjectService {
  /**
   * @param {{ projects: any, workflows: any, grillSessions: any }} repos
   */
  constructor({ projects, workflows, grillSessions }) {
    this.projects = projects;
    this.workflows = workflows;
    this.grillSessions = grillSessions;
  }

  /** Start a new project from a one-line prompt. */
  createProject(orgId, prompt) {
    assertOrg(orgId);
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new AppError('INVALID_PROMPT', 'Prompt must be a non-empty string.');
    }
    const spec = buildSpec(prompt, {});
    return this.projects.create({ orgId, prompt: prompt.trim(), answers: {}, spec });
  }

  getProject(orgId, id) {
    assertOrg(orgId);
    const project = this.projects.get(orgId, id);
    if (!project) throw new AppError('NOT_FOUND', `Project ${id} not found.`, 404);
    return project;
  }

  listProjects(orgId) {
    assertOrg(orgId);
    return this.projects.list(orgId);
  }

  /** The "grill me" step: return the next questions + progress for a project. */
  grill(orgId, id, { deep = false } = {}) {
    const project = this.getProject(orgId, id);
    const questions = nextQuestions(project.prompt, project.answers, { deep });
    const readiness = assessReadiness(project.prompt, project.answers);
    return {
      projectId: id,
      questions,
      coverage: coverageScore(project.prompt, project.answers),
      ...readiness,
    };
  }

  /** Cumulative guardrail counters for a project's grill session (SSE pre-check). */
  grillUsage(orgId, id) {
    this.getProject(orgId, id); // existence + tenant check
    const usage = this.grillSessions.usage(orgId, id) ?? { turns: 0, tokensUsed: 0 };
    return { projectId: id, ...usage, limits: { ...GUARDRAILS } };
  }

  /**
   * Record answers to grill questions and re-derive the spec snapshot.
   *
   * Financial-DoS guardrails: each round consumes one turn and the estimated
   * tokens of the prompt + answers. Exceeding either ceiling answers HTTP 429
   * (RATE_LIMITED) BEFORE anything is persisted — the ceiling is the business
   * rule, enforced here so it cannot be bypassed by calling the API directly.
   */
  answer(orgId, id, answers) {
    const project = this.getProject(orgId, id);
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
      throw new AppError('INVALID_ANSWERS', 'answers must be an object of questionId -> text.');
    }
    const values = Object.values(answers).filter((v) => typeof v === 'string');
    const usage = this.grillSessions.usage(orgId, id) ?? { turns: 0, tokensUsed: 0 };
    const incomingTokens = estimateTokens(project.prompt, values);
    const check = checkGuardrails(usage, incomingTokens);
    if (!check.ok) {
      throw new AppError('GRILL_LIMIT', check.message, 429, {
        turns: usage.turns,
        tokensUsed: usage.tokensUsed,
        incomingTokens,
        limits: { ...GUARDRAILS },
      });
    }

    const merged = { ...project.answers, ...answers };
    const spec = buildSpec(project.prompt, merged);
    const updated = this.projects.update(orgId, id, { answers: merged, spec });

    // Append a grill session row — the audit trail of the clarification loop,
    // carrying the cumulative guardrail counters.
    const readiness = assessReadiness(project.prompt, merged);
    const round = (this.grillSessions.listByProject(orgId, id)?.length ?? 0) + 1;
    this.grillSessions.record(orgId, id, {
      round,
      answers: merged,
      coverage: coverageScore(project.prompt, merged),
      ready: readiness.ready,
      turns: usage.turns + 1,
      tokensUsed: usage.tokensUsed + incomingTokens,
    });

    return updated;
  }

  /**
   * Compile the current spec into a starter workflow. Refuses if the spec is
   * not ready — the whole point of grilling is to not build on sand. Caller can
   * force it with `{ force: true }` (documented escape hatch).
   */
  scaffoldWorkflow(orgId, id, { force = false } = {}) {
    const project = this.getProject(orgId, id);
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
    return this.workflows.save(orgId, id, workflow);
  }

  /** Persist a user-edited workflow after validating its invariants. */
  saveWorkflow(orgId, id, workflow) {
    this.getProject(orgId, id); // existence + tenant check
    const result = validateWorkflow(workflow);
    if (!result.valid) {
      throw new AppError('INVALID_WORKFLOW', 'Workflow failed validation.', 422, result.errors);
    }
    return this.workflows.save(orgId, id, { ...workflow, id: workflow.id ?? `wf_${id}` });
  }

  getWorkflow(orgId, id) {
    this.getProject(orgId, id);
    return this.workflows.getByProject(orgId, id);
  }

  deleteProject(orgId, id) {
    assertOrg(orgId);
    const ok = this.projects.remove(orgId, id);
    if (!ok) throw new AppError('NOT_FOUND', `Project ${id} not found.`, 404);
    return { deleted: true, id };
  }
}

export { AppError, assertOrg } from './errors.js';
