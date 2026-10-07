# Installation and configuration

Set up a host, connect its agents to Matrix, and keep runtime state separate from source code. For the shortest route, start with the [README](../README.md#first-run).

[Back to Riftjack](../README.md)

## Instance layout

This repository holds only code. A running installation keeps its state in a separate *instance directory*: `.env`, `data/` (credentials, crypto stores, logs) and `.connector-history/` (working-version snapshots). Attachments are stored in `.matrix-media/` under each bot’s workspace, which can be outside the instance directory. The usual layout keeps the repository inside the instance directory:

```text
riftjack-instance/         instance: .env, data/, .connector-history/
└── riftjack/              this git repository (node_modules/ is installed here)
```

Commands below are run from the instance directory. `npm --prefix riftjack …` runs the package scripts with that directory as the instance (npm reports it as `INIT_CWD`); set `RIFTJACK_HOME=/path/to/instance` to choose another one. Scripts refuse to run when the instance has no `.env`, so the repository itself never becomes an instance by accident. Relative `DATA_DIR` values are resolved from the instance directory.

To run updated code, update the checkout in `riftjack/`, install dependencies if the lockfile changed, and send `!restart` in Matrix when the bots are idle. The supervisor loads code from the repository, snapshots it once it proves stable and rolls back on a failed start; a rollback changes files in the working tree, so `git status` shows exactly what was restored.

## Accounts and first startup

Requires Node.js 24+, Python 3, `lsof`, your Synapse server, and at least one engine: Codex with a ChatGPT login or Claude Code with a Claude login. Either engine is sufficient; the other provider’s account is not required. A [Grok worker](grok.md) is another option and requires neither CLI. Set `MATRIX_HOMESERVER` to your own server; `https://matrix.example.org` in the template is a placeholder. No OpenAI API key is needed.

1. From the instance directory, run `cp riftjack/.env.example .env` and `chmod 600 .env`. Keep this file outside the Git repository. Fill in:
   - `MATRIX_HOMESERVER`: your actual HTTPS Matrix server URL.
   - `MATRIX_OWNER_ID`: your full Matrix ID. This is the recovery administrator and the only account that can add/remove allowed accounts through the manager.
   - `SYNAPSE_ADMIN_TOKEN`: a Synapse administrator's token, used only for provisioning. Alternatively set `SYNAPSE_REGISTRATION_SHARED_SECRET`.
   - `RIFTJACK_WORKSPACE`: the default working directory for both engines when no custom workspace is selected.
2. Install dependencies with `npm --prefix riftjack ci`, then set up the engine you want:
   - **Codex:** install [Codex CLI](https://developers.openai.com/codex/cli) separately, run `codex login` and sign in with ChatGPT. Check `codex login status`. Leave `CODEX_MODEL` blank for the default. Riftjack runs `codex` from the connector’s `PATH`; set `CODEX_PATH` to an absolute executable path if needed. The installed CLI must support `codex app-server --listen stdio://`.
   - **Claude:** install [Claude Code](https://code.claude.com/docs/en/setup), run `claude auth login`, then `npm --prefix riftjack run check:claude`. Set `CLAUDE_PATH` if needed and leave `CLAUDE_MODEL` blank for its default. No Codex login is needed. See [Claude setup](claude.md).
3. Run:

   ```sh
   npm --prefix riftjack run check:config
   npm --prefix riftjack run bootstrap:codex
   # Or: npm --prefix riftjack run bootstrap:claude
   npm --prefix riftjack start
   ```

`bootstrap:codex` creates a manager and a Codex account; `bootstrap:claude` creates a manager and a Claude account. Both accounts are non-admin with distinct device sessions, and their credentials are saved locally. Each command skips bot types already present, so an interrupted partial bootstrap can be resumed. `start` brings the bots online and creates encrypted DM invitations. Accept them in Element X, then send messages normally.

All Codex bots use the same local ChatGPT login and share its plan usage limits. More bot accounts do not create additional quota. The connector forces `forced_login_method="chatgpt"` and the built-in OpenAI provider, does not pass API keys to Codex, and has no API-key fallback. The manager uses local command handling and makes no model requests. Claude bots use only the Claude login; neither engine starts the other CLI. If the plan limit is reached, wait for it to reset; the connector does not switch to separately billed API access. Any additional credits already enabled on your ChatGPT account remain governed by that account's billing settings.

Keep this process running on the machine containing your repository. Bots are unavailable while it is stopped. Local Codex/Claude integrations need no publicly reachable port or inbound tunnel. Connector MCP tools open authenticated HTTP listeners on `127.0.0.1` for the duration of a task; the CLI protocol itself uses stdio. External workers use the optional loopback listener described in [Grok setup](grok.md).

## Optional Codex command network access

Command network access is disabled by default. With `CODEX_SANDBOX=workspace-write`,
set `CODEX_NETWORK_ALLOW=github.com` to allow sandboxed HTTPS Git requests to GitHub.
Use space-separated exact DNS hostnames (at most 32); URLs, IP addresses and
wildcards are rejected. Subdomains and redirect destinations need their own entries.
Restart Riftjack after changing the instance configuration.

This uses Codex's experimental `network_proxy` feature, tested with CLI 0.160.0
on macOS. Other platforms have not been validated. Riftjack checks the effective
workspace policy before starting each task, including resumed conversations. An
unsupported CLI or conflicting inherited network settings stops the task before
it starts. In particular, Codex merges domain tables: remove broader rules from
Codex configuration rather than expecting this list to replace them. Named Codex
permission profiles are not supported with this setting.

The allowance applies to all sandboxed commands of Codex bots in this instance,
not just `git fetch`, and grants access to the domain rather than a repository or
HTTP method. Authentication for private repositories remains a separate host
configuration concern. Filesystem sandboxing and approval handling stay in place.
Claude, connector fetch tools and model/API traffic use their existing settings.
See the [Codex configuration reference](https://developers.openai.com/codex/config-reference/)
for the proxy policy.

## Optional SSH tunnel

If the public reverse proxy does not expose Synapse Admin API, the connector can maintain an SSH tunnel to the server's local port 8008. Set these in `.env`, replacing the SSH target with your server login:

```dotenv
SYNAPSE_ADMIN_URL=http://127.0.0.1:18008
SYNAPSE_SSH_TARGET=user@your-server
SYNAPSE_SSH_PORT=22
SYNAPSE_SSH_REMOTE_PORT=8008
# Optional, otherwise use the normal SSH keys or ssh-agent:
# SYNAPSE_SSH_IDENTITY=/absolute/path/to/private-key
```

OpenSSH must be installed on the connector host. First connect manually with `ssh -p 22 user@your-server`, verify the host key, and configure key or ssh-agent authentication. Automatic connections require `BatchMode=yes` and `StrictHostKeyChecking=yes`: they never prompt for passwords or silently accept unknown/changed host keys. SSH host aliases are supported; set `SYNAPSE_SSH_PORT` explicitly if the alias uses a port other than 22. The server must permit TCP forwarding to `127.0.0.1:8008`.

### Configure a restricted tunnel account

For one-time setup using an existing password-authenticated administrator, run `python3 riftjack/scripts/setup-tunnel.py --target ADMIN@SERVER --port 22` in the Mac terminal from the instance directory. It uses the existing key pair in `data/ssh/matrix_tunnel_ed25519`, requires Python 3 and sudo on a Linux server running systemd, and prompts for SSH/sudo passwords in the terminal. It creates a dedicated `matrix-tunnel` user, installs only the public key, restricts forwarding to the server's `127.0.0.1:8008`, validates and reloads SSH with a configuration backup, then tests the actual tunnel before updating `.env`. Existing unmanaged users named `matrix-tunnel` are left untouched. Global allow/deny rules may still require administrator adjustments. Send `!restart` after successful setup. Remote changes cannot be tested by local unit tests; `python3 -m unittest discover -s riftjack/test -p '*_test.py'` covers setup repeatability and configuration rollback using mocks.

### Tunnel lifecycle

After `!restart`, the connector starts the tunnel in the background, uses SSH keepalives, and reconnects with delays of 1–30 seconds after failure. It waits up to 15 seconds for the local forward before creating a bot; if SSH is unavailable, the manager returns a safe diagnostic in chat. Existing conversations continue through `MATRIX_HOMESERVER`. OpenSSH's verbose forwarding/session diagnostics are used to detect readiness; raw SSH output is not logged. A ready local tunnel does not guarantee that Synapse is listening at its remote destination; provisioning reports any subsequent API failure.

Normal shutdown and `!restart` stop and reap the managed SSH process before the connector exits. Stop any manually launched tunnel on the same local port before enabling this feature; the connector never kills unrelated listeners. A force-killed connector can leave an SSH process behind, which must be stopped on the host if it blocks the port. Bootstrap commands use the same tunnel settings and close their tunnel when finished. To disable automatic tunnelling, unset `SYNAPSE_SSH_TARGET` and restart. You can still manage the tunnel manually with `ssh -N -L 127.0.0.1:18008:127.0.0.1:8008 YOUR_SSH_TARGET`. HTTP admin endpoints are accepted only on loopback; remote endpoints must use HTTPS.

## Provisioning failures

Bot creation failures are reported in the manager DM and connector log with the failed step, API origin, HTTP status or known network/Matrix error code, and troubleshooting advice. A refused connection to a loopback Admin API includes an SSH tunnel hint. If account creation was attempted before the failure, check Synapse accounts before retrying: the account may exist even though the connector did not save its credentials. Unexpected task errors also include safe codes from nested causes. Raw exception messages, response bodies, request headers, passwords and tokens are not dumped into diagnostics. Codex RPC rejections identify the operation and numeric code, for example `Codex App Server rejected thread/resume (RPC -32602).` Report that complete message when troubleshooting; it distinguishes startup, resume and turn failures without exposing server diagnostics. Unknown operation names are shown only as `request`.

## Optional fetch tool

To let writable Codex and Claude bots read selected HTTPS resources without a
confirmation for each request, set `FETCH_ALLOW` in the instance `.env`:

```dotenv
FETCH_ALLOW=https://api.github.com/repos/OWNER/REPO/ https://logs.example.org/project/
# Optional bearer token, scoped to an allowed prefix:
# FETCH_AUTH=https://api.github.com/repos/OWNER/REPO/|/absolute/path/to/token-file
# FETCH_MAX_BYTES=20971520
# FETCH_PYTHON=/usr/bin/python3
```

Replace the example prefixes, then restart. Prefixes must end in `/` and have
no credentials, query or fragment. `FETCH_ALLOW` accepts spaces or commas;
`https://*.example.org/` matches subdomains, not the bare domain. Each
space-separated `FETCH_AUTH` entry pairs a non-wildcard allowed prefix with a
token file. If prefixes overlap, the first matching auth entry is used.
Authorization is selected again for every redirect, which must also match the
allowlist. Non-public destination addresses are refused.

Python 3 must support `dir_fd` for `os.open`, `os.mkdir` and `os.unlink`. The
connector searches `PATH`, or uses `FETCH_PYTHON`; the executable is checked
against the default workspace and must be outside it. Tokens stay out of tool
responses, but an agent able to read the token file can still obtain them.
Choose limited tokens and protect their files with host access controls.

The default response limit is 20 MiB; `FETCH_MAX_BYTES` accepts 64 KiB through
256 MiB. Requests have a 120-second deadline and at most five redirects. An
empty `FETCH_ALLOW` disables the tool. It is also unavailable to read-only bots.
See [reading web resources](chat.md#reading-web-resources) for saved files and
truncated responses.

## Codex model settings

Set `CODEX_MODEL`, `CODEX_REASONING_EFFORT` and `CODEX_SERVICE_TIER` in `.env` to pin the model, reasoning effort and service tier as defaults for Codex bots. Individual bots can override them through the manager (see [model settings](manager.md#model-settings)). Blank values inherit Codex settings. Effort and tier availability depend on the selected model and installed Codex CLI. For example, `CODEX_REASONING_EFFORT=high` selects high reasoning effort; `CODEX_SERVICE_TIER=default` explicitly selects standard speed, while `priority` requests priority processing.

Restart Riftjack after editing these settings. Explicit values apply to both new and resumed conversations, without resetting their history. They do not edit your global Codex configuration. See the [Codex configuration reference](https://developers.openai.com/codex/config-reference).
