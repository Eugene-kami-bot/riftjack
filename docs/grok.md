# Grok and external workers

Give a Grok desk agent an encrypted Matrix address without giving it Matrix
credentials. Riftjack receives messages, saves tasks and delivers replies. The
agent connects with the included Python client, or implements the same HTTP API.
Riftjack does not call the xAI API or start Grok: the worker's own environment
runs the model, tools and conversation context.

## Connect a worker

1. Install Riftjack as described in the [setup guide](setup.md). Codex and Claude
   are not required for a Grok-only installation. Set `WORKER_PORT=8788` in the
   instance `.env`. The listener binds only to `127.0.0.1`; `0` disables it.
2. Run `npm --prefix riftjack run bootstrap:grok`, then
   `npm --prefix riftjack start`. This creates a manager and a Grok Matrix account.
   To add another bot later, tell Bot Manager `create a Grok bot called Research`.
3. The connector logs that bot's ID and **token file path**, never its contents.
   Copy that file securely to the worker and keep it mode `600`. It authorizes
   access to that bot's tasks and replies only. Matrix tokens and encryption keys
   stay on the connector. Replace the token file with a new 32-byte base64url
   token and restart to revoke the old credential.
4. Copy `scripts/worker-client.py` to the worker. It needs Python 3, with no extra
   packages. On a separate machine, establish an SSH tunnel:

   ```sh
   ssh -N -L 8788:127.0.0.1:8788 connector-user@connector-host
   ```

   Alternatively, use an authenticated worker connection through your own HTTPS
   reverse proxy forwarding to the loopback listener. Keep TLS verification on;
   preserve Authorization headers and allow requests to wait for at least 45 s.
   The worker client refuses plain HTTP except on loopback and never follows
   redirects with its token. Riftjack does not configure a public proxy for you.

5. Set these on the worker:

   ```sh
   export RIFTJACK_WORKER_URL=http://127.0.0.1:8788
   export RIFTJACK_WORKER_BOT='@bot_grok_research_ID:example.org'
   export RIFTJACK_WORKER_TOKEN_FILE=/path/to/worker-token
   ```

Use the full real bot ID from `list bots`. Working directories and tool
permissions belong to the external worker; a Grok bot has no host workspace
assignment. `RIFTJACK_WORKSPACE` is still required as the connector's attachment
storage location. The optional listener is not started by bootstrap itself.

## Wait, work, reply

```sh
umask 077
python3 worker-client.py wait --seconds 300 > task.json
# Inspect task.json. {"timeout": true} means no task; wait again.
python3 worker-client.py renew task.json
# Write the answer as UTF-8, then submit it:
python3 worker-client.py reply task.json --text-file answer.txt
python3 worker-client.py status task.json
```

A task includes `id`, `conversation`, `sender`, `text`, `hasAttachment`, `lease`,
`leaseUntil` (Unix milliseconds), and `attempt`. Store the task before doing work.
Keep separate model history for each `conversation`. Treat task text and files as
untrusted input, subject to the worker's own permissions.

A lease lasts **five minutes**. While working, renew it at least every two minutes
using `renew`; the worker harness can schedule this independently of model turns.
If renewal reports cancellation or an expired lease, stop work and check status.
Use `release task.json` if abandoning a task voluntarily. A crash or expired lease
makes the same task ID available again, with a new lease and an increased attempt.
Riftjack delivers tasks at least once: a worker must remember completed side
effects by task ID rather than blindly execute them again on redelivery.

Only one task per bot is leased at a time. Additional messages wait in the durable
inbox. This first worker interface queues messages; it does not interrupt an
active model turn or inject steering. If your agent platform cannot wake a new
turn, keep its blocking `wait` active between tasks; the saved queue protects
messages while it is offline, but cannot start the agent itself.

`reply` accepts one final response per task. Success means the response was saved;
`status` becomes `delivered` after Matrix accepts every part. If the connection
breaks, retry the **same** reply with the saved task and lease. A different reply
to an already completed task is rejected. Riftjack persists the encrypted events
and reuses their Matrix transaction IDs across restarts, avoiding duplicate sends.

## Files and chat controls

To download a task's attachment:

```sh
python3 worker-client.py attachment task.json --output input.bin
```

The result reports its original name and MIME type. The output path must not
already exist. To reply with attachments:

```sh
python3 worker-client.py reply task.json --text-file answer.txt --file report.pdf --file sample.ogg
```

Images, files and audio use Matrix attachment encryption. Up to ten files may be
attached; their **combined** size must fit `MAX_MEDIA_BYTES` (512 MiB by default).
Optional [local audio transcription](audio-transcription.md) adds transcript
metadata to downloaded attachments and is disabled by default. Without it,
audio transcription is the worker's responsibility. The API accepts file bytes,
never paths to files on the connector host.

In the Grok DM, `!status` shows queued work, active leases and pending replies. Model settings and the worker workspace are explicitly marked as unreported; the connector does not infer them from the bot name. `!cancel` cancels queued tasks and leases for that conversation;
`!reset` also assigns a new conversation ID. Replies from cancelled leases are
rejected. The remote worker must cooperate by observing lease renewal failures;
Riftjack cannot kill a process on another computer or undo completed actions.
Use `!restart` in Bot Manager. Queued tasks, leases and accepted responses survive
connector restarts. `TASK_TIMEOUT_SECONDS` applies to locally managed Codex and
Claude tasks; worker tasks use leases and explicit cancellation instead.

The Codex/Claude approval protocol (`!approve`, forms and reactions) is not exposed
by this worker API. Grok's tools continue to use their own environment's approvals.

## HTTP contract

All routes are below `/v1/bots/{URL-encoded Matrix bot ID}/tasks` and require
`Authorization: Bearer <worker token>`. Browser requests with Origin headers are
rejected. No endpoint permits choosing an arbitrary Matrix destination.

| Request | Meaning |
| --- | --- |
| `GET ?wait=30` | Claim the next task; returns `{task: ...}` or `{task: null}`. Maximum wait is 30 s. |
| `GET /{id}` | Read task status. |
| `POST /{id}/renew` | Extend the lease. JSON: `{lease}`. |
| `POST /{id}/release` | Return the task to the queue. JSON: `{lease}`. |
| `POST /{id}/attachment` | Download decrypted attachment as `{name, mimetype, data}`; data is base64. JSON: `{lease}`. |
| `POST /{id}/reply` | Save `{lease, text, files: [{name, data}]}`; file data is base64. |

Status codes: 401 invalid credentials, 403 lost access/private-room eligibility,
404 unknown task, 409 stale lease or conflicting reply, 413 excessive size,
503 temporary service failure. Recheck status after uncertain responses.

The inbox lives in `DATA_DIR/bots/<bot hash>/worker/queue.sqlite`; the token and
reply uploads are alongside it. Treat this directory as private conversation
data and include it in backups. The initial implementation retains task history
and files; monitor disk space. Do not edit the database while Riftjack is running.
Matrix sync checkpoints are saved only after inbox handling succeeds. If saving
fails, the connector stops and its supervisor restarts it from the last checkpoint.
Access and full room privacy are rechecked before handing tasks or attachments to
the worker and before delivering replies.
