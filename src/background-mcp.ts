import { startToolMcp } from './tool-mcp.js';
import type { BackgroundAction } from './background-tasks.js';
export const BACKGROUND_SERVER = 'riftjack_tasks';
export const BACKGROUND_TOOL = 'mcp__riftjack_tasks__background_tasks';
export const backgroundInstructions = '\nFor work that outlives this turn, use the Riftjack background_tasks MCP tool to watch a JSON status file before ending the turn. First create the file inside your workspace. Call action=watch with label, status_file, a top-level field and its terminal string values (include success and failure); optional timeout_hours is 1–168, default 24. Optionally supply pid for the supervising process on this host. If that PID disappears before a terminal status, watch_process_missing ends the watch and resumes this conversation. Children may still be running; inspect before repeating work. PID checks do not detect hangs or PID reuse and do not signal or kill processes. For tasks with regular status writes, set stale_after_minutes (1–10080, for example 5) and update the JSON well within that interval even when no progress is visible. The timeout measures valid file modification time, starting no earlier than registration; it survives restarts. A watch_stalled notification ends the watch without declaring the process stopped: inspect its state and re-register if needed, never automatically repeat the task. The process must write terminal status on success and failure, preferably by atomic replacement. Riftjack persists the watch and resumes this same conversation when the bot is idle, including after connector restarts. The tool does not launch or keep processes alive. Use action=list to inspect watches or action=cancel with id to stop watching, not to kill the process. Reset or revoked access cancels pending watches. Interrupted delivery is not replayed automatically: inspect existing results before deciding what to do. Do not claim to have registered a watch until the tool confirms it.\nFor a delayed message, call action=remind with label, message, deliver and either delay_minutes (1–10080), at (ISO 8601 with offset, within 7 days), or schedule with frequency (daily or weekly), time (HH:MM), timezone (IANA name), and weekday for weekly (Monday=1 through Sunday=7). Recurring schedules persist automatically; do not register another timer after each run. Use list to see the next due time and last delivery state, and cancel to stop future occurrences. deliver=agent resumes this conversation with the message as your own reminder; deliver=room posts the message to this conversation as you, without starting a turn. Schedule a room message only when the conversation partner asked for it, and tell them the confirmed text and time. Timers survive restarts, appear in list and can be cancelled before they are due; a late timer arrives with a note of its delay.';
export function startBackgroundMcp(action: BackgroundAction, signal: AbortSignal) {
  return startToolMcp({
    name: 'background_tasks',
    description: 'Watch, list or cancel background task completion notifications in this conversation, or schedule a delayed reminder or room message. Watches and timers survive connector restarts. Does not execute commands or stop processes.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['watch', 'remind', 'list', 'cancel'] }, id: { type: 'string' }, label: { type: 'string' },
      status_file: { type: 'string' }, field: { type: 'string' }, terminal: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 16 },
      timeout_hours: { type: 'integer', minimum: 1, maximum: 168 },
      pid: { type: 'integer', minimum: 1, maximum: 2147483647 },
      stale_after_minutes: { type: 'integer', minimum: 1, maximum: 10080 },
      message: { type: 'string', maxLength: 4000 }, deliver: { type: 'string', enum: ['agent', 'room'] },
      delay_minutes: { type: 'integer', minimum: 1, maximum: 10080 }, at: { type: 'string' },
      schedule: { type: 'object', additionalProperties: false, required: ['frequency', 'time', 'timezone'],
        description: 'Recurring reminder, instead of at or delay_minutes. Uses local wall time; skips missed runs and nonexistent DST times, and uses the first occurrence of an ambiguous time.',
        properties: { frequency: { type: 'string', enum: ['daily', 'weekly'] }, time: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' },
          timezone: { type: 'string', maxLength: 100 }, weekday: { type: 'integer', minimum: 1, maximum: 7, description: 'Required for weekly schedules only: Monday=1, Sunday=7.' } } },
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, action, signal, { server: BACKGROUND_SERVER,
    cancelled: 'Background watch request cancelled. Registration may have completed; use list before retrying.',
    failed: 'Background watch request failed. Inspect the watch list before retrying.',
  });
}
