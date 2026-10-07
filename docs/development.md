# Development and validation

Run development commands from the repository directory, unlike the instance commands used for normal operation.

[Back to Riftjack](../README.md)

## Local checks

```sh
npm run check
npm test
python3 -m unittest discover -s test -p '*_test.py'
```

`npm test` runs the tests in `test/` without opening HTTP listening ports. They use local files, child-process stubs and mocked transports; run them in the normal sandbox without requesting network or port access.

`npm run test:http` runs `test/http/*.test.ts`. These tests bind an ephemeral port on `127.0.0.1` and make loopback requests, including from the Python worker client. They use no live Matrix service or model account. A sandbox that blocks listening ports may require permission for this command.

Run the HTTP suite when changing the publication, background-task, attachment or room-message MCP transport or its Codex/Claude integration, the worker HTTP server, API authentication/routing, long polling, request/response or attachment handling, `scripts/worker-client.py`, or queue/service behavior exposed through that API. Also run it when changing its fixtures, suite layout, or relevant dependencies. Changes confined to chat commands, formatting, documentation, or Codex/Claude adapters normally need only the relevant ordinary tests and type checking. Queue and worker-status unit tests remain in `npm test`. Publication logic tests use temporary local bare Git repositories and need no listening port or live GitHub access. MCP integration tests in `test/http/` open loopback ports and use CLI doubles plus local bare repositories; they make no model requests or live GitHub calls.

Use `npm run test:all` when a full validation is intended; it runs both suites and requires permission to open a loopback port in restricted environments. Put future port-opening tests under `test/http/`; keep tests that need no listener in `test/`. Type checking includes both directories. Run `npm audit` separately when checking dependencies; it contacts the package registry.

Tests use mocked backends and registration responses: routing, authorization, manager-only access changes, persistence, cancellation, replay prevention, and provisioning. A fake App Server executable verifies ChatGPT-only authentication, credential filtering, session resumption, image/file inputs and replies, active-turn steering, startup/completion races, rejected updates, child-process failure, cancellation, and denial of unsolicited approvals. Confirmation tests cover command decisions, forms and questions, parallel RPC IDs, request withdrawal, stale/replayed answers, Matrix reply quotations, sender/room/thread isolation, revocation, timeout, and fail-closed delivery. Plugin tests verify owner-only access, explicit confirmation before installation, no model turn, no automatic retry, and browser-auth links. Bridge tests also check steering order, pending limits and attachments. Media tests use real attachment encryption/decryption with a mocked Matrix transport, including tampering, byte limits, cancellation, and outbox path restrictions. Restart tests cover owner-only commands and acknowledgement failures; real child-process tests verify sequential replacement, `.env` reload, and signal forwarding. Background-watch tests cover restart recovery, expired/malformed files, path checks, cancelled/reset sessions, busy delivery and uncertain admissions. HTTP tests exercise background registration and resumed delivery through both backend adapters. Live progress messages, background completions, confirmations, plugin/OAuth flows, steering, restart acknowledgement, attachment delivery, and rendering in Element require a separate check after upgrading the running connector. The Codex adapter was developed against the 0.159.1 App Server protocol. Codex is installed and updated independently of Riftjack; mock tests do not establish compatibility with every CLI release. Check the installed CLI’s generated App Server schemas when changing the protocol adapter, and verify a real task after a CLI upgrade.

References: [Codex App Server](https://developers.openai.com/codex/app-server/), [Codex authentication](https://learn.chatgpt.com/docs/auth), [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference), [Element Matrix bot SDK](https://github.com/element-hq/matrix-bot-sdk), [Synapse user administration](https://element-hq.github.io/synapse/latest/admin_api/user_admin_api.html), [Synapse shared-secret registration](https://element-hq.github.io/synapse/latest/admin_api/register_api.html).

## Commit policy

Install the repository-local hook after cloning:

```sh
npm run hooks:install
```

Commit messages describe the change and its purpose without AI attribution trailers or signatures. The hook and CI check this policy. See [commit policy](commit-policy.md) for its scope, checks, and server enforcement.

## Before publishing

Review the staged files and scan for credentials. Runtime data and real deployment details do not belong in this repository. See [access and encryption](security.md#keep-runtime-data-private).

## Documentation

Keep the README focused on the first successful conversation. Put command details in chat.md or manager.md, installation details in setup.md, and lifecycle behavior in operations.md. Describe current behavior and known limitations; release-specific migration notes should identify the affected version.

Built-in messages, help and documentation use English; agent conversations can use any supported language. Use neutral examples such as `projects/demo` and `@alice:example.com`, without personal conversation details or real deployment paths. Unicode names, paths and messages remain valid test inputs. Tests should check behavior and data rather than incidental wording or whitespace, except when the displayed text or layout is the behavior being tested.


For a local outgoing-media benchmark, create a regular test file and run:

```sh
node --import tsx scripts/benchmark-media.mts streamed /absolute/path/test.bin /absolute/path/streamed.json
node --import tsx scripts/benchmark-media.mts buffered /absolute/path/test.bin /absolute/path/buffered.json
```

Each command runs a separate Node process with a loopback HTTP receiver and verifies the received ciphertext hash. The report records elapsed time and kernel peak RSS, including the receiver. `buffered` reproduces the former whole-file encryption and SDK upload for comparison. These measurements do not include a Matrix homeserver or recipient download. Benchmark inputs and result files are local data; keep them outside the checkout.

## Routing context

Stable Matrix routing rules live in `routing-instructions.ts`. Codex receives them
as developer instructions on thread start; resumed histories retain them, and
the instruction hash adds an update only when they change. Claude receives them through
`--append-system-prompt` on every process start, including resume. When the CLI
advertises `--system-prompt-snapshot`, the backend sets it to `off` so an old
snapshot cannot silently override updated connector instructions. They are not
copies in successive user messages and do not rely solely on a history summary.
Each routed message still identifies its current room, visibility, author and
trigger, including live steering. Shared participants and credit, unread messages
and connector notes are included when applicable; empty observation fields are omitted.

Backend tests verify instruction delivery on start and resume, not the model's
compaction implementation. A live compaction check must use a disposable session,
never an active user's conversation.
## Context compaction notices

Codex `contextCompaction` item lifecycle events and Claude `compacting` status /
`compact_boundary` stream events produce service notices in the human's encrypted
DM with that bot. Linked shared conversations use the linked home DM. The
destination must still have exactly the bot and the human; there is no fallback
to the shared room. Notices contain no conversation content and do not trigger
agent turns or mentions.

Repeated starts/completions are suppressed within a backend call. Only an
observed completion is reported as successful; a run ending while compaction is
pending reports that completion was not confirmed. A hard connector crash cannot
send that final notice. Delivery failures are reported without interrupting the
agent, and uncertain sends are not retried.

## Continuity notes

The Codex and Claude adapters send a separate agent reminder when the latest
reported context usage reaches 65% of a known model window. This is an early
warning, not a promise that compaction is imminent or can be delayed. A large
tool response or a CLI-specific threshold can still cause compaction first.
Codex uses `thread/tokenUsage/updated.last.totalTokens` and `modelContextWindow`,
not cumulative usage. Claude uses a main-agent assistant message's input tokens,
including cache reads and creation, and the matching model's `contextWindow`
reported in `result.modelUsage`. It does not guess capacity from model names.
Claude's first run may have no known window until the result; a needed reminder
then accompanies the next ordinary input. Older CLIs without usage/capacity
fields cannot provide an early warning.

The reminder supplies a session-specific file under
`<workspace>/.riftjack/checkpoints/`. The agent chooses the content and writes it
with its own tools, subject to existing sandbox and approval rules. The
connector never reads or writes note content, grants filesystem access, or
asserts that a note was actually saved. Read-only agents must respect their
write restriction. Notes can refer to existing personal memory, but are not
new instructions or authorization and should stay out of project commits.
Separate backend/session identifiers give separate paths; resetting a session
does not adopt the previous session's note. Files remain until the agent or
human removes them. A shared workspace is not filesystem privacy isolation.

After an observed start/completion pair, the adapter asks the agent to read its
note if present, check freshness, and resume the existing task. The reminder
uses live steering (Claude requires replay acknowledgements). If delivery is
not accepted or is uncertain, it remains pending for the next ordinary input;
there is no autonomous extra model run or retry loop. State survives connector
restarts. Replayed completion events alone do not produce a restore reminder.
An unobserved compaction during a connector crash cannot trigger restoration.
The existing human-facing private compaction notices are unchanged.
