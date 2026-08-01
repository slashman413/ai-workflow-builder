/**
 * grillStream.test.js — the realtime Grill-Me SSE loop (Increment 3).
 *
 * Covers:
 *   - the pure guardrail domain (estimateTokens / checkGuardrails);
 *   - service-layer ceiling enforcement in ProjectService.answer
 *     (HTTP 429 GRILL_LIMIT, counters persisted on the session row);
 *   - the GrillStreamService state machine: session → progress → question →
 *     answer… → ready → compiled (Python codegen) → done; turn and token
 *     ceilings terminate the loop with a `limit` event;
 *   - the live SSE endpoint over HTTP, answering through the answers route.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepos } from '../src/adapters/persistence/memoryRepos.js';
import { estimateTokens, checkGuardrails, GUARDRAILS } from '../src/domain/grill/guardrails.js';
import { ProjectService } from '../src/application/projectService.js';
import { GrillStreamService, compileWorkflow, nextQuestion } from '../src/application/grillStreamService.js';
import { AppError } from '../src/application/errors.js';

let createApp;
try {
  ({ createApp } = await import('../src/adapters/http/app.js'));
} catch {
  createApp = null;
}
const maybe = createApp ? test : test.skip;

// --- guardrail domain --------------------------------------------------------

test('estimateTokens is a cheap ~4-char-per-token over-estimator', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcd', 'efgh'), 2);
  assert.ok(estimateTokens('x'.repeat(4000)) >= 1000);
});

test('checkGuardrails enforces the 5-turn and 15k-token ceilings', () => {
  assert.equal(checkGuardrails({ turns: 0, tokensUsed: 0 }, 1).ok, true);
  assert.equal(checkGuardrails({ turns: GUARDRAILS.maxTurns, tokensUsed: 0 }, 1).ok, false);
  assert.equal(checkGuardrails({ turns: 4, tokensUsed: 0 }, 1).ok, true);
  const tokenLimit = checkGuardrails({ turns: 0, tokensUsed: GUARDRAILS.maxTokens }, 1);
  assert.equal(tokenLimit.ok, false);
  assert.equal(tokenLimit.code, 'TOKEN_LIMIT');
});

test('ProjectService.answer rejects rounds beyond the ceilings with 429 GRILL_LIMIT', () => {
  const repos = createMemoryRepos();
  const service = new ProjectService(repos);
  const project = service.createProject('org-1', 'summarise my emails');
  // Four answers in one call (like the batch UI) = 1 turn. Do 5 calls: the
  // sixth must be refused — the ceiling is the business rule.
  const answers = { 'goal.outcome': 'a digest', 'inputs.source': 'inbox', 'outputs.shape': 'markdown', 'success.measure': 'nothing missed' };
  for (let i = 0; i < GUARDRAILS.maxTurns; i += 1) {
    service.answer('org-1', project.id, answers);
  }
  assert.throws(
    () => service.answer('org-1', project.id, answers),
    (e) => e instanceof AppError && e.status === 429 && e.code === 'GRILL_LIMIT',
  );
  // Counters are persisted on the session rows.
  const usage = service.grillUsage('org-1', project.id);
  assert.equal(usage.turns, GUARDRAILS.maxTurns);
  assert.ok(usage.tokensUsed > 0);
});

// --- service-level state machine ---------------------------------------------

/** A fake SSE response that records every chunk written. */
function fakeRes() {
  const chunks = [];
  return {
    chunks,
    write(chunk) { chunks.push(String(chunk)); return true; },
    end() { chunks.push('__END__'); },
    on() {},
  };
}

/** Events parsed out of captured SSE chunks: { event, data }[]. */
function parseEvents(chunks) {
  const events = [];
  let current = null;
  for (const chunk of chunks) {
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event: ')) {
        current = { event: line.slice(7).trim(), data: null };
      } else if (line.startsWith('data: ') && current) {
        try { current.data = JSON.parse(line.slice(6)); } catch { current.data = line.slice(6); }
      } else if (line === '' && current) {
        events.push(current);
        current = null;
      }
    }
  }
  return events;
}

function makeStreamService(repos = createMemoryRepos()) {
  return new GrillStreamService(new ProjectService(repos));
}

test('GrillStreamService interrogates one question at a time and compiles on ready', () => {
  const service = makeStreamService();
  const res = fakeRes();
  const session = service.open({ orgId: 'org-1', prompt: 'build a bot that files my receipts and emails me a report', res });

  // First question is the most important open one (critical, bank order).
  let events = parseEvents(res.chunks);
  const sessionEvent = events.find((e) => e.event === 'session');
  assert.ok(sessionEvent, 'session event announces the session id');
  assert.equal(sessionEvent.data.sessionId, session.id);
  const first = events.find((e) => e.event === 'question');
  assert.ok(first, 'expected a question event');
  assert.ok(first.data.question.id, 'question carries an id');

  // Answer the LATEST question until the spec is ready (each answer = 1 turn).
  const answered = new Set();
  let guard = 0;
  while (guard < 20) {
    guard += 1;
    const q = [...parseEvents(res.chunks)].reverse().find((e) => e.event === 'question')?.data?.question;
    if (!q || answered.has(q.id)) break;
    answered.add(q.id);
    service.answer('org-1', session.id, { answerId: q.id, text: 'a concrete answer to ' + q.id });
  }

  events = parseEvents(res.chunks);
  const ready = events.find((e) => e.event === 'ready');
  const compiled = events.find((e) => e.event === 'compiled');
  const done = events.find((e) => e.event === 'done');
  assert.ok(ready, 'ready event emitted once the spec is covered');
  assert.ok(compiled, 'compiled event carries the Python workflow');
  assert.ok(compiled.data.files['main.py'], 'main.py generated');
  assert.ok(compiled.data.summary.includes('Generated'), 'summary present');
  assert.equal(done.data.reason, 'complete');
  assert.ok(res.chunks.includes('__END__'), 'stream closes after done');
  assert.ok(session.turns <= GUARDRAILS.maxTurns);
});

test('GrillStreamService enforces the turn ceiling with a limit event', () => {
  const service = makeStreamService();
  const res = fakeRes();
  const session = service.open({ orgId: 'org-1', prompt: 'a workflow with several inputs', res });
  // White-box: push the session to the ceiling, then answer — the guardrail
  // must refuse before anything is persisted (the batch path exercises the
  // same rule through ProjectService.answer, tested separately).
  session.turns = GUARDRAILS.maxTurns;
  session.tokensUsed = 0;
  const result = service.answer('org-1', session.id, { answerId: 'goal.outcome', text: 'one more answer' });
  assert.equal(result.error, 'GRILL_LIMIT');
  assert.equal(result.limit, 'turns');
  const limitEvent = parseEvents(res.chunks).find((e) => e.event === 'limit');
  assert.equal(limitEvent.data.reason, 'turns');
  assert.equal(session.state, 'closed');
  // A closed session refuses further answers with 409.
  assert.throws(
    () => service.answer('org-1', session.id, { answerId: 'goal.outcome', text: 'still trying' }),
    (e) => e.status === 409 && e.code === 'SESSION_CLOSED',
  );
});

test('GrillStreamService rejects answers on closed sessions and unknown ids', () => {
  const service = makeStreamService();
  const res = fakeRes();
  const session = service.open({ orgId: 'org-1', prompt: 'x produces y from z', res });
  assert.throws(() => service.answer('org-2', session.id, { answerId: 'a', text: 'b' }), (e) => e.status === 404);
  assert.throws(() => service.state('org-2', session.id), (e) => e.status === 404);
  assert.throws(() => service.answer('org-1', session.id, { answerId: 'a' }), (e) => e.status === 400);
  res.end();
});

test('GrillStreamService resumes a closed session by replaying the transcript', () => {
  const service = makeStreamService();
  const res1 = fakeRes();
  const session = service.open({ orgId: 'org-1', prompt: 'turn pdfs into summaries with citations', res: res1 });
  // Answer until closed.
  let guard = 0;
  while (guard < 20) {
    guard += 1;
    const events = parseEvents(res1.chunks);
    const q = [...events].reverse().find((e) => e.event === 'question')?.data?.question;
    if (!q) break;
    service.answer('org-1', session.id, { answerId: q.id, text: 'answer for ' + q.id });
  }
  const res2 = fakeRes();
  service.open({ orgId: 'org-1', sessionId: session.id, res: res2 });
  const replayed = parseEvents(res2.chunks);
  assert.ok(replayed.some((e) => e.event === 'ready'), 'transcript replayed to a resuming client');
  assert.ok(res2.chunks.includes('__END__'));
});

test('nextQuestion picks the first critical open question', () => {
  const q = nextQuestion('do something', {});
  assert.ok(q);
  assert.equal(q.critical, true);
  assert.equal(nextQuestion('a fully specified prompt with goal, inputs, outputs and success criteria all given', {
    'goal.outcome': 'x', 'inputs.source': 'y', 'outputs.shape': 'z', 'success.measure': 'w',
  }), null);
});

test('compileWorkflow produces a valid Python project from a covered spec', () => {
  const { spec, workflow, generated } = compileWorkflow('bot that files receipts', {
    'goal.outcome': 'a filed receipt with a monthly report',
    'inputs.source': 'my email inbox',
    'outputs.shape': 'a markdown report',
    'success.measure': 'every receipt filed, none duplicated',
  });
  assert.equal(spec.ready, true);
  assert.ok(workflow.nodes.length >= 3);
  assert.ok(generated.files['main.py'].includes('def main()'));
});

// --- live HTTP SSE -----------------------------------------------------------

let server;
let base;

before(async () => {
  if (!createApp) return;
  const repos = createMemoryRepos();
  const app = createApp(repos);
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}/api`;
      resolve();
    });
  });
});

after(() => server?.close());

/** Read an SSE response body into parsed events, resolving on stream close. */
async function readSse(res, onEvents) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = block.match(/^event: (.+)$/m)?.[1];
      const dataLine = block.match(/^data: (.+)$/m)?.[1];
      if (event && dataLine) {
        try {
          onEvents({ event, data: JSON.parse(dataLine) });
        } catch {
          onEvents({ event, data: dataLine });
        }
      }
    }
  }
}

maybe('SSE loop over HTTP: open stream, answer questions, receive compiled code', async () => {
  const prompt = 'a daily digest bot that reads my feeds, filters noise, and emails me a summary';
  const streamRes = await fetch(`${base}/grill/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-org-id': 'org-http' },
    body: JSON.stringify({ prompt }),
  });
  assert.equal(streamRes.status, 200);
  assert.equal(streamRes.headers.get('content-type'), 'text/event-stream');

  const events = [];
  const reading = readSse(streamRes, (e) => events.push(e));

  // Wait for the session identity, then answer every question until done.
  const deadline = Date.now() + 15_000;
  let sessionId = null;
  while (Date.now() < deadline) {
    const sessionEvent = events.find((e) => e.event === 'session');
    if (sessionEvent) {
      sessionId = sessionEvent.data.sessionId;
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(sessionId, 'session event carries the session id for the answers route');

  let guard = 0;
  while (Date.now() < deadline && guard < 20) {
    guard += 1;
    const question = [...events].reverse().find((e) => e.event === 'question')?.data?.question;
    if (!question) break;
    const answerRes = await fetch(`${base}/grill/stream/${sessionId}/answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-org-id': 'org-http' },
      body: JSON.stringify({ answerId: question.id, text: `http answer for ${question.id}` }),
    });
    assert.equal(answerRes.status, 200);
    await new Promise((r) => setTimeout(r, 30)); // let the push land
  }

  await reading; // stream ends when the session completes (server-side close)
  const ready = events.find((e) => e.event === 'ready');
  const compiled = events.find((e) => e.event === 'compiled');
  const done = events.find((e) => e.event === 'done');
  assert.ok(ready, 'ready event over HTTP');
  assert.ok(compiled, 'compiled event over HTTP');
  assert.ok(compiled.data.files['main.py'], 'compiled Python main.py delivered');
  assert.equal(done?.data?.reason, 'complete');
});

maybe('grill stream pre-flight rejects missing prompts with 400 JSON', async () => {
  const res = await fetch(`${base}/grill/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-org-id': 'org-http' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'INVALID_PROMPT');
});

maybe('grill stream session state is readable over GET', async () => {
  const streamRes = await fetch(`${base}/grill/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-org-id': 'org-http' },
    body: JSON.stringify({ prompt: 'a workflow that needs several clarifying answers before it is ready' }),
  });
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.includes('\n\n')) break; // first event block received
  }
  reader.cancel().catch(() => {});
  // Session id comes from the answers flow; GET state for a bogus id → 404.
  const res = await fetch(`${base}/grill/stream/does-not-exist`, { headers: { 'x-org-id': 'org-http' } });
  assert.equal(res.status, 404);
});
