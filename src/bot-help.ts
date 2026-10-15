export function botHelp(kind: 'codex' | 'claude' | 'grok'): string {
  if (kind === 'grok') return 'Send messages and attachments to the external Grok worker. Use !status to see queued work and replies, !cancel to cancel queued work or !reset to start a new worker conversation. Use Bot Manager for !restart.';
  const name = kind === 'codex' ? 'Codex' : 'Claude';
  return [
    `## ${name} · Help`,
    'Send a task as a normal message, without a command or bot mention.',
    '### Quick start',
    '> Inspect the project and explain how to run it.\n>\n> Fix the error in this log and verify the result.\n>\n> Prepare a report and send it as a file.',
    'The bot works in its assigned folder on the connector host. To see workspaces, send `list bots` to **Bot Manager**.',
    '### Basic commands',
    '- `!help` — show help.\n- `!status` — show task state, connector settings and the last CLI session report; works during a task.\n- `!reset` — start a new conversation in this chat or thread while the bot is idle. Files remain.\n- `!cancel` — stop the task and its queue. Completed changes remain.',
    '### Updates during work',
    kind === 'codex'
      ? 'Send another message **in the same chat or thread** to update the active task (steering).'
      : 'Send another message **in the same chat or thread** to update the running task when Claude supports message replay; otherwise it is queued as a follow-up. An in-flight tool call is not interrupted.',
    '> Also check empty input.',
    'By default, each thread has separate history and another conversation must wait until the bot is idle. With configured session links, rooms share one existing history: other-room messages queue for separate turns and never steer this task. Linked agents do not support `!reset`.',
    '### Attachments',
    '- Send images, files or audio; explain what to do with them in a caption or message.\n- Automatic audio transcription is optional and disabled by default.\n- To receive a file, ask for an **attachment**: a local path link does not send a file to the chat.',
    '### Confirmations and answers',
    '- `!approve` or ✅ — approve an action.\n- `!deny` or ❌ — decline.\n- `!answer blue` — answer a question; replace “blue” with your answer.',
    'Reply in the same chat or thread. If several requests are pending, include the ID from the message: `!approve ID` or `!answer ID your answer`. Replace `ID` with the identifier, without brackets.',
    'A plain “yes” does not approve an action. The first answer is final; removing a reaction does not undo it. For forms, use the format shown by the bot.',
    '### Usage limits · owner only',
    `- \`!usage\` — ${kind === 'codex' ? 'Codex quota, weekly limit, reset date and available additional resets' : 'Claude quota and time until reset'}. Also works during a task.`,
    ...(kind === 'codex' ? [
      '### Plugins · owner only',
      '- `!plugin install github` — install a plugin; replace `github` with its name.',
      'Wait for the active task to finish. The bot will ask you to confirm installation.',
    ] : []),
    '### Reviewed publication',
    '- `!publish {"repository":".","remote":"origin","branch":"main"}` — receive an HTML review, then confirm publishing the shown commits. The bot must be idle and writable. Paths are relative to its workspace.',
    '### Restart · owner only',
    '- `!restart` — restart all bots.\n- `!restart supervisor` — also restart the supervisor process.',
    'All active tasks must finish first. The startup notice returns to the same chat or thread.',
    '### Background tasks',
    '`!tasks` — list background watches and reminders for this chat/thread without a model request, including while busy. Delivery state is not proof of task success.',
    '---',
    'Messages starting with `!` are commands. Unknown commands are not sent to the agent. Create bots and manage access in **Bot Manager**. “Owner” means the initial connector owner.',
  ].join('\n\n');
}
