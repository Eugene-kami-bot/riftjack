# Claude Code

Claude bots use the host’s Claude account and their own conversation sessions. Claude alone is sufficient to run Riftjack; no ChatGPT account or Codex login is required. This page covers setup and the behavior that differs from Codex.

[Back to Riftjack](../README.md)

Install [Claude Code](https://code.claude.com/docs/en/setup) on the connector host and sign in with your Claude account using `claude auth login`. Claude uses its own account limits, separately from ChatGPT. The connector does not forward Anthropic API keys, OAuth-token environment variables, cloud-provider credentials, or Matrix credentials to Claude. At first use, the backend checks CLI compatibility and requires `claude auth status --json` to report a logged-in `claude.ai` account. A successful check is cached for that backend instance; a failed task clears it so the next attempt checks again. Provisioning and `check:claude` also perform the check.

Set `CLAUDE_PATH` in `.env` to the executable's absolute path if `claude` is not on the connector's PATH. `CLAUDE_MODEL` is the shared default; leave it blank for the CLI default. Override it for one bot with `set model bot Research to MODEL` in the manager DM (see [model settings](manager.md#model-settings)). No new npm dependency is required. Verify the installation and login without a model request:

```sh
npm --prefix riftjack run check:claude
```

For a new installation, follow the shared [configuration steps](setup.md#accounts-and-first-startup), then bootstrap with the connector stopped:

```sh
npm --prefix riftjack run bootstrap:claude
npm --prefix riftjack start
```

This creates **Bot Manager** and **Claude**, skipping bot types already present. Accept their encrypted DM invitations and send your first task to Claude. No Codex bot is created.

To add more Claude bots to an existing installation, send `create a Claude bot called Research` to Bot Manager. It checks CLI compatibility and login before provisioning the Matrix account. Accept the encrypted invitation, then message the new bot normally.

The owner can inspect account limits with `!usage`; see [account usage](chat.md#account-usage).

## Files and follow-up messages

Claude supports the existing encrypted images, files and audio transport, `!reset`, `!cancel`, and owner-only `!restart`. PNG/JPEG/GIF/WebP images are sent as base64 image inputs, capped at 5 MiB per image for this backend; other attachments retain the Matrix size limit and are exposed as local files. Audio is not automatically transcribed. Results use the same outbox manifest as Codex.

**Updates while Claude is busy steer the current task** when the installed Claude Code supports `--replay-user-messages`. The connector writes the message into the running turn's `stream-json` input; Claude reads it at its next step, after a running tool call finishes, so the answer can take it into account. The update is confirmed only when Claude echoes it back with its UUID, and only then does Matrix report it as added to the current task. If the turn ends without that echo, delivery is reported as unconfirmed and the message is not resent automatically; check the reply and resend if needed. An update written just before the turn's result may start one more turn in the same process, whose answer is appended. Without replay support, updates are queued and run in the same Claude session after the current step. `!cancel` terminates the current Claude process and discards pending follow-ups. Codex keeps native `turn/steer` behavior.

Both engines use their bot’s configured workspace, defaulting to `RIFTJACK_WORKSPACE`. Bots can run tasks in parallel, including in the same directory; there is no shared execution lock. Their session IDs are stored separately as `claude` and `codex`; existing Codex sessions and bot credentials need no migration. The owner and globally allowed accounts can create Claude bots using the host’s Claude login. Access granted only to a specific bot does not include bot creation.

## Permissions

Claude runs with `acceptEdits`, its own Bash sandbox enabled, and unsandboxed retries available with `CLAUDE_APPROVAL_POLICY=on-request`. Ordinary commands stay sandboxed. If a required command fails because of the sandbox, Claude can request `dangerouslyDisableSandbox: true`; every unsandboxed Bash command requires one-time confirmation, even if an existing rule allows the command. Riftjack supplies a blanket Bash ask rule, which sandboxed auto-allow skips but unsandboxed execution must obey. This also covers commands excluded from the sandbox. Available built-in tools are Read, Glob, Grep, Edit, Write and Bash.

When Claude needs permission beyond those rules (for example, an edit outside the workspace), the request is sent to the encrypted conversation as a confirmation with an ID, answered with `!approve [ID]` or `!deny [ID]` exactly as for Codex. The message shows the tool and its full input; approval applies to that one request and creates no permanent rule. Unanswered requests expire when the task stops or Claude withdraws them.

Set `CLAUDE_APPROVAL_POLICY=never` to disable unsandboxed retries and deny permission requests without prompting. Retries are also disabled when no confirmation handler is available. With `CODEX_SANDBOX=read-only`, Claude uses `dontAsk` and only Read, Glob and Grep. Claude's permission system is independent of the Codex sandbox; it must be supported and configured correctly on the host. No `--dangerously-skip-permissions` option is used.

`check:claude` checks advertised CLI flags and authentication, not a full model round trip. After connecting Claude, send a small task and verify its result and any permission request in Matrix. See [development and validation](development.md).
