/**
 * grillStreamService.js — the realtime Grill-Me interrogation loop (SSE).
 *
 * The batch grill endpoint (`GET /projects/:id/grill`) returns every open
 * question at once. The stream endpoint interrogates the user ONE question
 * at a time over Server-Sent Events — the engine asks, the user answers via
 * `POST /api/grill/stream/:sessionId/answers`, and the engine pushes the
 * next question (or the compiled workflow) down the open connection. This
 * is the low-latency loop the product brief describes: ambiguity, token
 * budgets (constraints.hard) and failure modes (edge_cases.failure) are
 * resolved BEFORE any Python workflow code is compiled.
 *
 * Cost & DoS guardrails: the hard ceilings (MAX_TURNS = 5, MAX_TOKENS =
 * 15,000) are defined in domain/grill/guardrails.js and enforced in the
 * SERVICE layer — ProjectService.answer() rejects any round that would
 * breach them with HTTP 429 GRILL_LIMIT. This service mirrors those limits
 * for live SSE feedback (emitting a `limit` event and closing the stream)
 * and re-syncs its counters from the PERSISTED usage on every turn, so the
 * stream can never drift from the business rule and a client cannot bypass
 * the ceiling by mixing stream and batch answers.
 *
 * Sessions are single-instance, in-memory state with a replay queue: a
 * client that drops the connection can re-open `POST /api/grill/stream`
 * with `{ sessionId }` and receives every event emitted so far before live
 * ones. Every answer is persisted through the ProjectService (which writes
 * a grill_sessions audit row with the cumulative counters), so the
 * conversation survives a server restart even though the live stream does
 * not.
 */

import { randomUUID } from 'node:crypto';
import { nextQuestions, assessReadiness, coverageScore } from '../domain/grill/grillEngine.js';
import { buildSpec, suggestNodes } from '../domain/spec/specBuilder.js';
import { generate } from '../domain/codegen/generator.js';
import { GUARDRAILS, estimateTokens, checkGuardrails } from '../domain/grill/guardrails.js';
import { AppError } from './errors.js';

/** Stream-level limits (the ceilings themselves live in guardrails.js). */
export const STREAM_LIMITS = Object.freeze({
  maxActiveSessionsPerOrg: 20,
  idleTimeoutMs: 10 * 60 * 1000, // sessions expire 10 minutes after last event
});

/** Pick the single most important open question (critical-first, bank order). */
export function nextQuestion(prompt, answers) {
  const open = nextQuestions(prompt, answers, { deep: false });
  return open[0] ?? null;
}

/** Compile the spec into a Python project (the "before compiling" payoff). */
export function compileWorkflow(prompt, answers) {
  const spec = buildSpec(prompt, answers);
  const workflow = {
    id: 'wf_stream',
    name: spec.goal.slice(0, 60) || 'Untitled workflow',
    nodes: suggestNodes(spec),
  };
  const generated = generate({ spec, workflow });
  return { spec, workflow, generated };
}

export class GrillStreamService {
  /**
   * @param {import('./projectService.js').ProjectService} service  The project
   *   use case — every answer is persisted through it (merge → re-derive spec
   *   → grill_sessions audit row with guardrail counters), never written
   *   behind its back.
   * @param {object} [opts]
   */
  constructor(service, { limits = STREAM_LIMITS } = {}) {
    this.service = service;
    this.limits = limits;
    /** @type {Map<string, object>} sessionId -> session */
    this.sessions = new Map();
    // Idle sweep: close expired sessions so abandoned streams cannot pin memory.
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  /** Number of live sessions for an org (DoS cap). */
  activeCount(orgId) {
    let n = 0;
    for (const s of this.sessions.values()) if (s.orgId === orgId && s.state === 'open') n += 1;
    return n;
  }

  /**
   * Open (or resume) a grill stream session.
   * @returns {object} the session with the caller's response subscribed.
   */
  open({ orgId, prompt, projectId, sessionId, res }) {
    let session = null;
    if (sessionId) {
      session = this.sessions.get(sessionId);
      if (!session || session.orgId !== orgId) {
        throw new AppError('NOT_FOUND', `Grill session ${sessionId} not found.`, 404);
      }
      if (session.state === 'closed') {
        // Terminal session: replay the full transcript, then close the
        // connection (the client is done — nothing more will ever arrive).
        this.attach(session, res);
        this.endSubscribers(session);
        return session;
      }
    } else {
      if (this.activeCount(orgId) >= this.limits.maxActiveSessionsPerOrg) {
        throw new AppError('TOO_MANY_SESSIONS', 'Too many active grill sessions for this workspace. Close old ones first.', 429);
      }
      if (typeof prompt !== 'string' || !prompt.trim()) {
        throw new AppError('INVALID_PROMPT', 'prompt must be a non-empty string.', 400);
      }
      const project = projectId
        ? this.service.getProject(orgId, projectId)
        : this.service.createProject(orgId, prompt);
      const usage = this.service.grillUsage(orgId, project.id);
      session = {
        id: randomUUID(),
        orgId,
        projectId: project.id,
        prompt: project.prompt,
        answers: { ...(project.answers ?? {}) },
        turns: usage.turns,
        tokensUsed: usage.tokensUsed,
        state: 'open',
        closedReason: null,
        events: [],
        subscribers: new Set(),
        lastActivityAt: Date.now(),
      };
      this.sessions.set(session.id, session);
    }

    this.attach(session, res);
    if (session.state === 'open') {
      // Announce the session identity FIRST so the client can answer via
      // POST /grill/stream/:sessionId/answers.
      this.emit(session, 'session', { sessionId: session.id, projectId: session.projectId, prompt: session.prompt });
      this.advance(session);
    }
    return session;
  }

  /**
   * Submit one answer for a session. Returns the JSON state (for the answer
   * request's own response) and pushes events to every open subscriber.
   */
  answer(orgId, sessionId, { answerId, text }) {
    const session = this.sessions.get(sessionId);
    if (!session || session.orgId !== orgId) {
      throw new AppError('NOT_FOUND', `Grill session ${sessionId} not found.`, 404);
    }
    if (session.state !== 'open') {
      // Idempotent replay: a client racing the stream close may re-deliver
      // the final answer after the session completed. Re-answering a question
      // that is already recorded on a COMPLETED session is a harmless no-op;
      // every other closed state (limit/stalled) is a protocol violation.
      if (
        session.closedReason === 'complete' &&
        typeof answerId === 'string' &&
        session.answers[answerId] !== undefined
      ) {
        return this.stateFor(session);
      }
      throw new AppError('SESSION_CLOSED', `Grill session is ${session.state} (${session.closedReason ?? 'finished'}).`, 409);
    }
    if (typeof answerId !== 'string' || typeof text !== 'string' || !text.trim()) {
      throw new AppError('INVALID_ANSWER', 'answerId and text (non-empty string) are required.', 400);
    }

    // Re-sync from the persisted usage first — the project may have accrued
    // turns/tokens through the batch UI since this stream opened. Merge with
    // MAX (never overwrite the local mirror downward): the higher of the two
    // is the true consumption, so the ceiling can never be gamed by opening
    // a fresh stream against a project that already burned its budget.
    const usage = this.service.grillUsage(orgId, session.projectId);
    session.turns = Math.max(usage.turns, session.turns);
    session.tokensUsed = Math.max(usage.tokensUsed, session.tokensUsed);

    // Local pre-check mirrors the service-layer rule so the stream can emit
    // a clean `limit` event; ProjectService.answer() re-checks authoritatively.
    const incomingTokens = estimateTokens(session.prompt, text);
    const check = checkGuardrails({ turns: session.turns, tokensUsed: session.tokensUsed }, incomingTokens);
    if (!check.ok) {
      const reason = check.code === 'TURN_LIMIT' ? 'turns' : 'tokens';
      return this.hitLimit(session, reason, check.message);
    }

    session.answers[answerId] = text.trim();
    session.lastActivityAt = Date.now();

    // Persist through the project use case: merge → re-derive spec → audit
    // row with cumulative counters. Throws AppError 429 GRILL_LIMIT if the
    // authoritative check disagrees (defense in depth).
    this.service.answer(orgId, session.projectId, { [answerId]: text.trim() });

    // Mirror the persisted counters exactly.
    const after = this.service.grillUsage(orgId, session.projectId);
    session.turns = after.turns;
    session.tokensUsed = after.tokensUsed;

    this.advance(session);
    return this.stateFor(session);
  }

  /** JSON snapshot for GET /api/grill/stream/:sessionId (reconnect probe). */
  state(orgId, sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.orgId !== orgId) {
      throw new AppError('NOT_FOUND', `Grill session ${sessionId} not found.`, 404);
    }
    return this.stateFor(session);
  }

  /**
   * Pre-flight lookup without subscribing a response — lets the HTTP route
   * answer bad requests (404 unknown session, 403 foreign org) with proper
   * JSON status codes BEFORE the SSE headers are committed.
   */
  peek(orgId, sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.orgId !== orgId) {
      throw new AppError('NOT_FOUND', `Grill session ${sessionId} not found.`, 404);
    }
    return {
      sessionId: session.id,
      projectId: session.projectId,
      state: session.state,
      closedReason: session.closedReason,
    };
  }

  /** Close every session for an org (org deletion) and stop the sweeper. */
  dispose() {
    clearInterval(this.sweeper);
    for (const session of this.sessions.values()) this.close(session, 'server-shutdown');
  }

  /* ------------------------------------------------------------------ */

  stateFor(session) {
    return {
      sessionId: session.id,
      projectId: session.projectId,
      prompt: session.prompt,
      answers: session.answers,
      turn: session.turns,
      turnsUsed: session.turns,
      turnsRemaining: Math.max(0, GUARDRAILS.maxTurns - session.turns),
      tokensUsed: session.tokensUsed,
      tokensRemaining: Math.max(0, GUARDRAILS.maxTokens - session.tokensUsed),
      state: session.state,
      closedReason: session.closedReason,
    };
  }

  /** Move the session one step: next question, or ready → compiled → done. */
  advance(session) {
    if (session.state !== 'open') return;
    const readiness = assessReadiness(session.prompt, session.answers);
    const coverage = coverageScore(session.prompt, session.answers);

    this.emit(session, 'progress', {
      coverage,
      ready: readiness.ready,
      missing: readiness.missing,
      warnings: readiness.warnings,
      turn: session.turns,
      turnsRemaining: Math.max(0, GUARDRAILS.maxTurns - session.turns),
      tokensUsed: session.tokensUsed,
      tokensRemaining: Math.max(0, GUARDRAILS.maxTokens - session.tokensUsed),
    });

    if (readiness.ready) {
      // The interrogation is done: emit the spec, then the compiled Python
      // workflow. The compiled payload counts against the token budget.
      const { spec, workflow, generated } = compileWorkflow(session.prompt, session.answers);
      this.emit(session, 'ready', { spec, projectId: session.projectId });

      const codeTokens = estimateTokens(JSON.stringify(generated.files));
      if (session.tokensUsed + codeTokens > GUARDRAILS.maxTokens) {
        this.hitLimit(session, 'tokens', 'Compiled workflow exceeds the remaining token budget.');
        return;
      }
      session.tokensUsed += codeTokens;
      this.emit(session, 'compiled', {
        summary: generated.summary,
        files: generated.files,
        workflow,
      });
      this.close(session, 'complete');
      this.emit(session, 'done', { reason: 'complete', projectId: session.projectId });
      this.endSubscribers(session);
      return;
    }

    // Still ambiguous: ask the single most important open question.
    const question = nextQuestion(session.prompt, session.answers);
    if (!question) {
      // No unanswered critical questions but readiness says not ready — the
      // bank cannot advance; hand control back to the batch grill UI.
      this.close(session, 'stalled');
      this.emit(session, 'done', { reason: 'stalled', message: 'No further questions available; use the batch grill view.' });
      this.endSubscribers(session);
      return;
    }
    this.emit(session, 'question', {
      question,
      turn: session.turns + 1, // the turn this question's answer will be
      turnsRemaining: Math.max(0, GUARDRAILS.maxTurns - session.turns),
      tokensRemaining: Math.max(0, GUARDRAILS.maxTokens - session.tokensUsed),
    });
  }

  /** Emit an event to every subscriber and append it to the replay queue. */
  emit(session, event, data) {
    session.events.push({ event, data });
    session.lastActivityAt = Date.now();
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of session.subscribers) {
      try {
        res.write(payload);
      } catch {
        session.subscribers.delete(res);
      }
    }
  }

  attach(session, res) {
    session.subscribers.add(res);
    // Replay the transcript for late/resumed subscribers, then go live.
    for (const { event, data } of session.events) {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        session.subscribers.delete(res);
        return;
      }
    }
    res.on('close', () => session.subscribers.delete(res));
  }

  /** Terminal event + close. Returns the 429-style payload for the answer HTTP response. */
  hitLimit(session, reason, message) {
    this.emit(session, 'limit', { reason, message });
    this.close(session, `limit:${reason}`);
    this.emit(session, 'done', { reason: 'limit', limit: reason });
    this.endSubscribers(session);
    return {
      sessionId: session.id,
      error: 'GRILL_LIMIT',
      message,
      limit: reason,
      turnsUsed: session.turns,
      tokensUsed: session.tokensUsed,
      state: session.state,
    };
  }

  /** Close every live subscriber response once the session is terminal. */
  endSubscribers(session) {
    for (const res of session.subscribers) {
      try {
        res.end();
      } catch {
        /* client already gone */
      }
    }
    session.subscribers.clear();
  }

  close(session, reason) {
    if (session.state === 'closed') return;
    session.state = 'closed';
    session.closedReason = reason;
    session.lastActivityAt = Date.now();
  }

  /** Expire idle sessions so abandoned streams cannot pin memory. */
  sweep() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.state === 'open' && now - session.lastActivityAt > this.limits.idleTimeoutMs) {
        this.close(session, 'idle-timeout');
      }
      if (session.state === 'closed' && session.subscribers.size === 0) {
        // Terminal sessions with no listeners are garbage; keep only the
        // most recent few per org for reconnect probes.
        this.sessions.delete(session.id);
      }
    }
  }
}
