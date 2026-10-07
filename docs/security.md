# Access and encryption

Matrix encryption protects transport between chat devices and the bots. The host decrypts messages before passing them to Codex or Claude Code; model inference is outside Matrix encryption. Agents run with the host’s configured permissions.

[Back to Riftjack](../README.md)

## Keep runtime data private

Keep the instance directory outside the repository: real `.env` files, account tokens, Matrix crypto/recovery keys, SSH keys, conversations, logs, attachments and backups belong there. The repository includes only `.env.example` with placeholders and empty credentials. Never paste a real login, password, token, private key or deployment address into source files, documentation, test fixtures or image metadata. Tests use synthetic values and generate temporary crypto keys.

`.gitignore` excludes instance data, environment variants, local agent/cloud settings, key files, databases and backup archives. It does not inspect source contents or remove previously tracked files; `git add -f` bypasses it. Before the first commit and before publishing, review `git status --short` and `git diff --cached --stat`, and scan the staged content for secrets (for example with Gitleaks). If a real secret ever enters Git history, removing the working file is insufficient: revoke or rotate the secret and clean the history before sharing it.

## Credentials and backups

`.env` and `data/` are gitignored. Bot credentials, session mappings, sync positions, and encryption keys live in `data/`, using private filesystem permissions. Preserve and back up that directory together. Never run two instances against the same data directory. An exclusive SQLite transaction in `data/connector.lock.sqlite` holds an OS file lock for the connector lifetime. The OS releases it after a crash or reboot; stale `data/connector.pid` contents do not block startup. The PID file is diagnostic only. Keep the data directory on a local filesystem with working file locks, and never delete or replace the lock database while a connector may be running.

The admin provisioning path creates a non-admin Synapse account and signs in with a generated password to obtain a device-bound token. It does not use the admin impersonation endpoint, which lacks a device. Shared-secret registration is also supported. These provisioning methods require Synapse's native authentication; Matrix Authentication Service requires a different adapter. Check that your homeserver supports native password login before provisioning accounts.

If account creation succeeds but a subsequent login/network request fails, a server account may exist without a saved token. The connector does not delete it or reset its password automatically; recover or remove that account using your server administration tools. The manager never upgrades bot accounts to admins.

## Device identity and verification

At startup, the connector sets up cross-signing for bot accounts that do not already have an identity, then signs each bot's device with its account's self-signing key. This addresses Element's “encrypted by a device not verified by its owner” warning. Recovery material is saved locally in each bot's `data/bots/<hash>/device-recovery.json` with mode 600 before publishing keys; encrypted recovery secrets are also stored in Matrix Secret Storage. Back up the whole data directory, including these files, and never send recovery files in chat. Initial cross-signing is supported without password reauthentication by compatible Synapse servers; if the server requires interactive authentication, setup reports a failure and leaves messaging available.

The connector reuses signing keys after network failures and restarts. It can restore a replacement device from its saved recovery material, but never resets an external identity or overwrites unrelated recovery settings. Verification failures are logged without stopping encrypted messaging. The adapter uses the existing crypto engine from the pinned Matrix SDK; no second machine opens its live database. Interactive emoji verification with a human is still not implemented. Trusting the bot's account from your own Element session is separate from its device being signed by its owner. Old messages may keep their previous warning until the client refreshes trust information; inspect a new message after restarting. Matrix E2EE does not extend through model inference: the bot decrypts messages and sends their content to the selected engine.

## Private rooms

In ordinary private conversations, bots process messages and send replies,
confirmations, attachments and restart notices only after checking the current
room state. The room must use Megolm
encryption, invite-only joining and `joined` history visibility, with exactly
the bot and the allowed conversation partner joined. A third joined, invited or
knocking member blocks the conversation. Rooms with `shared`, `invited` or
`world_readable` history are not accepted. Set history visibility to “since they
joined” in the Matrix client, or use a new DM created by the bot manager.

[Configured shared rooms](shared-conversations.md) are an explicit exception to
the two-person rule: they require exactly the linked human and two bots, with
the same encryption, join and history settings and no extra invitations.

These checks do not retract messages or encryption keys already delivered to
other devices. Matrix membership changes and sends are separate server requests;
keep sensitive conversations in dedicated private rooms.

## Shared resources

Ordinary conversation histories are scoped by bot, account, room, and thread. Session links intentionally reuse one agent history across its private and shared rooms; routing rules do not provide strict separation of what that model knows. Bots still share the host OS account and the corresponding provider login. Bots assigned the same workspace can read and change the same files. Separate chats and per-bot access lists are not filesystem isolation. Use a separate OS account or container when you need that boundary.

Codex uses a workspace-write or read-only sandbox; command network access is disabled by default. Optional `CODEX_NETWORK_ALLOW` allows exact domains through the Codex network proxy for workspace-write commands; it is a domain allowance for all such commands, not a Git-only or read-only permission. See [configuration and limits](setup.md#optional-codex-command-network-access). The default on-request policy forwards exceptions to Matrix. Claude has its own permission model, described in [Claude Code](claude.md#permissions). Connector credentials are filtered from both backends’ subprocess environments.

[Confirmation handling](chat.md#confirmations-and-answers) describes sender checks, request expiry, and reaction metadata. [Attachments](chat.md#images-files-and-audio) describes encrypted file transfer and workspace storage.

## External worker access

Grok workers authenticate with a separate per-bot token. They receive only tasks
for that bot and can reply only to the task's saved destination. Matrix credentials
and encryption keys stay on the connector. Worker transfers carry decrypted
conversation data; use SSH or HTTPS between machines. The listener is disabled
by default and binds to loopback when enabled. Worker tools and approvals are
controlled by the remote environment, not by Riftjack's local sandbox. See
[worker setup and delivery guarantees](grok.md).

## Authentication diagnostics

Codex `account/read` internal errors and Claude's structured
`authentication_failed` events include a fixed `Diagnostic` category in chat
and the existing connector error log. Known messages distinguish loading auth,
refresh-token failures, an account change, a missing Claude login, and Claude
HTTP 401/403 responses. These are classifications of what the CLI reported,
not independently verified causes. Unknown, malformed or oversized messages
report `unclassified`; a generic RPC -32603 does not establish an auth failure.

Raw RPC error text, error data and CLI stderr are not retained or forwarded.
Categories contain no account identifiers, paths, tokens or response bodies.
There is no automatic retry, token refresh, logout or conversation reset.
After recovery, the original cause may remain unknown if the CLI message was
not recognized. A restart restoring service is not proof of a permanent fix.
