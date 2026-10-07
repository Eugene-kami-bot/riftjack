// Classify CLI diagnostics; never retain or emit arbitrary server text, even in logs.
// These labels describe reported failures, not independently verified root causes.
function boundedText(value: unknown): string {
  return typeof value === 'string' && value.length <= 16_384 ? value : '';
}

export function codexAccountFailure(message: unknown): string {
  const text = boundedText(message);
  // This wrapper is present in Codex account/read errors. Its suffix can contain
  // paths, account details or credentials, and must not be forwarded.
  const loadPrefix = 'failed to load auth: ';
  const loading = text.startsWith(loadPrefix);
  const cause = loading ? text.slice(loadPrefix.length) : text;
  const refreshPrefix = 'Your access token could not be refreshed';
  if (cause.startsWith(refreshPrefix + ' because your refresh token has expired.')) return 'refresh-token-expired';
  if (cause.startsWith(refreshPrefix + ' because your refresh token was already used.')) return 'refresh-token-reused';
  if (cause.startsWith(refreshPrefix + ' because your refresh token was revoked.')) return 'refresh-token-revoked';
  if (cause.startsWith(refreshPrefix + ' because you have since logged out or signed in to another account.')) return 'auth-account-changed';
  if (cause.startsWith(refreshPrefix + '.')) return 'auth-refresh-failed';
  if (loading) return 'auth-load-failed';
  return 'unclassified';
}

export function claudeAuthenticationFailure(content: unknown): string {
  // Called only for the CLI's structured authentication_failed event. Do not
  // classify ordinary model output, or inspect tool inputs and arbitrary objects.
  if (!Array.isArray(content)) return 'unclassified';
  const block = content[0];
  const text = boundedText(block?.type === 'text' ? block.text : undefined);
  if (text === 'Not logged in · Please run /login') return 'not-logged-in';
  // The response body following this prefix may contain secrets.
  if (text.startsWith('API Error: 401 ')) return 'http-unauthorized';
  if (text.startsWith('API Error: 403 ')) return 'http-forbidden';
  return 'unclassified';
}
