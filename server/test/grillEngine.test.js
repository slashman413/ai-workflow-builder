import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextQuestions, assessReadiness, coverageScore } from '../src/domain/grill/grillEngine.js';

test('a bare prompt is not ready and asks the critical questions', () => {
  const prompt = 'summarise my emails';
  const { ready, missing } = assessReadiness(prompt, {});
  assert.equal(ready, false);
  // outputs are signalled by "summarise"/"emails" wording, but goal/inputs/success remain.
  assert.ok(missing.includes('goal'));
  assert.ok(missing.includes('success'));
  const qs = nextQuestions(prompt, {});
  assert.ok(qs.every((q) => q.critical), 'default grill only asks critical questions');
  assert.ok(qs.some((q) => q.dimension === 'goal'));
});

test('answering critical questions covers a dimension and stops re-asking', () => {
  const prompt = 'do a thing';
  const answers = { 'goal.outcome': 'produce a one-paragraph digest' };
  const qs = nextQuestions(prompt, answers);
  assert.ok(!qs.some((q) => q.id === 'goal.outcome'), 'answered question is not re-asked');
  assert.equal(assessReadiness(prompt, answers).coverage.goal, true);
});

test('a fully answered prompt becomes ready', () => {
  const prompt = 'x';
  const answers = {
    'goal.outcome': 'digest',
    'inputs.source': 'my gmail inbox',
    'outputs.shape': 'markdown',
    'success.measure': 'no important email is omitted',
  };
  const { ready, missing } = assessReadiness(prompt, answers);
  assert.equal(ready, true, `still missing: ${missing.join(',')}`);
  assert.equal(coverageScore(prompt, answers), 1);
});

test('deep mode surfaces non-critical questions too', () => {
  const prompt = 'summarise emails so that I stay on top of my inbox';
  const shallow = nextQuestions(prompt, {});
  const deep = nextQuestions(prompt, {}, { deep: true });
  assert.ok(deep.length >= shallow.length);
  assert.ok(deep.some((q) => !q.critical), 'deep mode includes non-critical prompts');
});

test('grill is deterministic for the same inputs', () => {
  const a = nextQuestions('build me a report', { 'inputs.source': 'csv' });
  const b = nextQuestions('build me a report', { 'inputs.source': 'csv' });
  assert.deepEqual(a, b);
});

test('blank answers do not count as covering a dimension', () => {
  const { coverage } = assessReadiness('thing', { 'goal.outcome': '   ' });
  assert.equal(coverage.goal, false);
});
