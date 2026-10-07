// Only deliberately authored messages may be shown verbatim in chat or logs.
export class PublicError extends Error {}

// Provider text stays separate from the public message used in rooms and host logs.
export class OwnerDiagnosticError extends PublicError {
  readonly #details: string;
  constructor(message: string, details: string) {
    super(message);
    this.#details = details;
  }
  ownerDetails(): string { return this.#details; }
}

const codes = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'EPERM', 'EACCES', 'ENOENT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'M_FORBIDDEN', 'M_UNAUTHORIZED', 'M_UNKNOWN_TOKEN', 'M_MISSING_TOKEN',
  'M_LIMIT_EXCEEDED', 'M_NOT_FOUND', 'M_UNRECOGNIZED', 'M_USER_IN_USE',
  'M_INVALID_USERNAME', 'M_BAD_JSON', 'M_NOT_JSON', 'M_UNKNOWN',
]);
const names = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AggregateError', 'AbortError', 'TimeoutError']);

// Do not stringify exceptions: SDK errors can embed tokens, passwords and request bodies.
// Bounded traversal also handles Node fetch's AggregateError and cyclic causes.
export function safeErrorSummary(error: unknown): string {
  const parts = new Set<string>();
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  for (let i = 0; i < queue.length && i < 20; i++) {
    const item = queue[i];
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    const e = item as { name?: unknown; code?: unknown; errcode?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown; errors?: unknown };
    if (typeof e.name === 'string' && names.has(e.name)) parts.add(e.name);
    for (const code of [e.code, e.errcode]) if (typeof code === 'string' && codes.has(code)) parts.add(code);
    for (const status of [e.status, e.statusCode]) {
      if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) parts.add(`HTTP ${status}`);
    }
    if (queue.length < 20) queue.push(e.cause);
    if (Array.isArray(e.errors)) queue.push(...e.errors.slice(0, Math.max(0, 20 - queue.length)));
  }
  return [...parts].join(', ') || 'Error (no safe diagnostic details available)';
}

export function errorMessage(error: unknown, context = 'Task failed'): string {
  return error instanceof PublicError ? error.message : `${context}: ${safeErrorSummary(error)}.`;
}

export function connectionHint(details: string): string {
  if (/ECONNREFUSED/.test(details)) return 'Connection refused. Check that the service is running and its port is reachable.';
  if (/ENOTFOUND|EAI_AGAIN/.test(details)) return 'DNS lookup failed. Check the server hostname and DNS connection.';
  if (/Timeout|TIMEOUT|ETIMEDOUT/.test(details)) return 'The request timed out. Check server availability, network and proxy settings.';
  if (/CERT|SELF_SIGNED|LEAF_SIGNATURE/.test(details)) return 'TLS certificate validation failed. Check the server certificate and certificate chain.';
  if (/EPERM|EACCES/.test(details)) return 'Access was denied locally. Check connector network permissions and firewall rules.';
  return 'Check server connectivity and proxy settings.';
}
