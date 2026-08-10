import assert from 'node:assert/strict';
import test from 'node:test';
import {
  answerMatchesExpected,
  parseExperimentAnswer,
  parseExperimentAnswerText
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

test('parses bare or singly fenced JSON without extracting from prose', () => {
  const json = '{"status":"completed","answer":3,"explanation":"done"}';

  assert.equal(parseExperimentAnswerText(json).answer, 3);
  assert.equal(parseExperimentAnswerText(`\n\`\`\`json\n${json}\n\`\`\`\n`).answer, 3);
  assert.throws(() => parseExperimentAnswerText(`Result:\n\`\`\`json\n${json}\n\`\`\``));
  assert.throws(() => parseExperimentAnswerText(`\`\`\`javascript\n${json}\n\`\`\``));
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
