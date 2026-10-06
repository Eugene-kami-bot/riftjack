import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadTunnelConfig } from './ssh-tunnel.js';
import { loadFetchConfig } from './fetch.js';

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Set ${name} in .env (see .env.example).`);
    return value;
  };
  const homeserver = new URL(required('MATRIX_HOMESERVER'));
  if (homeserver.protocol !== 'https:' || homeserver.username || homeserver.password || homeserver.search || homeserver.hash) {
    throw new Error('MATRIX_HOMESERVER must be an HTTPS URL without credentials, query, or fragment.');
  }
  const adminUrl = new URL(env.SYNAPSE_ADMIN_URL?.trim() || homeserver.toString());
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(adminUrl.hostname);
  if ((adminUrl.protocol !== 'https:' && !(adminUrl.protocol === 'http:' && loopback)) || adminUrl.username || adminUrl.password || adminUrl.search || adminUrl.hash) {
    throw new Error('SYNAPSE_ADMIN_URL must use HTTPS, or HTTP on loopback for an SSH tunnel, without credentials, query, or fragment.');
  }
  const owner = required('MATRIX_OWNER_ID');
  if (!/^@[^\s:]+:[^\s]+$/.test(owner)) throw new Error('MATRIX_OWNER_ID must be your full Matrix user ID.');
  const workspace = realpathSync(resolve(required('RIFTJACK_WORKSPACE')));
  if (!statSync(workspace).isDirectory()) throw new Error('RIFTJACK_WORKSPACE must be a directory.');
  const sandbox = env.CODEX_SANDBOX?.trim() || 'workspace-write';
  if (sandbox !== 'workspace-write' && sandbox !== 'read-only') throw new Error('CODEX_SANDBOX must be workspace-write or read-only.');
  const codexApprovalPolicy = env.CODEX_APPROVAL_POLICY?.trim() || 'on-request';
  if (codexApprovalPolicy !== 'on-request' && codexApprovalPolicy !== 'never') throw new Error('CODEX_APPROVAL_POLICY must be on-request or never.');
  const claudeApprovalPolicy = env.CLAUDE_APPROVAL_POLICY?.trim() || 'on-request';
  if (claudeApprovalPolicy !== 'on-request' && claudeApprovalPolicy !== 'never') throw new Error('CLAUDE_APPROVAL_POLICY must be on-request or never.');
  const timeoutMs = Number(env.TASK_TIMEOUT_SECONDS || '86400') * 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 86_400_000) {
    throw new Error('TASK_TIMEOUT_SECONDS must be between 1 and 86400.');
  }
  const maxMediaBytes = Number(env.MAX_MEDIA_BYTES || '536870912');
  if (!Number.isSafeInteger(maxMediaBytes) || maxMediaBytes < 1 || maxMediaBytes > 536_870_912) {
    throw new Error('MAX_MEDIA_BYTES must be between 1 and 536870912 (512 MiB).');
  }
  const mediaUploadTimeoutMs = Number(env.MEDIA_UPLOAD_TIMEOUT_SECONDS || '1800') * 1000;
  if (!Number.isSafeInteger(mediaUploadTimeoutMs) || mediaUploadTimeoutMs < 1000 || mediaUploadTimeoutMs > 86_400_000) {
    throw new Error('MEDIA_UPLOAD_TIMEOUT_SECONDS must be between 1 and 86400.');
  }
  const workerPort = Number(env.WORKER_PORT || '0');
  if (!Number.isInteger(workerPort) || workerPort < 0 || workerPort > 65535) throw new Error('WORKER_PORT must be 0 (disabled) or a port from 1 to 65535.');
  return {
    workerPort,
    homeserver: homeserver.toString().replace(/\/$/, ''),
    adminUrl: adminUrl.toString().replace(/\/$/, ''),
    sshTunnel: loadTunnelConfig(env, adminUrl),
    owner,
    registrationSecret: env.SYNAPSE_REGISTRATION_SHARED_SECRET?.trim(),
    adminToken: env.SYNAPSE_ADMIN_TOKEN?.trim(),
    codexModel: env.CODEX_MODEL?.trim() || undefined,
    codexReasoningEffort: env.CODEX_REASONING_EFFORT?.trim() || undefined,
    codexServiceTier: env.CODEX_SERVICE_TIER?.trim() || undefined,
    codexPath: env.CODEX_PATH?.trim() || 'codex',
    claudeModel: env.CLAUDE_MODEL?.trim() || undefined,
    claudePath: env.CLAUDE_PATH?.trim() || 'claude',
    claudeApprovalPolicy: claudeApprovalPolicy as 'on-request' | 'never',
    workspace,
    sandbox: sandbox as 'workspace-write' | 'read-only',
    codexApprovalPolicy: codexApprovalPolicy as 'on-request' | 'never',
    dataDir: resolve(env.DATA_DIR || './data'),
    timeoutMs,
    maxMediaBytes,
    mediaUploadTimeoutMs,
    fetch: loadFetchConfig(env, workspace),
  };
}
export type Config = ReturnType<typeof loadConfig>;
