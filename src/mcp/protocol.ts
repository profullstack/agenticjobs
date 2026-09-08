/**
 * Just enough MCP to be one.
 *
 * The protocol is JSON-RPC 2.0 with a small set of methods, and implementing
 * those directly keeps this package dependency-free and runnable in both
 * places it has to run: inside the server behind /api/mcp, and inside the
 * stdio binary that talks to a remote board.
 */

export const PROTOCOL_VERSION = '2025-06-18';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export function result(id: string | number | null, value: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result: value };
}

export function failure(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

export function isRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record['jsonrpc'] === '2.0' && typeof record['method'] === 'string';
}

/**
 * A notification has no id and takes no reply.
 *
 * Answering one is a protocol error that some clients tolerate and others
 * treat as a fatal desync, so it is checked rather than assumed.
 */
export function isNotification(request: JsonRpcRequest): boolean {
  return request.id === undefined || request.id === null;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  structuredContent?: unknown;
}

export function text(value: string, structured?: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: value }],
    ...(structured === undefined ? {} : { structuredContent: structured }),
  };
}

export function toolError(message: string): ToolResult {
  // Reported as a tool result rather than a JSON-RPC error on purpose: the
  // model is supposed to read it and try something else, and a transport-level
  // error is not shown to the model by most clients.
  return { content: [{ type: 'text', text: message }], isError: true };
}
