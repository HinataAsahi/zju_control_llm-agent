import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { pathToFileURL } from 'node:url';
import { loadConfig, type AppConfig } from './config.js';
import { verifyJqExecutable } from './jq-executor.js';
import { jqQueryInputSchema, jqQueryOutputSchema } from './jq-schema.js';
import { createJqToolHandler } from './jq-tool.js';

export function createServer(config: AppConfig): McpServer {
  const server = new McpServer({ name: 'jq-mcp-server', version: '0.1.0' });
  server.registerTool('jq_query', {
    description: 'Run one jq filter against inline JSON or an allowed task file.',
    inputSchema: jqQueryInputSchema,
    outputSchema: jqQueryOutputSchema
  }, createJqToolHandler(config));
  return server;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const config = await loadConfig(argv);
  await verifyJqExecutable(config.jqExecutable);
  const transport = new StdioServerTransport();
  const server = createServer(config);
  await server.connect(transport);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unable to start jq MCP server.';
    console.error(message);
    process.exitCode = 1;
  });
}
