import { isIP } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { PublicError } from './errors.js';

export function codexNetworkDomains(value: string | undefined): string[] {
  const domains = [...new Set((value || '').trim().toLowerCase().split(/\s+/).filter(Boolean))];
  if (domains.length > 32 || domains.some(host => host.length > 253 || isIP(host) ||
    !host.includes('.') || host.endsWith('.localhost') || host.endsWith('.local') ||
    !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) {
    throw new Error('CODEX_NETWORK_ALLOW must contain at most 32 exact public DNS hostnames separated by spaces (no URLs, IPs or wildcards).');
  }
  return domains;
}

// Keep startup, new threads and resumed threads on the same network policy.
export function codexNetworkConfig(domains: readonly string[]) {
  return {
    'sandbox_workspace_write.network_access': domains.length > 0,
    'features.network_proxy': domains.length ? {
      enabled: true,
      domains: Object.fromEntries(domains.map(host => [host, 'allow'])),
      proxy_url: 'http://127.0.0.1:0',
      socks_url: 'http://127.0.0.1:0',
      enable_socks5: false,
      enable_socks5_udp: false,
      allow_upstream_proxy: false,
      allow_local_binding: false,
      dangerously_allow_non_loopback_proxy: false,
      dangerously_allow_all_unix_sockets: false,
      unix_sockets: {},
    } : false as const,
  };
}

function toml(value: unknown): string {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function codexNetworkArgs(domains: readonly string[]): string[] {
  return [...(domains.length ? ['--enable', 'network_proxy'] : []),
    ...Object.entries(codexNetworkConfig(domains)).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`])];
}

// Codex merges tables across config layers. An inherited wildcard must never
// silently broaden the connector's policy. Check the effective workspace config
// before allowing a model turn; unsupported CLIs must fail closed as well.
export function verifyCodexNetwork(config: any, domains: readonly string[]): void {
  if (config?.sandbox_mode !== 'workspace-write' || config.default_permissions != null ||
    config.sandbox_workspace_write?.network_access !== true ||
    !isDeepStrictEqual(config.features?.network_proxy, codexNetworkConfig(domains)['features.network_proxy'])) {
    throw new PublicError('Codex could not verify CODEX_NETWORK_ALLOW. Use a CLI with network_proxy support and remove conflicting network settings from Codex configuration. No task was started.');
  }
}
