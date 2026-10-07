# Working through Matrix

To continue one existing agent session across a private DM and an explicitly
configured shared room, see [Shared conversations](shared-conversations.md).

Use ordinary messages for tasks and connector commands for session controls. A command is handled locally; it does not spend a model turn.

Agent responses use ordinary Matrix text messages (`m.text`). Connector status, errors, help and confirmations use notices (`m.notice`), which some clients mark with an information icon. Bot messages appear without quoting the message that triggered them. Messages, confirmations and attachments sent within a Matrix thread stay in that thread.

[Back to Riftjack](../README.md)

## Session controls

Send `!reset` to start a fresh conversation with that bot in the current room/thread, `!cancel` to stop a task, or `!help`. Reset removes the local conversation pointer; it does not erase Matrix history or the engine's session files.

`!help` replies locally with an English command list, without calling a model, and also works during a running task. Codex help includes confirmations, optional IDs and plugin installation; manager help includes bot creation and access-management commands. Claude help describes active-task updates and the queued fallback on older CLIs. Owner-only operations are marked. All three help pages use native Matrix formatting: headings, command lists, code-formatted examples and highlighted restrictions, with a readable plain-text fallback. Coding-bot help also uses quoted task examples. The same formatting is used when help accompanies a prompt-length error. No help tables are used.

Text messages beginning with `!` (after trimming whitespace and removing Matrix reply quotes) are reserved for connector commands. Unknown commands and invalid syntax, such as `!aprove` or `!reset extra`, produce a local error and help guidance; they never start a model turn, steer an active task, or enter the follow-up queue. Attachment captions and filenames remain attachment content, not commands.

Coding bots have separate sessions and use their saved workspace, or `RIFTJACK_WORKSPACE` when none was selected. Coding bots run in parallel without a shared lock; each bot handles only one active task at a time, across all its conversations. If two bots edit the same file at the same time, one may overwrite the other's changes. Codex runs use `workspace-write` (or `read-only`) and disabled sandbox network/web search. `CODEX_APPROVAL_POLICY` defaults to `on-request`: Codex may request an exception, which is sent to Matrix for explicit approval. Set it to `never` to deny command/file/permission escalations instead. Approvals are routed to the user, not an automatic reviewer. Existing Codex configuration, managed restrictions, MCP tools, and local filesystem readability still apply; use a dedicated OS account/container if stronger isolation is needed. Connector tokens are excluded from both engines' subprocess environments.

## Background task notifications

Codex and Claude can register completion watches with the `background_tasks` tool
on the `riftjack_tasks` MCP server. This lets a bot return with a result after its
current turn has ended. The tool watches an existing JSON file inside that bot's
workspace; it does not start a process or keep one alive.

For example, first create `build-status.json` containing `{"stage":"building"}`,
then register:

```json
{"action":"watch","label":"Example build","status_file":"build-status.json","field":"stage","terminal":["complete","failed"],"timeout_hours":24}
```

For a supervised task, optionally add `pid` (the supervisor's positive process ID
on this host) and `stale_after_minutes` (1–10080). For example, a runner that
atomically updates the status file every 20 seconds can use a five-minute stale
timeout. The runner must be launched independently of the agent turn; registering
a watch does not detach it or protect it from termination.

A missing PID produces `watch_process_missing`; an unchanged or unreadable JSON
file produces `watch_stalled` after the stale timeout. Valid file modification
time refreshes that timeout; registration starts a fresh grace period. The last
observed update is saved across connector restarts, including when the file then
disappears. A terminal status takes precedence over these two diagnostic outcomes.
Permission errors checking a PID are inconclusive, not evidence of termination.
PID checks cannot detect hangs or reuse of the number by another process; combine
them with regular status updates where practical.

Each diagnostic notification ends its watch, just like expiry. Neither declares
the task failed nor stops anything: child processes may survive the supervisor.
Inspect the process and logs before retrying work, and register a new watch if
monitoring should continue. Watches without these options retain the ordinary
completion/expiry behavior. Notifications still wait for the agent to be idle.

The same tool schedules delayed messages for up to 7 days, for example when you
ask a bot to remind you of something tomorrow:

```json
{"action":"remind","label":"Release check","message":"Check whether the release build finished.","deliver":"agent","delay_minutes":1440}
```

`deliver: "agent"` resumes the conversation when due, with the message as the
bot's own reminder. `deliver: "room"` posts the message to the conversation as
the bot without starting a turn; it does not mention anyone. Use `at` with an ISO
8601 time and offset instead of `delay_minutes` for a fixed time. Timers survive
restarts, are listed with `action: "list"`, and can be cancelled before they are
due. The confirmation and the list show the room and the exact text. A busy bot
delivers an agent reminder after its current task. A timer delivered more than a
minute late, for example after the connector was stopped, says when it was due and
how late it is. A crash during delivery is never replayed.

For a recurring reminder, use `schedule` instead of `at` or `delay_minutes`:

```json
{"action":"remind","label":"Daily check","message":"Check for useful project updates.","deliver":"agent","schedule":{"frequency":"daily","time":"09:00","timezone":"Europe/London"}}
```

Weekly schedules also require `weekday` (Monday=1 through Sunday=7).
Recurrence uses the named timezone's local clock, including daylight saving
changes. A nonexistent local time is skipped; a repeated local time fires only
at its first occurrence. After downtime, one overdue reminder is delivered and
the next occurrence is scheduled in the future. The connector persists that next
occurrence before admitting delivery, so a failed or interrupted run does not
break the schedule or replay that run. `list` shows the stable schedule ID, next
due time and last delivery state; `cancel` stops future occurrences. Resetting
the conversation or revoking access cancels the schedule.

Have the background process write a terminal state on both success and failure.
Prefer writing a temporary file and renaming it over the status file. The selected
field must be a top-level string; the JSON file must be a regular file of at most
64 KiB. Only the selected status, label and file path are passed to the agent,
not the rest of the file. They are supplied as data, not instructions or approvals.

Riftjack checks about every two seconds. Registrations survive connector restarts;
completion waits until the bot is idle, then starts a turn in the original room,
thread and agent session. Account access and room privacy are checked again.
`!reset`, revoked access or a changed workspace cancels pending watches. While
Riftjack is offline, the producer must leave the terminal state in the file until
it can be observed. A watch expires after 24 hours by default (configurable from
1 to 168 hours) and then reports that expiry; this does not mean the process ended.

Use `{"action":"list"}` to inspect this conversation's watches, or
`{"action":"cancel","id":"WATCH_ID"}` to cancel one. Cancellation stops watching,
not the background process. `!status` shows waiting and interrupted counts.
Repeated registration of the same pending file and field returns the existing
watch; changing terminal states requires cancelling it first. A bot may have up
to 100 active watches. Recent completed records are retained with a bounded limit.

A notification starts an ordinary agent turn; it can consume the model's usage
limit and still needs the usual approvals for protected actions. Delivery is
attempted once. If the connector crashes after admitting the turn, the watch is
marked `interrupted` on startup and is not automatically replayed: the agent may
already have acted. Inspect the conversation and saved results before registering
another watch. The `delivered` state means the notification turn was admitted and
finished handling; it does not certify that the underlying task or agent succeeded.

These watches are available to Codex and Claude bots. External workers continue
to use their existing durable task queue; this tool does not monitor arbitrary
Grok processes. Workspaces remain a filesystem trust boundary, not isolation
between mutually untrusted host users.

## Reactions

React to an agent's ordinary text message with 👍 for agreement, 👎 for negative feedback, or ❤️ for strong appreciation or support. Reactions are interpreted in the context of the message and ongoing agreements. On a concrete proposed next step within the agreed work, either 👍 or ❤️ can mean “yes, go ahead”: the agent is instructed to continue that work. A reaction to a completed result or a personal remark may simply express appreciation; it does not require inventing a new task. Thumb skin tones and text/emoji heart variants are supported. Riftjack passes the reaction and an excerpt of the original message to the agent immediately, in that message's conversation and thread. An idle Codex or Claude starts a turn; a busy agent uses the normal steering or follow-up path. Grok receives the feedback through its durable worker queue. There is no separate acknowledgement message for feedback.

Only reactions from an authorized conversation partner to that bot's text messages are forwarded. Reactions to notices, confirmations, other people's messages and unsupported emoji are ignored. The normal busy/publication rules still apply. Repeated delivery of the same reaction event is deduplicated. Removing a reaction does not retract feedback already delivered to the agent. Conversational agreement does not answer a pending confirmation request or replace a required approval, including publication approval; use the listed confirmation controls on the specific pending request (✅, ❌, or 🔖 where offered).

## Messages during work

Claude steers updates from the active conversation into the running task when its CLI supports `--replay-user-messages`. Delivery is confirmed by the CLI echo; an in-flight tool call is not interrupted. Without replay support, messages run as queued follow-ups. An unconfirmed update is not resent automatically. See [Claude Code](claude.md#files-and-follow-up-messages).

**Codex steering:** while a Codex bot is working, send another message in the same room/thread from the same Matrix account. The connector delivers it to the active task with Codex App Server's `turn/steer`; it does not cancel or restart the task. Text, images, files, and audio attachments can all accompany an update. You receive an acknowledgement after Codex accepts it. During startup, updates wait until the active turn is ready. If the task has already finished, the message runs as the next turn in the same conversation. At most 10 updates/follow-ups can await delivery at once; each text/caption is limited to 16,000 characters. Delivery is serialized, and duplicate Matrix events are ignored.

Messages from a different account, room, thread, or bot cannot steer the current task. Different bots can run in parallel, but each bot has only one active task. An ordinary bot refuses another conversation while busy; a linked agent queues other-room messages for separate turns. `!reset` requires an idle bot; `!cancel` stops the current task and discards pending follow-ups. The task timeout covers steering and any immediate follow-ups; sending updates does not reset it. Same-conversation pending updates live in memory and are not replayed after a crash/restart. The [linked-room queue](shared-conversations.md#messages-and-turns) is persisted separately. If steering delivery fails with an uncertain outcome, the connector reports it rather than automatically repeating the request.

The connector uses the Codex App Server JSONL protocol over private stdio pipes, including `thread/start`, `thread/resume`, `turn/start`, `turn/steer`, and `turn/interrupt`. Existing Codex conversation IDs remain usable. This stdio transport opens no server port; connector MCP tools separately use authenticated loopback HTTP listeners during a task. The App Server account must report ChatGPT authentication before a turn can start.

## Confirmations and answers

For Codex, the bot forwards command approvals, file-change approvals (with the available diff), turn-scoped permission requests, agent questions, and standard MCP form/URL requests to the active encrypted DM or thread. Each request has a random, single-use ID. When exactly one request is pending in this conversation, you can omit its ID:

```text
!approve
!deny
!answer My answer
!answer {"confirm":true}
```

If several requests are pending, specify the ID from the message. Explicit IDs also work for a single request. An unknown or expired explicit ID never selects a different request. For `!answer`, a leading 12-character hexadecimal token is interpreted as an ID; if your answer starts with such a token, include the current request ID before the answer.

In Element X, you can also tap the bot's ✅ (approve) or ❌ (decline) reaction under the last message of a confirmation. If the bot cannot add the reactions, add the same emoji manually or use a command. Reactions select that exact request even with several pending requests; only the original authorized sender in the same encrypted room can answer, including a configured shared room. The message binding preserves thread scope. The first valid command or reaction wins; removing a reaction does not undo a decision. Expired requests and replayed reactions do nothing. Forms and questions still require `!answer`; they show only ❌. This applies to confirmations from coding bots and the manager.

Confirmation text is encrypted. The emoji and target event ID are sent as standard unencrypted Matrix annotations, without the request text or answer contents. Reactions bind only after all parts of a request have been sent successfully.

```text
!approve 012345abcdef
!deny 012345abcdef
!answer 012345abcdef My answer
!answer 012345abcdef {"confirm":true}
```

`!approve` accepts only the displayed request; it never creates a permanent allow rule or accepts a whole session. For permission requests, the displayed additional permissions last for the current turn. Questions require `!answer`; a single question takes plain text, several questions take a JSON object keyed by question ID. MCP forms take a JSON object with the requested fields and do not submit defaults automatically. The bot lists the valid commands and answer format for each request. Ordinary messages in any language are task updates, not confirmation answers. During a Codex task they are forwarded to the active agent even while a confirmation is pending. Claude uses the steering or queued follow-up behavior described above. Neither path treats the text as an answer to the request. Use an explicit command or the displayed reaction to answer it.

For the initial owner, a Codex command request may also offer **🔖 Approve and remember** when the agent explicitly chooses an exact persistent command prefix and App Server proposes the same argument list. The request shows the exact prefix as an argument list, separately from the command and working directory. Tap 🔖 on that confirmation, or use `!answer ID remember` (or `!answer remember` for a single pending request), to approve this command and ask Codex to save exactly that rule. The bookmark reaction selects that exact fully delivered request even when several are pending, and is ignored on requests without this option. Ordinary `!approve` and ✅ remain one-time approvals; ❌ declines without saving. An answer cannot edit or broaden the proposed prefix. This option is not offered for guests, missing or invalid proposals, unsupported decisions, stdin requests, or managed-network approvals.

Riftjack gives every built-in Codex and Claude agent instructions to assess persistent permission before each command approval request. The assessment covers future matching arguments, executable resolution, editable scripts, project tests/builds, hooks and plugins, not just the current invocation. Codex is instructed to omit `prefix_rule` when future matching runs could execute agent-editable code or when uncertain, and to propose a narrow prefix only when its assessment supports persistence. App Server can automatically propose a prefix even when the agent omits `prefix_rule`, so that proposal alone never enables saving. To offer persistence, the agent must also end its justification with a standalone `Riftjack-Persist: ["exact", "prefix", "arguments"]` line containing exactly the assessed prefix, preceded by a readable explanation. The connector requires an exact match with the server proposal and hides the valid intent marker from the displayed reason. Missing, malformed, duplicate, non-final or mismatched intent leaves only one-time approval and denial; neither the bookmark nor the typed save option is offered. Agents omit both the marker and `prefix_rule` for one-time requests. This is agent guidance, not a deterministic safety classifier or sandbox boundary; the human still decides whether to save a proposed rule. Existing Codex sessions receive updated connector instructions before their next turn without resetting history; Claude receives them in the appended system prompt on new and resumed turns. Claude approvals remain one-time only. External workers manage their own prompts and permissions.

The saved prefix permits future matching commands to run outside the sandbox without prompting; it is not just permission to open local ports. Prefixes are not restricted to the displayed working directory and can affect other sessions or bots using the same Codex configuration. Codex manages persistence and applies its remaining policy restrictions; Riftjack does not edit rule files itself. Rules normally live under `~/.codex/rules/`; inspect or remove the saved entry there to revoke it, then restart the affected Codex processes. See [Codex rules](https://developers.openai.com/codex/rules/). The Matrix acknowledgement only confirms that the decision was sent, not that Codex saved the rule or the command succeeded.

Answers become actionable only after the complete request has been delivered. Early commands are rejected and must be sent again; they are never queued as consent. Answers are accepted only from the original authorized sender in the same bot, room and Matrix thread. Reply quotations from Matrix clients are stripped before parsing commands. Attachment captions, edited events, notices and duplicate events cannot act as answers. Access and encrypted DM membership are rechecked before delivery and acceptance. IDs expire on cancellation, task timeout, turn completion, server withdrawal, disconnect or restart; late/duplicate answers never start another model turn. The total task timeout defaults to 24 hours (`TASK_TIMEOUT_SECONDS=86400`, configurable from 1 to 86400 seconds) and includes time spent waiting for confirmation, with at most ten pending requests. Timeout and cancellation messages identify which condition stopped the task. Full request details must fit in 40,000 characters; an oversized request is declined rather than approved from a truncated preview. Missing command/diff details disable approval.

MCP URL requests provide a link to complete in a browser; approving one acknowledges the step but is not proof of authentication. Secret questions, user-verification challenges, nonstandard OpenAI forms and unknown request types are not approved. Claude tool-permission requests use a separate adapter; see [Claude Code](claude.md#permissions).

## Codex plugins

To install a plugin, the initial owner can send this to an idle Codex bot:

```text
!plugin install github
```

The connector reads the plugin description, apps and MCP servers from `openai-curated-remote`, asks for confirmation, and calls App Server's `plugin/install` only after `!approve [ID]` (ID is optional for a single pending request). This command is handled locally, without a model turn, and also works with existing conversations. Installation affects the shared Codex account/host. The service still enforces account and installation policies. If browser login is required, the bot returns the service's login links; passwords and tokens should not be sent to Matrix. An uncertain installation result is not automatically retried. This is separate from desktop-only `request_plugin_install` UI prompts, which cannot be completed by sending “confirm” as ordinary chat text.

## Delivery and formatting

Messages sent before the current startup are ignored, including messages sent while the connector was offline. Duplicate events are recorded before work begins to reduce accidental re-execution. An interrupted task is not automatically replayed after restart. Tasks time out after 24 hours by default. Replies are chunked, with a 100,000-character cap.

Coding bots also forward user-facing progress messages while a task runs. Codex sends completed `commentary` messages; Claude sends assistant text preceding tool use or a later assistant response. Thinking blocks and tool internals are not forwarded, and the final response is sent separately.

Coding bots render Markdown replies as sanitized Matrix HTML (`format: org.matrix.custom.html` and `formatted_body`), with a readable plain-text fallback. Element X can display emphasis, links, lists and code blocks without showing Markdown delimiters. Tables use monospace blocks. Long replies retain balanced formatting across chunks. Raw HTML is displayed literally, and Markdown images become links; file delivery still uses encrypted attachments. Manager replies also use native formatting: bot lists have bold names and code-formatted IDs and folders; help has headings and commands; profile and access updates highlight their outcome. User-supplied names and paths remain literal. Confirmations use headings, highlighted field labels and literal code blocks for commands, paths and changes, with the same readable plain-text fallback. Their short footer lists reactions and commands; IDs are optional when exactly one request is pending. Long confirmation details are split without truncation, and both commands and reactions become actionable only after the entire request is delivered. Operational errors and most coding-bot command responses stay plain text; help, status and usage use formatted replies.

## Bot status

Send `!status` to a Codex or Claude Code bot to see its task state and configured workspace/model, including per-bot overrides. Change those through the manager’s [model settings commands](manager.md#model-settings). Codex also shows configured reasoning effort and service tier. The command works during a task, does not steer or queue a prompt, and does not start a CLI process or make a model request. It is available to accounts authorized to use the bot in a private conversation or configured shared room.

The separate **Last CLI session report** section shows metadata reported when Codex starts/resumes a thread or Claude Code emits its session initialization event, with the report timestamp. Codex reports its model, reasoning effort, service tier and workspace. Claude reports its model, workspace, permission mode and Fast mode when available. Claude's ordinary stream output may omit effort; missing fields are shown as unknown. These are session reports, not per-request inference receipts or live queries. Changed settings, model fallback or changes made outside Riftjack may differ from the last report.

For ordinary bots, reports are scoped to the bot, sender, room and Matrix thread, survive connector restarts, and are cleared by `!reset`. A new conversation has no report until its CLI starts a task. Linked rooms share the linked session report; `!reset` is disabled for linked agents. Grok's `!status` shows queue/lease/delivery counts; its model settings and workspace are controlled by the external worker and are not reported to Riftjack.

## Reviewed publication

Codex and Claude Code can request publication themselves through the `prepare_publish` MCP tool. Ask the bot to publish committed changes; it supplies `repository`, `remote` and `branch`. Riftjack sends the HTML review to the current conversation, then asks for confirmation. The tool waits for your decision and returns the publication result to the agent. There is no keyword in the agent's reply that triggers a push.

The tool is available to every authorized user of a writable Codex or Claude bot, including users granted access only to that bot. Only the user who requested the publication can confirm it, in the same conversation. Its local connection is created for each task and closed when that task ends. The tool timeout follows `TASK_TIMEOUT_SECONDS` (24 hours by default). The connector checks access and room privacy again before pushing; it does not expose an approval API to agents. Global Codex and Claude MCP settings are not edited. Starting `prepare_publish` is allowed without a preliminary tool-consent prompt; publication still requires the separate Matrix confirmation after report delivery. This does not relax approval policies for unrelated MCP tools.

Any authorized user can ask an idle Codex or Claude Code bot to review and publish committed changes:

```text
!publish {"repository":".","remote":"origin","branch":"main"}
```

The repository path is relative to that bot's workspace (an absolute path inside it also works). Supply a configured remote name and the destination branch explicitly. Access to a writable bot includes reviewed publication of repositories inside its workspace using the host’s Git credentials. There is no separate per-user repository or remote allowlist; users sharing a bot share this scope. The connector performs this structured command locally; it does not ask a model to interpret it. Read-only bots and external Grok workers cannot publish through this command.

Riftjack resolves the push destination, reads its branch tip and prepares a self-contained HTML attachment. It contains the final diff and **every outgoing commit**, including changes later reverted. File sections collapse, added/deleted lines have colors and line numbers, and the file needs no JavaScript or external resources. Binary contents are marked as unavailable for text review. Uncommitted files, other local branches and unrelated tags are excluded. Git authentication must already work on the host; the connector does not collect credentials.

After the attachment and confirmation text have been delivered, approve with the usual reaction or `!approve ID`, or decline with `!deny ID`. Delivery does not prove the report was opened. Approval applies to the shown commit, destination branch and expected remote tip only. Changed HEAD or destination invalidates the review. An explicit Git lease also prevents a concurrent remote update from being overwritten. Only fast-forward updates and new branches from complete (non-shallow) repositories are supported. For a new branch on an existing remote, the report starts at its unique common ancestor with the remote default branch. The report identifies that published branch, its tip and the review base; local tracking refs and other remotes are not used to omit history. The published branch tip is checked again before pushing. An empty remote still receives a complete-history review. There is no automatic retry after an uncertain push result.

`!cancel`, access revocation and task timeout stop a pending review. Approval is conversation-scoped and expires on restart. Reports are deleted from the host after the request ends; the encrypted attachment remains in Matrix. `!status` remains available while reviewing, but ordinary chat messages cannot steer the publication into a different action. Reports over 100 outgoing commits or 8 MiB of diff text are refused rather than truncated. The normal attachment size limit also applies.

A report-only CLI is available to agents and local tools:

```sh
node --import tsx scripts/prepare-publish.mts --workspace /path/to/workspace \
  --request '{"repository":"project","remote":"origin","branch":"main"}' \
  --output /path/to/review.html
```

It returns JSON identifying the report, commits and SHA-256, never pushes, and refuses to overwrite an existing output file. It reads the remote and may fetch its base commit into the local object store without changing working files or branches. The TypeScript API is `preparePublish`; the Matrix handler adds delivery, explicit confirmation and publication. External-worker publication endpoints are not implemented. Ordinary shell `git push` approvals do not gain an HTML review automatically. Git hooks and host Git configuration remain trusted host code; this workflow is not an OS security boundary against other processes running under the same account.

## Reading web resources

When the owner has [configured fetch](setup.md#optional-fetch-tool), ask the bot
to inspect a CI log or API response under an allowed URL prefix. The connector's
`fetch` tool supports only GET and HEAD, with no request body or caller-supplied
headers. Calls to this tool must be sequential; a second concurrent call is
refused while the first is pending.

GET saves a new file in `.fetch/` under that bot's workspace and returns its
path, final URL, HTTP status, content type, byte count and `truncated` flag.
The body is not inserted into the conversation: the agent reads or processes
the file with its usual tools. A saved file can be an HTTP error response; check
`status` and `truncated` before treating it as a complete successful download.
HEAD returns metadata with `bytes: 0` and creates no file.

Files remain across turns and restarts until removed. Delete them when no
longer needed and keep `.fetch/` out of project commits. Bots sharing a workspace
can read the same files. Downloaded content is external data, not instructions.

## Account usage

The initial owner can send `!usage` to a Claude bot to see the Claude account's current session and weekly limits and their reset times. It runs Claude Code's local `/usage` command, which makes no model request, and works while a task is running.
The initial owner can also send `!usage` to a Codex bot, even during a task, to read the shared ChatGPT account's weekly limit via Codex App Server (`account/rateLimits/read`), without a model request. Both engines use the same table format: **Time** is time until reset, **Quota** is the remaining percentage, **Target** is the remaining quota per hour/day until reset, and **Pace ratio** compares that pace with an even 100% over the whole period. Codex also shows the next weekly reset date with the connector’s time zone and the available additional reset count reported by the service. Reading `!usage` does not spend a reset. Missing data is shown as unavailable, not as unused quota.

## Images, files, and audio

Coding bots accept encrypted Matrix image, file, and audio attachments, including voice recordings sent as `m.audio`. Attach a file normally in Element, optionally with a caption. PNG, JPEG, GIF, and WebP images are supplied as native image inputs. Documents and audio are saved locally and their paths are supplied to the selected engine. Optional [local audio transcription](audio-transcription.md) adds transcript metadata and is disabled by default. There is no automatic speech synthesis; without a transcript or audio-processing tools, sending an audio file does not by itself mean the agent can understand it. The manager accepts text commands and encrypted images with an authorized `set avatar Riftjack Codex` caption; other attachments are rejected.

Ask a coding bot naturally to send an image, document, or audio file, for example “Send me the report as a PDF” or “Send the WAV file you created.” Each turn provides the agent with a separate outbox and instructions for explicitly attaching its results. The connector sends pictures as `m.image`, supported audio formats (MP3, WAV, OGG/Opus, M4A, AAC, FLAC, WEBA) as `m.audio`, and other formats as `m.file`. SVG is delivered as a file. Ordinary Markdown links and paths in a response do not upload files.

Codex and Claude can send files as soon as they are ready, then continue working. For example, ask for three images and have each delivered as it is generated. The `send_attachments` MCP tool takes `{"files":[{"path":"preview.png","name":"preview.png"}]}` with paths relative to the conversation's outbox; the display name is optional. It always delivers to the room and thread that started the current turn, including in linked conversations. It cannot select another recipient. No extra confirmation is required for this connector tool.

The tool returns a status for each file: `sent` means the Matrix send completed, `uncertain` means delivery was attempted but not confirmed, and `not_sent` means the batch stopped before that file was attempted. These statuses do not indicate whether the person has read or downloaded the file. A repeated path returns its previous status without another upload in the same turn, even if its contents or display name changed. Files already attempted by the tool are also excluded from the final reply's attachment manifest. Use a new filename for a new version. After an uncertain result, inspect the conversation before requesting another delivery; a new turn has no record of the previous turn's receipts.

The tool uses a private, authenticated local connection for each turn, closes when the turn ends, and rechecks access and room privacy during delivery. Both engines also retain the final-response attachment manifest for files not yet sent. Tool setup does not change global CLI configuration.

File contents are encrypted before upload. The filename, MIME type, size, and decryption key are delivered inside the encrypted room message. Incoming attachments must also use file encryption and pass integrity verification. Attachments preserve Matrix threads without quoting the incoming message. Access and room membership are checked again before delivery; cancellation stops pending downloads and prevents delivery after an upload completes.

The default and maximum limit is **512 MiB per attachment** (536,870,912 bytes). Set `MAX_MEDIA_BYTES` to a smaller value if needed. Each tool call or final reply can contain at most 10 files. The homeserver may impose a smaller upload limit. Downloads are bounded by actual bytes, even if the sender omits or understates the size. Attachments sent to the active conversation are downloaded in order and delivered as steering updates, or processed in a follow-up turn if the current task just finished.

Outgoing attachments are read and encrypted in bounded chunks while uploading. `MEDIA_UPLOAD_TIMEOUT_SECONDS` sets the overall upload deadline (default: 1800 seconds, range: 1–86400). Cancellation stops the upload; failed uploads are not retried automatically. The supervisor log records `media-upload` start, completion, or failure with a transfer ID, file size, ciphertext bytes read, and elapsed milliseconds. The duration covers reading, encryption, upload, and the server response, not the recipient's download. HTTP status codes and safe network error codes are reported without filenames, access tokens, encryption keys, or server response bodies. Incoming downloads and the external worker's JSON/base64 interface still buffer data in memory.

Files are kept under each bot’s workspace in `.matrix-media/`, in separate incoming and outgoing directories, with private filesystem permissions. Outgoing files must be regular files inside the current turn's outbox; symlinks, hard links, and paths outside it are rejected. Files remain available for follow-up questions and are not deleted by `!reset`. Remove old media manually when it is no longer needed. Bots assigned the same workspace share its filesystem; media directories are not an isolation boundary between allowed users. Add `.matrix-media/` to each selected repository’s ignore rules. A read-only Codex sandbox can inspect incoming attachments but cannot create new outbox files.

## Task activity indicator

For Codex, Claude and Bot Manager, “typing” means the bot is processing a request
or awaiting confirmation within that request. The standard Matrix indicator
covers an active task, including tool calls, preparation and final delivery. Local
commands such as `!status` do not start it. The connector renews the indicator
every 15 seconds with a 30-second server expiry and clears it on completion,
cancellation or failure. After a crash it expires without a cleanup request.
Access is checked before each update; indicator errors do not fail the task.

The indicator belongs to the room, not an individual thread. Element controls
how it is displayed, and clients may hide it. It indicates an active run, not
continuous model output or completion of the objective; an active run waiting
for confirmation still counts as active. No persistent status message is added.
