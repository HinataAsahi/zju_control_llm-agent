import assert from 'node:assert/strict';
import test from 'node:test';
import {
  answerMatchesExpected,
  parseExperimentAnswer
} from '../../src/experiment/schema.js';

test('parses strict completed and cannot-complete answers', () => {
  assert.deepEqual(parseExperimentAnswer({
    status: 'completed',
    answer: { total: 3 },
    explanation: 'Counted the matching records.'
  }), {
    status: 'completed',
    answer: { total: 3 },
    explanation: 'Counted the matching records.'
  });
  assert.deepEqual(parseExperimentAnswer({
    status: 'cannot_complete',
    answer: null,
    explanation: 'The source file is missing.'
  }), {
    status: 'cannot_complete',
    answer: null,
    explanation: 'The source file is missing.'
  });
});

test('rejects unknown fields and non-JSON answer values', () => {
  assert.throws(() => parseExperimentAnswer({
    status: 'completed',
    answer: 3,
    explanation: 'done',
    extra: true
  }));
  assert.throws(() => parseExperimentAnswer({
    status: 'completed',
    answer: undefined,
    explanation: 'done'
  }));
});

test('compares expected JSON canonically while preserving array order', () => {
  const answer = {
    status: 'completed' as const,
    answer: { b: 2, a: { y: [1, 2], x: true } },
    explanation: 'done'
  };

  assert.equal(answerMatchesExpected(answer, {
    status: 'completed',
    answer: { a: { x: true, y: [1, 2] }, b: 2 }
  }), true);
  assert.equal(answerMatchesExpected(answer, {
    status: 'completed',
    answer: { a: { x: true, y: [2, 1] }, b: 2 }
  }), false);
});
