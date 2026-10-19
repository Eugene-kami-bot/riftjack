# GitHub subscriptions

Codex and Claude agents can use `github_subscriptions` to select GitHub PR events
for the current conversation. Riftjack polls GitHub without starting a model;
changes enter the existing durable background inbox and resume the conversation
when the bot can accept work. This is independent of `gh stack`.

## Owner setup

Install GitHub CLI (`gh`) on the connector host. Authenticate it to github.com in
an owner-managed configuration directory. Use a dedicated account or token with
read access to the selected repositories: pull requests, issues, checks and commit
statuses. No repository administrator permission or public HTTP endpoint is needed.
GitHub Enterprise hosts are not supported by this integration.

Set `GITHUB_SUBSCRIPTIONS_CONFIG` to an owner-managed JSON file, for example:

```json
{
  "bots": {
    "@devbot:example.com": {
      "gh_config_dir": "/srv/riftjack/github/devbot",
      "repositories": ["example/project"]
    }
  }
}
```

Keep both the policy and credentials outside agent workspaces, with filesystem
permissions appropriate to the connector account. The configuration file contains
no token. Each bot has its own policy entry; entries may share a credentials
directory deliberately. Use one credentials directory for bots sharing the same
GitHub account; separate directories are treated as independent accounts and do
not share a local request budget. Repositories are explicit names, without wildcards.
The agent cannot change the policy, credentials directory, host or delivery room
through the tool. `GH_TOKEN`, `GITHUB_TOKEN` and host/repository overrides are
removed from the polling subprocess environment so they do not override the
configured account. Other CLI use by an agent is outside this tool's policy.

Restart Riftjack after configuration changes. Removing a repository or bot entry
cancels its subscriptions and undelivered inbox notices on the next pump. An empty
configuration disables new registrations; existing subscriptions are cancelled.
Deploying this code alone does not activate monitoring.

## Agent interface

List the permitted repositories and this conversation's subscriptions:

```json
{"action":"list"}
```

Subscribe to selected PRs:

```json
{
  "action": "subscribe",
  "repository": "example/project",
  "pull_requests": [12, 13],
  "events": ["checks", "reviews", "comments", "pull_request"],
  "interval_seconds": 60
}
```

The first successful read establishes a baseline. Existing comments and completed
checks are not replayed. Identical active registrations return their existing ID.
Cancel and register a replacement to change a selection:

```json
{"action":"cancel","id":"subscription-id"}
```

The selection applies to explicit PR numbers, including closed PRs. Repository-wide
discovery and automatically following new members of a stack are not implemented;
subscribe to newly created PRs when they are added. Each bot may have up to 10
active subscriptions and 20 total PR selections. Each interval is 60–3600 seconds.
Registration and polling read paginated results; oversized or malformed results
fail visibly instead of advancing a partial baseline.

| Event | Changes that trigger a notice |
| --- | --- |
| `checks` | Completed GitHub check runs and terminal commit statuses on the current PR head, including success and failure |
| `reviews` | New reviews or changes to review state, including dismissal |
| `comments` | New or edited issue comments and inline review comments |
| `pull_request` | PR open/closed/merged state, draft status, head commit or base branch changes |

Checks are fetched for the head SHA. A second PR read rejects a snapshot if the
head changed during the requests. Notifications include repository, PR numbers,
SHA and links; comment bodies are not injected into the agent prompt. The agent
must fetch the current head and full reports before reacting. Review-thread
resolution, comment deletion and intermediate states that appear and disappear
between polls are not guaranteed to generate events.

## Delivery and failure behavior

Subscriptions and baselines persist in each bot's data directory. A transactional
outbox saves changes before handing them to the durable background inbox. Stable
notification IDs make retrying that handoff idempotent. Interrupted model turns
use the existing background recovery protocol: replay is possible, so agents must
inspect existing results before repeating external actions. This is not an
exactly-once guarantee for actions performed by the model.

A notice summarizes up to five changed items and reports the total count. Agents
should inspect all relevant PRs when a batch has more items. Notifications are
external data, never human instructions or approval to publish or merge.

Subscriptions are isolated by bot, room, human sender, thread and agent session.
Reset or revoked access cancels monitoring. Delivery rechecks room access through
the existing bridge. Cancelling a subscription removes undelivered notices; it
does not interrupt a model turn that already began.

Polling is serialized per bot. Requests sharing a credentials directory wait for
the preceding response and start at least one second apart. GitHub rate-limit
headers delay all subsequent requests, including those already queued by other
bots. Cancelling a queued request does not release later requests early. Different
credentials directories have independent queues.
Failures use exponential backoff up to one hour. `list` exposes the last successful
poll, last error and next scheduled poll. Three consecutive failures also attempt
to send one diagnostic notice through the background inbox. A full inbox retains
the pending change for retry; it can prevent delivery of the diagnostic itself.
The interval is a minimum delay after a poll, not a delivery deadline: API limits,
large PRs, outages and a busy agent can delay processing.
