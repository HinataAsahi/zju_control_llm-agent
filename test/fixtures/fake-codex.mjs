#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

if (process.argv.length === 3 && process.argv[2] === '--version') {
  process.stdout.write('codex-cli 1.2.3\n');
  process.exit(0);
}

const workspacePath = process.argv[process.argv.lastIndexOf('-C') + 1];
const observationPath = workspacePath ? join(workspacePath, '.fake-codex-observation.json') : undefined;
const mode = workspacePath ? (await readFile(join(workspacePath, '.fake-codex-mode'), 'utf8').catch(() => 'success')).trim() : 'success';
const stdin = await new Promise((resolve, reject) => {
  let value = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { value += chunk; });
  process.stdin.on('end', () => resolve(value));
  process.stdin.on('error', reject);
});

if (observationPath) {
  await writeFile(observationPath, JSON.stringify({ argv: process.argv.slice(2), stdin, env: process.env }));
}

process.stdout.write('fake stdout\n');
process.stderr.write('fake stderr\n');

if (mode === 'nonzero') process.exit(7);
if (mode === 'hang') {
  process.on('SIGTERM', () => {});
  await writeFile(join(workspacePath, '.fake-codex-ready'), 'ready\n');
  setInterval(() => {}, 1_000);
}
