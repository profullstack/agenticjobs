/**
 * The MCP request handler, independent of transport.
 *
 * Used by both hosts: the board's own /api/mcp endpoint and the stdio binary.
 */

import {
  failure,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  isNotification,
  isRequest,
  METHOD_NOT_FOUND,
  PROTOCOL_VERSION,
  result,
  type JsonRpcResponse,
} from './protocol.ts';
import { callTool, TOOLS, type Caller } from './tools.ts';

export interface ServerInfo {
  name: string;
  version: string;
}

/**
 * Handle one message.
 *
 * Returns null for a notification, which the caller must then not answer:
 * some clients treat a reply to a notification as a fatal desync rather than
 * as noise to ignore.
 */
export async function handleMessage(
  payload: unknown,
  caller: Caller,
  info: ServerInfo,
): Promise<JsonRpcResponse | null> {
  if (!isRequest(payload)) {
    return failure(null, INVALID_PARAMS, 'Not a JSON-RPC 2.0 request.');
  }
  const id = payload.id ?? null;
  const notification = isNotification(payload);

  try {
    switch (payload.method) {
      case 'initialize':
        return result(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: info,
          instructions: [
            `This is ${caller.server}, an agenticjobs board.`,
            '',
            'Every listing here was posted by its employer. Nothing is scraped, so an empty',
            'search means nobody posted that job rather than that a crawler missed it.',
            '',
            'To apply: call get_apply_schema first, then apply_to_job with exactly the fields it',
            'listed. Listings declare an agent policy of welcome, disclose or human-only; when it',
            'is "disclose", pass agentName. Disclosing is not held against a candidate on a board',
            'that asked for it.',
            '',
            'Resumes are Markdown in the OpenResume.md convention.',
          ].join('\n'),
        });

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;

      case 'ping':
        return notification ? null : result(id, {});

      case 'tools/list':
        return result(id, { tools: TOOLS });

      case 'tools/call': {
        const params = payload.params ?? {};
        const name = params['name'];
        if (typeof name !== 'string') {
          return failure(id, INVALID_PARAMS, 'tools/call needs a "name".');
        }
        const args =
          typeof params['arguments'] === 'object' && params['arguments'] !== null
            ? (params['arguments'] as Record<string, unknown>)
            : {};
        return result(id, await callTool(caller, name, args));
      }

      case 'resources/list':
        return result(id, { resources: [] });
      case 'prompts/list':
        return result(id, { prompts: [] });

      default:
        return notification ? null : failure(id, METHOD_NOT_FOUND, `No method ${payload.method}.`);
    }
  } catch (error) {
    return failure(
      id,
      INTERNAL_ERROR,
      error instanceof Error ? error.message : 'Something went wrong.',
    );
  }
}

export { TOOLS, callTool };
export type { Caller };
