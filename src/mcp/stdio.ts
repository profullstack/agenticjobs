/**
 * MCP over stdio, pointed at a board.
 *
 * The same tools the board serves at /api/mcp, hosted in a local process so a
 * client that only speaks stdio can use a remote board. Credentials come from
 * the terminal's own config, so `agenticjobs login` is the whole setup.
 *
 * Nothing may ever be written to stdout except protocol frames: a stray
 * console.log corrupts the stream and the client reports a parse error with no
 * indication of where it came from. Diagnostics go to stderr.
 */

import process from 'node:process';
import { VERSION, SOFTWARE_NAME } from '../config.ts';
import type { BoardClient } from '../client/client.ts';
import { ApiError } from '../client/client.ts';
import { handleMessage } from './server.ts';
import type { Caller } from './tools.ts';

export async function startStdio(client: BoardClient): Promise<void> {
  const caller: Caller = {
    server: client.server,
    authenticated: client.hasToken(),
    call: async (method, path, body) => {
      try {
        // Keep the real status. Create routes answer 201; reporting 200 here
        // made apply_to_job / post_job / post_update fail after a successful write.
        return await client.requestWithStatus<unknown>(method, path, body);
      } catch (error) {
        if (error instanceof ApiError) {
          return {
            status: error.status,
            body: { error: { message: error.message, code: error.code, fields: error.fields } },
          };
        }
        throw error;
      }
    },
  };

  const info = { name: `${SOFTWARE_NAME}-mcp`, version: VERSION };
  process.stderr.write(`${SOFTWARE_NAME}-mcp ${VERSION} -> ${client.server}\n`);

  let buffer = '';
  process.stdin.setEncoding('utf8');

  for await (const chunk of process.stdin) {
    buffer += chunk;
    // Line-delimited JSON. A partial line stays in the buffer until the rest
    // of it arrives, which is the normal case on a busy pipe.
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (line === '') continue;

      let payload: unknown;
      try {
        payload = JSON.parse(line);
      } catch {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } })}\n`,
        );
        continue;
      }

      const answer = await handleMessage(payload, caller, info);
      if (answer !== null) process.stdout.write(`${JSON.stringify(answer)}\n`);
    }
  }
}

// Run directly when this module is the entry point, so the published binary
// works without the CLI in front of it.
if (process.argv[1]?.endsWith('agenticjobs-mcp.mjs') === true) {
  const { BoardClient: Client } = await import('../client/client.ts');
  const { currentBoard, DEFAULT_SERVER, loadConfig, normaliseServer } = await import(
    '../client/config.ts'
  );

  const index = process.argv.indexOf('--server');
  const explicit = index >= 0 ? process.argv[index + 1] : undefined;

  let server: string;
  let token: string | null = null;
  if (explicit !== undefined) {
    server = normaliseServer(explicit);
    token = loadConfig().boards[server]?.token ?? null;
  } else {
    const board = currentBoard();
    server = board?.server ?? DEFAULT_SERVER;
    token = board?.token ?? null;
  }

  await startStdio(new Client(server, { token, userAgent: `agenticjobs-mcp/${VERSION}` }));
}
