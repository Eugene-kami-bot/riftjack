# Bots and access

The manager handles account creation, workspaces, profiles, and access lists locally. Send it the commands on this page as ordinary messages; send project tasks to a coding bot.

[Back to Riftjack](../README.md)

## Create bots and manage accounts

Send these as ordinary messages to **Bot Manager**:

```text
create another Codex bot named Research
create a Codex bot called Builder
create a Claude bot called Research
create a Claude Code bot called Reviewer
create a Codex bot called Website in "/Users/you/Projects/website"
create a Claude bot called Research in "~/Projects/My Project"
list bots
allow @myphone:example.org
add my account @mytablet:another-server.example
list accounts
remove @myphone:example.org
```

Only the initial owner can change account access. Added accounts can talk to all bots, list bots, and ask the manager to create more bots. They can be on other homeservers if federation permits it. Changes take effect immediately and persist across restarts. Revoking an account also requests cancellation of its active tasks; completed file changes are retained.

From an added account, start an encrypted DM with a bot using its full ID from `list bots`. The bot accepts invitations from allowed accounts. New bots invite whichever allowed account requested their creation. Each account has its own conversations; adding another account does not merge histories.

## Access to individual bots

To grant access only to selected coding bots, the owner can manage separate user lists in the manager DM:

```text
allow bot Riftjack Codex for @alice:example.org @bob:other.example
remove bot Riftjack Codex for @alice:example.org
list access bot Riftjack Codex
```

Targets accept the same names and ID aliases as profile commands. Quote names containing ` for `. Users must be full Matrix IDs separated by spaces or commas. A batch is validated completely before any grants change; bot accounts cannot be granted access as humans. `allow bot` adds to the list and `remove bot` removes from it. Only the original connector owner can inspect or change these lists. Scoped access applies to Codex, Claude and Grok bots, not the manager; it does not grant bot creation or access to any other bot. On a writable Codex or Claude bot, it includes requesting and confirming HTML-reviewed publication of repositories in that bot’s workspace using the host’s Git credentials. Assign a dedicated workspace before granting access when projects should remain separate. A scoped user can invite the selected bot to an encrypted DM without receiving global `allow` first.

The effective access is the union of the bot's list and global `allow` accounts, including the owner. `list access bot` displays both sources. Removing a global user only from a bot is rejected with an explanation: use `remove @user:server` to clear all global and per-bot grants, then grant access to the selected bots. Scoped removal stops only that bot's active task for the user, including pending confirmations. All message handling, steering, reactions, invitations, private-room checks and outgoing delivery consult current scoped permissions. Renaming a bot retains its list because grants use its stable Matrix ID. Conversation scopes remain separate per user and thread; filesystem/provider-account isolation is unchanged, so bots sharing a workspace still share its files.

After `allow bot`, the selected bot automatically invites each listed user into a separate private encrypted DM. The user only needs to accept in Element X. Grants are persisted first; an offline bot or invitation failure does not roll them back, and the manager reports each user's invitation status. Repeating the command reuses a saved or discovered encrypted private chat, leaves pending invitations alone, and reports users who already joined. A declined invitation may be resent into the saved private room if its history is restricted to joined members. Chats with other joined/invited/knocking users, public rooms and plaintext rooms are not reused. New rooms invite exactly one human, enable Megolm encryption from creation, and restrict history to joined members. Access and cancellation are checked before network mutations; a request already in flight may finish after cancellation.

Bot/user room mappings are saved in `DATA_DIR/bot-dms.json` with mode 600, separately from the original bot-owner room. An in-flight marker is persisted before room creation. After a lost response or restart, discovery can recover the created room; if the outcome remains uncertain, another creation is blocked to prevent duplicate chats. Inspect invitations or open a DM manually and repeat `allow bot` to reconcile. Removing access does not delete chat history or retract an already-sent invitation; permission checks continue to reject the removed user. Global `allow` and list/remove commands do not send invitations, and existing grants are not automatically replayed at startup.

Permissions persist atomically in `DATA_DIR/allowed-users.json` (mode 600). The old global-user array is accepted; the next permission change writes version 1 with `users` and `bots` fields, preserving global grants. Invalid permission data prevents startup. Permission changes take effect immediately.

## Create Matrix users

The initial owner can also create ordinary local Matrix users through the manager:

```text
create user alice
create user alice named Alice
```

This requires `SYNAPSE_ADMIN_TOKEN` and native Synapse account management. The login is 1–64 lowercase ASCII letters, digits, `.`, `_`, `=` or `-`, beginning with a letter or digit. The server name comes from the administrative account. The manager checks availability, shows the full Matrix ID and requests confirmation through ✅/❌ or `!approve`/`!deny`, then checks availability again. Accounts are created with `admin: false`; they are not bots and receive no connector access. To grant access separately, use `allow @alice:server`.

A cryptographically random password is returned to the owner in the encrypted DM; the new user should change it after signing in through Element X. No model receives the command or generated password. A recovery record is saved before registration under `DATA_DIR/created-users/` with directory mode 700 and file mode 600. It contains the password and a pending/created status; include these records in protected backups. If registration or reply delivery fails, inspect the server and the record locally before retrying. The connector never automatically retries registration, reuses an uncertain attempt, or logs response bodies or passwords. This is a generated initial password, not an expiring or one-time password.

When `SYNAPSE_REGISTRATION_SHARED_SECRET` is also configured, registration uses the create-only shared-secret endpoint with login inhibited. With only the admin token, Synapse's v2 user endpoint is an upsert: the two availability checks do not eliminate a race with an external administrator creating the same login simultaneously. Avoid concurrent provisioning of the same login, or configure the shared secret for create-only registration. The connector serializes its own account creation operations. Existing usernames detected by either check are rejected without a write. Matrix Authentication Service needs a separate implementation.

## Names and avatars

Avatar images and their generation prompts are instance data. Keep local copies
under `data/avatars/` in the instance directory, outside the Git checkout.

Bot profiles can be updated through the manager without restarting:

- `rename bot Codex to Riftjack Codex` changes the display name (Unicode, up to 100 characters) and saves it in the local registry. Select a bot by its current display name (case-insensitive), full `@bot:server`, or local ID with or without `@`. Generated IDs also accept the alias without their final random suffix: `rename bot bot_codex_codex to Riftjack Codex`. Names with spaces work; quote an old name containing ` to `, for example `rename bot "Ready to help" to Helper`. Partial name/ID prefixes are not matched. Ambiguous matches, including collisions between names and ID aliases, list candidates and require a full Matrix ID. Explicit full IDs always match exactly.
- Send an encrypted image with `set avatar Riftjack Codex` as its caption to set the avatar. PNG, JPEG, GIF and WebP are accepted, subject to the configured media size limit. The image is uploaded using the target bot account; profile avatars are ordinary Matrix media, visible beyond the encrypted DM.
- `remove avatar Riftjack Codex` clears the avatar.

Avatar commands accept the same names and ID aliases as renaming, including names with spaces and optional double quotes. Ambiguous, missing or unauthorized avatar targets are rejected before downloading the image; use a full Matrix ID from `list bots` to resolve ambiguity. The connector owner can manage every profile; an allowed user can manage bots they created (recorded by `inviteUserId`). Legacy bots with no creator recorded, and the manager itself, are owner-controlled. Profile changes preserve Matrix IDs, rooms, conversations and workspaces. The target bot must be connected. Other manager attachments are rejected before download.

The manager recognizes the phrases above and similar create/make/add requests. It does not use an LLM to interpret arbitrary administrative instructions. Bot names accept letters, digits, spaces, underscores, and hyphens. Matrix IDs include a random suffix to avoid overwriting existing users. The registry is capped at 50 bots, including the manager.

## Workspaces

To assign a workspace when creating a coding bot, append `in projects/demo`, `in /absolute/path` or `in ~/Projects/My Project`. The last space-delimited `in` separates the bot name from an unquoted path; quotes are optional, including for paths with spaces. Quote a path containing its own ` in `, for example `in "Projects in progress"`. This is a directory on the machine running the connector, not on the Matrix server. Before registering the Matrix account, the manager shows the full path and asks for confirmation in the same chat/thread: `!approve` to proceed or `!deny` to cancel. If the directory is missing, approval creates it and any missing parents; if it exists, approval confirms using its files as the bot workspace. The default workspace also requires confirmation. Cancellation or timeout does not create a directory or account. If the destination changes while waiting, the manager asks again. A directory created after approval is retained if later bot provisioning fails. `~` expands to the connector host user's home, and relative paths resolve against `RIFTJACK_WORKSPACE`; shell variables and commands are not expanded. Only the initial owner can select custom directories. The canonical directory is saved in `accounts.json`, survives restarts, and is used for that bot's Codex/Claude process, conversation workspace and `.matrix-media` attachments. Accounts with no custom directory continue to use `RIFTJACK_WORKSPACE`. `list bots` displays the selected folders. If a saved directory becomes unavailable, that bot fails to start rather than silently working in another folder. Other bots retain their own settings. Choosing a workspace does not give each bot a separate OS user or model-provider login.

## External Grok bots

With `WORKER_PORT` enabled, `create a Grok bot called Research` creates an encrypted
Matrix bot backed by a durable worker inbox. Connect its external agent using
[Grok setup](grok.md). Configure its workspace and tool permissions on the worker;
the manager does not assign it a directory on the connector host.

## Model settings

The connector owner or a bot’s creator can give each Codex or Claude bot its own model. Send these commands to the manager; select the bot by name, short ID or full Matrix ID. Quote names containing ` to `.

```text
set model bot Builder to MODEL
set reasoning bot Builder to high
set tier bot Builder to default
set tier bot Research to fast
show settings bot Builder
reset model bot Builder
reset reasoning bot Builder
reset tier bot Builder
```

Replace `MODEL` with an identifier accepted by that bot’s CLI and account. Model selection works for both Codex and Claude. Reasoning overrides are Codex-only. For Codex tiers, `default` requests standard service and `priority` requests priority processing. For Claude tiers, `fast` requests fast mode and `default` explicitly turns it off. `reset tier bot Research` restores inheritance from `CLAUDE_SERVICE_TIER`, or from CLI settings when that shared value is blank. Grok’s model belongs to its external worker.

Each field inherits its corresponding `.env` default until explicitly set for the bot. Resetting a field removes just that override. If the shared value is blank, Riftjack leaves that option to the CLI. `show settings bot` labels overrides and inherited values; `!status` in the bot chat shows the effective configuration separately from the last CLI session report.

Changes are saved in the bot’s `engineSettings` record in `accounts.json` and apply to the next task, including resumed conversations and background notifications. Running tasks and their steering retain the settings captured when they started. No connector restart or conversation reset is needed for manager commands. Editing `.env` or `accounts.json` directly requires a restart. These settings apply to every conversation with that bot; they do not create separate provider credentials or quota.

Claude fast mode uses `fastMode` in the CLI launch settings and requires a compatible Claude Code version, model and account. It has premium pricing; see [Claude fast mode](https://code.claude.com/docs/en/fast-mode). Saving `fast` records the request; check the last reported fast-mode state with `!status` after a task starts. Riftjack does not change the model setting when tier changes.

Riftjack validates setting names and identifier syntax, and accepts only `default` or `fast` for Claude tiers. Availability of a particular model, reasoning level or service tier is checked by the CLI when a task starts; saving settings does not make a model request.
