import { stat, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { FunctionTool, ToolGateway } from './model-client.js';

const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const MAX_STDERR_BYTES = 64 * 1024;

export interface McpToolBridgeOptions {
  serverEntrypoint: string;
  root: string;
  operationTimeoutMs?: number;
}

export class McpToolBridge implements ToolGateway {
  readonly #client: Client;
  readonly #operationTimeoutMs: number;
  #closed = false;

  private constructor(client: Client, operationTimeoutMs: number) {
    this.#client = client;
    this.#operationTimeoutMs = operationTimeoutMs;
  }

  static async connect(options: McpToolBridgeOptions): Promise<McpToolBridge> {
    const operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs <= 0) {
      throw new Error('MCP operation timeout must be a positive integer.');
    }
    const serverEntrypoint = await requirePath(options.serverEntrypoint, 'file', 'server entrypoint');
    const root = await requirePath(options.root, 'directory', 'MCP root');
    const client = new Client(
      { name: 'stage2b-agent-runner', version: '0.1.0' },
      { versionNegotiation: { mode: 'legacy' } }
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverEntrypoint, '--root', root],
      cwd: dirname(serverEntrypoint),
      env: restrictedEnvironment(),
      stderr: 'pipe'
    });
    drainBoundedStderr(transport);

    try {
      await client.connect(transport);
      return new McpToolBridge(client, operationTimeoutMs);
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async listTools(signal: AbortSignal): Promise<FunctionTool[]> {
    this.#requireOpen();
    const response = await this.#client.listTools(undefined, {
      signal,
      timeout: this.#operationTimeoutMs,
      maxTotalTimeout: this.#operationTimeoutMs
    });
    return response.tools.map(tool => {
      if (!isRecord(tool.inputSchema)) {
        throw new Error(`MCP tool ${tool.name} has an invalid input schema.`);
      }
      return {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.inputSchema
      };
    });
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<string> {
    this.#requireOpen();
    const response = await this.#client.callTool({ name, arguments: args }, {
      signal,
      timeout: this.#operationTimeoutMs,
      maxTotalTimeout: this.#operationTimeoutMs
    });
    if (response.structuredContent !== undefined) {
      return JSON.stringify(response.structuredContent);
    }
    return JSON.stringify({
      ...(response.isError === true ? { isError: true } : {}),
      content: response.content
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#client.close();
  }

  #requireOpen(): void {
    if (this.#closed) throw new Error('MCP tool bridge is closed.');
  }
}

async function requirePath(
  path: string,
  expected: 'file' | 'directory',
  label: string
): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    throw new Error(`Unable to resolve ${label}.`);
  }
  const metadata = await stat(canonical);
  const valid = expected === 'file' ? metadata.isFile() : metadata.isDirectory();
  if (!valid) throw new Error(`The ${label} must be a ${expected}.`);
  return canonical;
}

function restrictedEnvironment(): Record<string, string> {
  const lang = process.env.LANG ?? 'C.UTF-8';
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: lang,
    LC_ALL: process.env.LC_ALL ?? lang
  };
}

function drainBoundedStderr(transport: StdioClientTransport): void {
  let observed = 0;
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    if (observed >= MAX_STDERR_BYTES) return;
    observed += Math.min(Buffer.byteLength(chunk), MAX_STDERR_BYTES - observed);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
