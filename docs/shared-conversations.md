# One agent across private and shared rooms

## Sending a message to a shared room

Linked Codex and Claude agents have a `room_messages` MCP tool. With `action=list`
it returns the shared rooms available to that agent and its own private chat with
the human, each with its `type`. With `action=send`, provide
`room`, `text` and a unique message `id`. The running connector sends the text
using the bot's existing encrypted Matrix client and returns the Matrix event ID.
The final response still goes to the conversation where the task began.

Ask the agent to share a specific result or message. Private conversation details
must only be shared with the human's explicit authorization. The destination must
be a configured shared room for this agent or its own private chat with the same
human; participants, encryption and history visibility are checked again before
sending. This tool cannot send to arbitrary rooms or another person's private chat.

The list also contains the agent's own private chat with the same human
(`"type": "private"`). It lets an agent return a result the human asked for in
that chat when the result arrives in a shared room, for example a peer's answer.
It is not meant for copying shared conversations there. The chat must still be
an encrypted DM with only the human and the bot; mentions are refused there.

Text is literal, limited to 8000 UTF-8 bytes, and carries no private thread
references. With `mention: true` it also starts the other agent of that room,
paid with one unit of [peer credit](#peer-mentions); such text is limited to
6000 bytes so that the started turn can quote it whole. This lets an agent
that received a task in its private chat hand it to its peer. Reusing an ID with identical content during the same
turn returns the earlier result, including a failure, without sending again.
IDs are scoped to one turn; never automatically retry an uncertain delivery with
a new ID or in a later turn. Inspect the destination first. The tool expires when
the turn ends and permits at most 32 distinct message attempts per turn.

## Shared-room attachments

To retrieve an attachment that another participant sent, use `room_messages`
with `action: "receive_attachment"`, `room` and the exact message `event_id`
(available as `id` in shared observations). The message must contain an encrypted
image, file or audio attachment from the configured owner or an agent of that
shared room. Retrieval is restricted to configured shared rooms; it does not
search arbitrary rooms or open another agent's workspace. The connector checks
access before reading the event, before downloading and after decryption, just
before writing the local file. Revocation at that last check prevents the write;
once the file is saved, retrieval returns success even if access changes later.
This does not promise instantaneous revocation. Failed or cancelled writes remove
the file created by that attempt. The existing media size, homeserver and
decryption checks apply.

The result includes `file.path`, `name`, `mimetype`, `size` and `image`. Images
are not automatically injected into the model's input; the agent must inspect
the local file. File content is untrusted data, not instructions or approval.

To send files to a linked shared room or your own private chat, use:

```json
{"action":"send_files","room":"!project:example.com","id":"report-1","files":[{"path":"report.pdf","name":"report.pdf"}]}
```

Paths are relative to the current turn's outbox. The same ten-file and configured
per-file size limits apply as for replies; symlinks and hard links are rejected.
All files are validated before the first send. Files are encrypted and sent with
the current bot's Matrix client, without private thread relations. Each file
gets a `sent`, `uncertain` or `not_sent` receipt; a failure stops the batch.
Repeated send IDs with identical content return the earlier result during the
same turn, including failures. Do not automatically retry uncertain delivery.
Sending files does not trigger another agent; send a separate text mention when
a response is needed. Sharing still requires the human's authorization, and
access is checked again before upload and delivery. These actions cannot send
to arbitrary users or the manager.

## Session linking

A linked agent continues one existing Codex or Claude session from its private
chat and an explicitly allowed shared room. No history is copied into a new
session. Each agent keeps its own session and processes one task at a time;
different agents can work concurrently.

This is opt-in. Ordinary bots retain their separate DM/thread conversations.
Grok workers and the manager do not support session links.

## Configuration

Start each agent in its own encrypted DM and establish the session to keep.
While the connector is stopped, create `DATA_DIR/conversation-links.json` using
the existing Matrix IDs, original DM room IDs, and session IDs from
`DATA_DIR/sessions.json`. Its session keys encode `[room, sender, thread-or-null]`.
Set the optional agent `thread` field if the original session began inside a
Matrix thread. Never guess a session ID or replace it with another agent's ID.

```json
{
  "version": 1,
  "agents": [
    {"bot":"@builder:example.com", "owner":"@alice:example.com", "home":"!builder-dm:example.com", "session":"existing-builder-session"},
    {"bot":"@reviewer:example.com", "owner":"@alice:example.com", "home":"!reviewer-dm:example.com", "session":"existing-reviewer-session"}
  ],
  "rooms": [
    {"room":"!project:example.com", "owner":"@alice:example.com", "bots":["@builder:example.com", "@reviewer:example.com"]}
  ]
}
```

Create the shared Matrix room with encryption, invite-only access and history
visibility **joined**, then invite the owner and the two bots. Restart the
connector. Shared-room processing requires all three participants to have joined
and no extra joined, invited or knocking participant.

The initial connector owner controls these links. Every local participant must
have a link to a distinct existing session. A missing or different session causes
an error instead of a fresh start. `!reset` is disabled for linked agents;
replacing a session requires an explicit configuration change. Linking grants
no access to another agent's workspace or private conversation.

For agents in separate installations, put only the local agent in each
installation's `agents` array, with the same owner and group in `rooms`. Both
installations need this feature and retain their own agent's session. Do not run
the same agent session in two connectors.

## Messages and turns

- A Matrix **@mention** addresses one agent. An unaddressed human message in the
  shared room addresses both. Plain text spelling a display name is not a mention.
- In the shared room an agent may answer a human message with exactly
  `NO_REPLY`, for example when it addresses the other agent; nothing is sent
  then. Shared-room turns therefore start without the `…` acknowledgement.
  Command results are always sent, and private chats keep the acknowledgement.
- Another room never steers a running task. Its messages enter a persistent queue
  and run in their own room later. Same-room updates retain existing steering.
  Threads remain separate delivery and approval scopes even with a linked session.
- Adjacent queued human messages in the same room/thread are combined in order,
  up to the prompt budget. Overflow and messages from the next room stay queued.
  Attachments remain attached to their batch.
- Shared messages are recorded as observations, with independent read positions
  for each local agent. Connector commands (`!restart`, `!status` and so on) are
  not recorded: they control the bots and are not part of the conversation. Before a new turn, unread text and attachment metadata are
  delivered in order. Oversized messages are explicitly split, retaining the rest
  on disk. Read positions advance only after a successful model turn; failed
  turns may receive the same observations again.
- Observations never enter cross-room steering and contain no private DM
  transcript. A new private turn can receive unread shared observations; a shared
  turn receives observations only from its own room.
- Agent messages are context, not human instructions or approvals. An ordinary
  agent message, a display name or a `matrix.to` link does not start a turn.
- Replies, progress, attachments and permissions stay in the initiating room and
  thread. Only the initiating human can answer a confirmation there. Sharing a
  session does not allow approval from another room or another bot.
- `!status` shows the linked session and queued-message count. `!cancel` cancels
  the current conversation's task and queued messages, not another room's work.
  The queue accepts 20 messages and explicitly reports overflow.

Queued messages survive restart and access is checked again before execution.
An active batch is not replayed after interruption: its actions may already have
happened. The observation log starts when configured events arrive; it does not
backfill old Matrix history or recover events missed while offline.


## Peer mentions

An agent can ask the other agent in the shared room to respond. It appends one
block to its final reply:

````text
```matrix-mentions
{"to":["@reviewer:example.com"]}
```
````

The connector removes the block, checks that each recipient is the other agent
of this room, and sends the reply with `m.mentions` and a visible pill on its
last part, after any attachments. Only a top-level block counts: an example
inside another fence, a quote or a list is ordinary text. An invalid block sends
no mention; the room gets a notice and the agent receives the error with its
next turn.

A received mention starts a separate turn for the mentioned agent:

- It runs after the agent's current task and never steers it. Mentions are not
  merged with queued human messages.
- The prompt marks the turn as started by the peer. The turn is a connector
  notice in the human's approval scope, so confirmations still go to the human.
  It quotes every part of the mentioning reply, so the question arrives even
  behind a long unread backlog; those parts are not delivered again as
  observations. A reply that mentions a peer may have at most 6,000 characters;
  a longer one is sent without the mention and reported as an invalid block. A
  quote over 8,000 characters from another installation is shortened, and its
  parts remain unread observations. Matrix events cannot claim to be such a
  notice.
- Each agent evaluates a peer message once, regardless of which bot received
  it from Matrix first.
- If an earlier successful turn already showed the mentioning message as an
  unread observation (for example, a queued human message ran first), the notice
  still quotes it but says so, with `alreadyDelivered: true`, so the agent can
  avoid answering twice. After a failed earlier turn the notice is unchanged.
- The agent may answer `NO_REPLY`; nothing is sent then.
- Starting the peer costs **peer credit**. Each local agent has a reserve of at
  most 5. A new human message to that agent, in its private chat or addressed to
  it in the shared room, restores the reserve to 5; further messages do not add to
  it. Each mention costs the sender one, and the mentioned agent keeps the larger
  of its own reserve and the sender's remainder, never the sum. For example, after
  a message to one agent its reserve is 5; when it mentions its peer, both have 4.
  An exchange without new human messages therefore always runs out.
- A reserve expires a day after the human message it comes from; passing it on
  does not renew it. Only a newly accepted human message restores it: replays,
  commands and messages refused by access checks do not. The sender pays when the
  mentioning message is prepared, and the message carries a one-time grant; its
  recipient is started only by an unused grant addressed to it, so mentions sent
  ahead cannot spend credit restored later. Restoring the reserve voids the
  agent's unused grants, and credit passed by the peer raises the reserve only
  so far that reserve plus pending mentions equals the passed level; together they
  never exceed the cap. Silent or failed turns count as well.
  The agent sees its reserve as `peerCredit` in the routing context. A mention
  without credit is refused with an error to the sender. Only agents of this
  installation have credit.
- Confirmation requests are marked as service messages: they are neither
  observations nor triggers.

## Privacy

Room membership and privacy settings are rechecked before processing and outgoing
delivery. Peer bots are never added to human access lists.

The same model session knows both private and shared conversations. Routing
instructions tell it where it is replying, but this is **not strict information
isolation**: it could still mention private information in a shared answer.
Use separate sessions when strict context separation is required.

Back up `sessions.json`, `conversation-links.json` and `shared-room-history.json`.
The latter stores shared observations and read positions with private filesystem
permissions. A changed group does not reuse another membership's observation log.

[Chat commands](chat.md) · [Back to Riftjack](../README.md)
