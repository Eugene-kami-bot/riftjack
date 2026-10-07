# Riftjack

**A shell for coding agents in Matrix.**

Give your agents an address you can message. Riftjack connects Codex and Claude Code on your computer to encrypted Matrix conversations. Send a task, share a file, follow the work, and answer approval requests from your phone or desktop. These agents work in your local project directories. [Grok and other external workers](docs/grok.md) can also receive tasks and send replies through Riftjack, using a durable inbox instead of their own Matrix client.

Keep a conversation open for each project. Come back with a question, a correction, or the next idea.

## A conversation with your workspace

Use Element X or another Matrix client. Accept your bot’s encrypted chat invitation and write normally:

> Find out why the tests fail. Explain the cause before changing anything.
>
> Keep the public API as it is.
>
> Send me the patch when you’re done.

You can send text, images, documents, and audio files, and receive files back. Codex and Claude can deliver ready files while continuing to work. Images reach the agent as image inputs; documents and audio are provided as local files. Audio transcription depends on the agent’s available tools.

Messages sent while Codex works can steer its active task. Claude also accepts updates into its running task when its CLI supports message replay; otherwise it queues follow-ups. See [messages during work](docs/chat.md#messages-during-work). When an action needs permission, the bot brings the request into the same conversation. Approve the displayed request with `!approve` or ✅, or decline with `!deny` or ❌.

A separate **Bot Manager** creates bots, selects their workspaces, and controls who can talk to them. It handles commands locally without calling a model:

```text
create a Codex bot called Builder in "~/Projects/my-game"
create a Claude bot called Reviewer in "~/Projects/my-game"
list bots
```

The manager shows the workspace path for confirmation before creating a bot. Each bot has its own conversation sessions. Bots sharing a directory also share its files, so coordinate their edits.

## What you need

- **Node.js 24 or newer**, **Python 3**, and **lsof** on the computer where the agents will work. The host launcher uses Python and lsof to replace an existing instance safely. Keep that computer and Riftjack running to keep the bots reachable.
- **A Synapse Matrix server you administer**, with native account registration and login. Provisioning needs an admin token or shared registration secret. Matrix Authentication Service is not supported by the provisioning adapter.
- **A Matrix account and client**, such as Element X, for your conversations.
- **At least one agent:** Codex signed in with a ChatGPT account, Claude Code signed in with a Claude account, or a Grok worker running in its own environment. Only your chosen provider is needed.

Install your chosen CLI separately: [Codex](https://developers.openai.com/codex/cli) or [Claude Code](docs/claude.md). Riftjack does not install or update either engine. Each uses its own account and usage limits. No model-provider API key is needed.

Riftjack makes outbound connections to Matrix. Codex and Claude need no publicly reachable inbound port. Connector MCP tools use authenticated, temporary HTTP listeners on loopback. External workers use an optional loopback HTTP interface, reachable locally or through an SSH tunnel; see [Grok setup](docs/grok.md).

## First run

Keep source code and private runtime data separate. This layout puts the Git repository inside an instance directory:

```text
my-riftjack/
├── .env                private configuration
├── data/               accounts, sessions, and encryption keys
└── riftjack/           this repository
```

Create the instance and install Riftjack:

```sh
mkdir my-riftjack
cd my-riftjack
git clone https://github.com/reikairo/riftjack.git
npm --prefix riftjack ci
cp riftjack/.env.example .env
chmod 600 .env
```

Edit `.env` and set:

| Setting | Value |
| --- | --- |
| `MATRIX_HOMESERVER` | Your server’s HTTPS URL. |
| `MATRIX_OWNER_ID` | Your full Matrix ID, such as `@you:example.org`. |
| `SYNAPSE_ADMIN_TOKEN` | The provisioning administrator’s token. Alternatively use `SYNAPSE_REGISTRATION_SHARED_SECRET`. |
| `RIFTJACK_WORKSPACE` | Default local working directory; also used for attachment storage. |

Choose your first engine. For **Codex**, install [Codex CLI](https://developers.openai.com/codex/cli), then sign in:

```sh
codex login
codex login status
```

Choose ChatGPT authentication. Set `CODEX_MODEL`, `CODEX_REASONING_EFFORT` and `CODEX_SERVICE_TIER` to pin Codex settings for this connector, or leave them blank to inherit Codex settings. Use `CODEX_SERVICE_TIER=default` for standard speed instead of priority processing. Set `CODEX_PATH` if `codex` is not on the connector’s `PATH`.

For **Claude**, install [Claude Code](https://code.claude.com/docs/en/setup), then run:

```sh
claude auth login
npm --prefix riftjack run check:claude
```

Leave `CLAUDE_MODEL` blank for its default. You can skip the Codex login entirely.

For **Grok**, enable `WORKER_PORT` and follow [worker setup](docs/grok.md); use `bootstrap:grok` without installing Codex or Claude.

Then, still from `my-riftjack/`, check the configuration and bootstrap your chosen engine:

```sh
npm --prefix riftjack run check:config
npm --prefix riftjack run bootstrap:codex
# Or: npm --prefix riftjack run bootstrap:claude
# Or, with WORKER_PORT enabled: npm --prefix riftjack run bootstrap:grok
npm --prefix riftjack start
```

Each bootstrap creates two non-admin Matrix accounts: **Bot Manager** and your chosen agent. It saves their credentials in `data/`; rerunning it skips bot types already present. Startup brings the bots online and sends encrypted chat invitations to your account. Accept them, then send your first task to the agent.

Keep the process running. Back up `.env` and `data/` securely, including the encryption recovery files. Losing those files can mean losing access to bot accounts and encrypted history.

If your reverse proxy hides Synapse’s Admin API, use the [optional SSH tunnel](docs/setup.md#optional-ssh-tunnel). The [installation guide](docs/setup.md) also covers alternate instance locations and provisioning failures.

## Everyday controls

Send these commands in the bot’s chat or thread:

| Command | Purpose |
| --- | --- |
| `!help` | Show that bot’s command reference, without a model request. |
| `!cancel` | Stop the current task. Changes already made remain. |
| `!reset` | Start a fresh conversation when the bot is idle. Files and Matrix history remain. |
| `!approve` / `!deny` | Answer the single pending confirmation. Use its ID when several are pending. |
| `!answer Your answer` | Answer an agent’s question; the request shows the required format. |
| `!usage` | Show the provider account’s usage limits. Owner only. |
| `!restart` | Reload Riftjack and all bots when idle. Owner only. |

By default, bots respond in encrypted two-person rooms with authorized accounts. [Linked conversations](docs/shared-conversations.md) can continue an existing agent session across its private chat and an explicitly configured shared room. The initial owner manages access through Bot Manager. For example, `allow bot Builder for @friend:example.org` grants access to that bot and sends a private chat invitation.

Built-in messages, help and manager commands use English. Agent conversations can use your language.

See [working through Matrix](docs/chat.md) for confirmations, attachments, plugins, and task updates, and [bots and access](docs/manager.md) for manager commands.

## Boundaries worth knowing

**The agent runs on your computer; inference uses its provider.** Matrix encrypts messages and attachments in transit between clients and bots. Riftjack decrypts them on the host and passes their content to the selected agent. Matrix encryption does not extend to model inference.

**Separate conversations share a host.** Bots use the same OS account and the corresponding ChatGPT or Claude login. A workspace and a bot access list are not a separate machine. Grant access accordingly.

**Approvals apply to the displayed request.** Codex defaults to a workspace-write sandbox with command network access disabled and approval requests routed to Matrix. Claude uses its own sandbox and permission settings. You can set either backend’s approval policy to `never`. Existing host restrictions still apply.

**Local tasks are not replayed after interruption.** Codex and Claude ignore messages missed while Riftjack is stopped. Already accepted messages in a linked-room queue survive restart, but interrupted active tasks are not replayed. Sessions, accounts, and files persist. External workers have separate [durable inbox and lease rules](docs/grok.md#wait-work-reply).

[Access and encryption](docs/security.md) explains these boundaries. [Restarts and recovery](docs/operations.md) explains the supervisor and rollback behavior.

## Further reading

- [Installation and configuration](docs/setup.md)
- [Bots, workspaces, and access](docs/manager.md)
- [Working through Matrix](docs/chat.md)
- [Claude Code](docs/claude.md)
- [Restarts and recovery](docs/operations.md)
- [Access and encryption](docs/security.md)
- [Development and validation](docs/development.md)

Riftjack is available under the [MIT License](LICENSE). Dependencies retain their own licenses.
