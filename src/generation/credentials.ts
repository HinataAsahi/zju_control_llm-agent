import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface LoadDeepSeekApiKeyOptions {
  env?: NodeJS.ProcessEnv;
  configPath?: string;
}

export async function loadDeepSeekApiKey(
  options: LoadDeepSeekApiKeyOptions = {}
): Promise<string> {
  const environmentKey = (options.env ?? process.env).DEEPSEEK_API_KEY?.trim();
  if (environmentKey) return environmentKey;

  const path = options.configPath
    ?? join(homedir(), '.config', 'zju-control-llm-agent', 'deepseek.key');
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new Error('DeepSeek API key is unavailable in the environment or local configuration.');
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('DeepSeek API key path must be a regular file.');
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error('DeepSeek API key file permissions must be 0600.');
  }
  const key = (await readFile(path, 'utf8')).trim();
  if (!key) throw new Error('DeepSeek API key file is empty.');
  return key;
}
