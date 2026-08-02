import assert from 'node:assert/strict';
import test from 'node:test';
import {
  jqQueryInputSchema,
  jqQueryOutputSchema,
  MAX_JSON_DEPTH
} from '../src/jq-schema.js';

function nestedArray(depth: number): unknown {
  let value: unknown = null;
  for (let level = 0; level < depth; level += 1) value = [value];
  return value;
}

test('accepts inline and file sources', () => {
  assert.equal(jqQueryInputSchema.safeParse({
    filter: '.users | length',
    source: { type: 'inline', data: { users: ['Alice', 'Bob'] } }
  }).success, true);
  assert.equal(jqQueryInputSchema.safeParse({
    filter: '.',
    source: { type: 'file', path: 'users.json' }
  }).success, true);
  assert.equal(jqQueryInputSchema.safeParse({
    filter: '.',
    source: { type: 'inline', data: null }
  }).success, true);
});

test('rejects malformed discriminated sources and unknown fields', () => {
  const invalid = [
    { filter: '.', source: { type: 'inline', path: 'users.json' } },
    { filter: '.', source: { type: 'file', data: {} } },
    { filter: '.', source: { type: 'inline', data: {}, path: 'users.json' } },
    { filter: '.', source: { type: 'other', data: {} } },
    { filter: '.', source: { type: 'file', path: 'users.json', extra: true } }
  ];
  for (const value of invalid) assert.equal(jqQueryInputSchema.safeParse(value).success, false);
});

test('enforces non-empty and 4 KiB UTF-8 filter limits', () => {
  assert.equal(jqQueryInputSchema.safeParse({
    filter: '', source: { type: 'inline', data: null }
  }).success, false);
  assert.equal(jqQueryInputSchema.safeParse({
    filter: '界'.repeat(1366), source: { type: 'inline', data: null }
  }).success, false);
});

test('accepts JSON at the nesting limit and rejects deeper input without throwing', () => {
  assert.equal(jqQueryInputSchema.safeParse({
    filter: '.', source: { type: 'inline', data: nestedArray(MAX_JSON_DEPTH) }
  }).success, true);

  const result = jqQueryInputSchema.safeParse({
    filter: '.', source: { type: 'inline', data: nestedArray(5000) }
  });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.error.issues[0]?.message ?? '', /nesting/i);
  }
});

test('applies the JSON nesting limit to structured output', () => {
  const result = jqQueryOutputSchema.safeParse({
    ok: true,
    values: [nestedArray(MAX_JSON_DEPTH + 1)],
    exitCode: 0
  });
  assert.equal(result.success, false);
});
