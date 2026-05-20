#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, SERVER_NAME, SERVER_VERSION } from './server.js';

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  // SIGINT and SIGTERM should let any in-flight Codex subprocess finish its
  // close handlers before the host process exits, so partial JSON does not
  // appear in user-visible output.
  const shutdown = (signal: NodeJS.Signals): void => {
    process.stderr.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        tool: SERVER_NAME,
        event: 'shutdown',
        signal,
      }) + '\n',
    );
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      tool: SERVER_NAME,
      event: 'start',
      version: SERVER_VERSION,
    }) + '\n',
  );

  await server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      tool: SERVER_NAME,
      event: 'fatal',
      error: err instanceof Error ? err.message : String(err),
    }) + '\n',
  );
  process.exit(1);
});
