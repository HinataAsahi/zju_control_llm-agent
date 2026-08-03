import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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

if (mode === 'version') {
  process.stdout.write('fake-codex 1.2.3\n');
  process.exit(0);
}

process.stdout.write('fake stdout\n');
process.stderr.write('fake stderr\n');

if (mode === 'nonzero') process.exit(7);
if (mode === 'hang') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1_000);
}
