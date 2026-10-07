import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexNetworkDomains, codexNetworkConfig, verifyCodexNetwork } from '../src/codex-network.js';
import { loadConfig } from '../src/config.js';

test('network allowlist accepts only bounded exact DNS names', () => {
  assert.deepEqual(codexNetworkDomains(undefined), []);
  assert.deepEqual(codexNetworkDomains(' Github.com\napi.github.com github.com '), ['github.com', 'api.github.com']);
  for (const invalid of ['*', '*.github.com', 'https://github.com', 'github.com:443',
    'github.com/path', '127.0.0.1', '::1', 'localhost', 'foo.localhost', 'foo.local',
    'github.com.', '-github.com', 'github..com', 'github.com,example.org']) {
    assert.throws(() => codexNetworkDomains(invalid), /CODEX_NETWORK_ALLOW/);
  }
  assert.throws(() => codexNetworkDomains(Array.from({length:33}, (_,i)=>`h${i}.example.org`).join(' ')), /CODEX_NETWORK_ALLOW/);
});

test('network is closed by default; enabling exact domains requires the proxy', () => {
  assert.equal(codexNetworkConfig([])['sandbox_workspace_write.network_access'], false);
  const config = codexNetworkConfig(['github.com']);
  assert.equal(config['sandbox_workspace_write.network_access'], true);
  const proxy = config['features.network_proxy'];
  assert.ok(proxy);
  assert.equal(proxy.enabled, true);
  assert.deepEqual(proxy.domains, {'github.com':'allow'});
  assert.equal(proxy.allow_local_binding, false);
  assert.equal(proxy.allow_upstream_proxy, false);
  assert.equal(proxy.dangerously_allow_all_unix_sockets, false);
});

test('network allowlist cannot silently change the read-only policy', () => {
  assert.throws(() => loadConfig({MATRIX_HOMESERVER:'https://example.org', MATRIX_OWNER_ID:'@owner:example.org',
    RIFTJACK_WORKSPACE:process.cwd(), CODEX_SANDBOX:'read-only', CODEX_NETWORK_ALLOW:'github.com'}), /requires CODEX_SANDBOX/);
});


test('effective config verification rejects inherited domains and alternate permission profiles', () => {
  const proxy = codexNetworkConfig(['github.com'])['features.network_proxy'];
  assert.ok(proxy);
  const expected = { sandbox_mode: 'workspace-write', sandbox_workspace_write: { network_access: true },
    features: { network_proxy: proxy } };
  verifyCodexNetwork(expected, ['github.com']);
  for (const config of [null, {}, { ...expected, default_permissions: 'unrestricted' },
    { ...expected, features: { network_proxy: true } },
    { ...expected, features: { network_proxy: { ...expected.features.network_proxy, domains: { '*': 'allow', 'github.com': 'allow' } } } }]) {
    assert.throws(() => verifyCodexNetwork(config, ['github.com']), /could not verify/);
  }
});
