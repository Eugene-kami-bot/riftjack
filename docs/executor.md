# Command executor without a model

The executor runs explicitly addressed commands on a Linux or macOS host and
reports into an encrypted Matrix room. It does not load Codex, Claude or another
model, and needs no model subscription. All network connections originate from
the executor host; no inbound port, public address or SSH tunnel is required.

Use a separate Matrix account, OS user and instance directory. This is a separate
entry point, not a Bot Manager account type or an external Grok worker. The usual
agent instance can remain on a different computer. An agent submits exactly the
same addressed messages as an authorized human.

## Install

Use a 64-bit OS and Node.js 24 or newer. On ARM64, the pinned Matrix crypto
package's installer selects a Linux ARM64 native library. Its download and runtime
must still be checked on the target distribution. Local macOS tests do not establish
that a particular Raspberry Pi installation works.

Clone Riftjack and install dependencies as the executor's ordinary OS user:

```sh
git clone https://github.com/reikairo/riftjack.git
cd riftjack
npm ci
npm run hooks:install
mkdir -p ../executor-instance/workspace ../executor-instance/state
chmod 700 ../executor-instance ../executor-instance/state
```

Create a dedicated Matrix account using your homeserver's normal provisioning
process. Obtain its own **device-bound** access token. Do not reuse an agent's
account, device or crypto database. Invite it to an encrypted, invite-only room
whose history visibility is `joined`. Everybody in this room can see commands,
output and attached logs; only configured senders may control the executor.

Create `executor-instance/.env` (mode 600), with actual absolute paths and IDs:

```dotenv
MATRIX_HOMESERVER=https://matrix.example.com
MATRIX_USER_ID=@executor:example.com
MATRIX_ACCESS_TOKEN=replace-with-device-bound-token
EXECUTOR_POLICY=/srv/executor-instance/policy.json
EXECUTOR_DATA_DIR=/srv/executor-instance/state
```

Create `policy.json` outside the workspace:

```json
{
  "workspace": "/srv/executor-instance/workspace",
  "mode": "limited",
  "rooms": ["!lab:example.com"],
  "senders": ["@alice:example.com", "@builder:example.com"],
  "sudoActions": {}
}
```

Run from the instance directory:

```sh
npm --prefix ../riftjack run start:executor -- --check-config
npm --prefix ../riftjack run start:executor
```

The configuration check is offline. Starting contacts Matrix and checks the token's
user/device identity. The executor joins only configured rooms when invited by a
configured sender. Retain `state/` across restarts: it contains the sync checkpoint,
crypto keys, job journal, command output and pending encrypted replies. Back it up
as private data, along with `.env` and policy. Never commit these files.

A service may run the same command with `RIFTJACK_HOME` set to the instance directory.
For example, use a systemd unit with `User=executor`, the correct `WorkingDirectory`,
`ExecStart=/usr/bin/node --env-file=.env --import /srv/riftjack/node_modules/tsx/dist/loader.mjs /srv/riftjack/src/executor-main.ts`, `Restart=on-failure`
and **`KillMode=process`**. That setting lets detached job supervisors survive a
connector restart; it also means stopping the service alone does not stop jobs.
Cancel jobs first when shutting down work. Owner intervention is needed if a
supervisor itself dies. Do not run the connector as root.

## Rights selected by the host owner

`limited` accepts ordinary commands and optionally fixed named sudo operations:

```json
"sudoActions": { "inspect-devices": ["/usr/bin/lsblk", "--json"] }
```

The owner must separately permit the exact operation in the OS sudo policy, using
root-owned executables/scripts that the executor cannot modify. The executor does
not edit sudoers, install dependencies as root, or ask for a password.

`full` additionally permits `"sudo": true` for arbitrary argv, using
`/usr/bin/sudo -n -- ...`. The owner must explicitly grant the corresponding OS
rights. This grants trusted senders full control over the host. Mode changes are
local policy edits followed by restart; queued jobs admitted under a different
policy are cancelled. Running jobs are not retroactively stopped by a policy edit.

The modes are a command interface, **not an OS sandbox**. Ordinary commands have
all rights of the executor user, including access to that user's files. They can
invoke any sudo operations the OS already permits. A working-directory check does
not isolate the filesystem or protect same-user credentials. Use a dedicated user
and host/container as appropriate to the owner's intended trust boundary.

## Link an existing agent room

On the agent host, add the executor's full Matrix ID to that room's `observers`
array in `DATA_DIR/conversation-links.json`. Include the host owner's Matrix ID
there as well if they will join. Stop/restart that connector when changing its
configuration, following [shared conversation setup](shared-conversations.md).
All listed participants must join. The existing owner and two agent links stay
in `owner` and `bots`.

Also add the executor ID to that room's `executors` array (a subset of `observers`)
to enable automatic agent notifications. For example:

```json
"observers": ["@executor:example.com"],
"executors": ["@executor:example.com"]
```

Agents submit a literal `!exec ...` request using `room_messages` action=send,
with `mention` omitted. Completion, uncertainty and replies to status/log/cancel
requests wake the requesting agent automatically. Each notification must come
from a configured executor and reference that agent's recorded request and job ID.
It is saved before the Matrix sync checkpoint advances. A busy agent receives it
when available; a failed notification turn recovers after restart. Repeated events
are deduplicated. No human follow-up is needed.

Set `"wakeIntervalSeconds":60` on a run request for progress notifications at most
once a minute, only when new output exists. `0` (the default) disables progress
wakes; nonzero values are whole seconds from 10 to 86400. These intervals are
separate from room output chunks. A progress notification includes the latest
output excerpt. Pending progress for one job is coalesced while the agent is busy;
completion supersedes pending progress and does not wait for the interval.
Delivery can still be delayed by disconnection or a running agent turn.

Executor replies and attachments also appear in unread room observations. An agent
can retrieve an encrypted log using its exact event ID and `receive_attachment`.
Observers' output is task data, never owner instructions or publication approval.
Notifications use no model on the executor host; waking an agent uses that agent's
normal model account. The agent host retains the last 10000 request correlations
and notification event receipts; ordinary room-history consumption does not erase
the correlations.

## Submit and monitor

Send a plain text message beginning exactly with `!exec`, the executor's full
Matrix ID and a JSON object. Quotes, edits, plaintext events in encrypted rooms,
unaddressed discussion and messages from other senders do not submit work.

```text
!exec @executor:example.com {"action":"run","id":"jit-001","argv":["/usr/bin/uname","-a"],"timeoutSeconds":60,"wakeIntervalSeconds":60}
!exec @executor:example.com {"action":"status","id":"jit-001"}
!exec @executor:example.com {"action":"log","id":"jit-001"}
!exec @executor:example.com {"action":"cancel","id":"jit-001"}
```

`argv` starts with an absolute executable path. There is no implicit shell. For a
script, explicitly use an interpreter such as `["/bin/sh","-c","..."]`. `cwd`
defaults to the workspace and must resolve to an existing directory inside it.
The timeout defaults to 3600 seconds and accepts 1–86400. Child processes receive
only a fixed system PATH, workspace HOME and LANG; Matrix tokens and the connector
environment are not inherited. Programs read their normal OS-user files as usual.

Use `"sudoAction":"inspect-devices"` instead of `argv` for a named privileged
operation. In full mode, use `"sudo":true` together with `argv`. No mode change
is accepted from chat.

IDs contain 1–64 letters, digits, underscores or hyphens. Repeating the same ID and
request returns the saved job status; it never starts it again. A different command
needs a new ID. Authorized room participants may inspect or cancel that room's
jobs. The executor runs one supervised job at a time, globally across its rooms.

Replies appear in the request's thread. States include queued, starting, running,
succeeded, failed, cancelled, timed_out, output_limit and uncertain. Status reports
include elapsed time and the exit code/signal when known. Running output is sent
in chunks of up to 4000 bytes, no more often than once per ten seconds per job.
A disconnected executor retains unsent output. On completion it sends the complete
captured log as an encrypted attachment; `log` requests an immediate snapshot.
stdout/stderr chunks are labelled. UTF-8 characters split across chunks may render
imperfectly in previews; the captured log retains the bytes. No progress percentage
is invented.

Captured output is capped at 8 MiB per job. Reaching the cap terminates the job with
`output_limit`. Timeout/cancellation signal the ordinary process group, first TERM,
then KILL after two seconds. Commands must stay in the foreground. Daemons that
escape the group, and privileged children that cannot be signalled by the executor
user, may need owner cleanup; cancellation is not proof that every descendant has
stopped. Completed effects are never undone.

## Restarts and uncertainty

Before launching, the executor saves the command and starting state, flushes the
file, atomically renames it and flushes the parent directory. The detached runner
also persists an exclusive claim before spawning the command. Filesystem errors
prevent launch. This relies on the OS and storage device honoring flushes; it is
not a distributed transaction with the command's external effects.

If Matrix disconnects or the connector restarts, the independent runner continues
and writes logs/results. On reconnect the connector reads the saved result and
resumes delivery. Encrypted reply contents and transaction IDs are persisted before
sending, so an uncertain send retries the same Matrix transaction.

If the supervisor is lost, the host reboots, or launch cannot be established, the
job becomes **uncertain** and blocks subsequent execution. The command is not
restarted. The owner must inspect processes and effects; the executor cannot infer
whether a command that lacked a final record completed. Do not remove a claim or
reset the journal to force a retry. After stopping all relevant processes, archive
the entire instance state and provision a fresh executor device/instance if manual
recovery is necessary. Jobs/results are not automatically garbage-collected: the
instance stops accepting new work at 1000 jobs or 10000 control messages so old IDs
cannot silently become executable again. Pending replies are capped as well.

Initial startup ignores messages older than the first instance start. Thereafter
it persists the Matrix sync checkpoint only after admission and fills limited
room timelines after downtime, using the existing message-recovery implementation.
Failed decryption cannot admit a command; check device keys and resend only after
inspecting the existing job ID. This mode has local automated tests; real encrypted
room delivery and Linux ARM64 operation need a deployment smoke test.
