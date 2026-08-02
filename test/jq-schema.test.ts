import assert from 'node:assert/strict';
import test from 'node:test';
import { jqQueryInputSchema } from '../src/jq-schema.js';

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
