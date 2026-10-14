import { isAbsolute, relative, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

export type ExecutorPolicy = {
  workspace: string; mode: 'limited' | 'full'; senders: string[]; rooms: string[];
  sudoActions: Record<string, string[]>;
};
export type RunRequest = { action: 'run'; id: string; argv: string[]; cwd: string; timeoutSeconds: number; wakeIntervalSeconds: number };
export type Request = RunRequest | { action: 'status' | 'cancel' | 'log'; id: string };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const validId = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v);
const argv = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= 128 &&
  v.every(x => typeof x === 'string' && x.length <= 8192 && !x.includes('\0')) && isAbsolute(v[0]);
export function executorPolicy(value: unknown): ExecutorPolicy {
  if (!record(value) || Object.keys(value).some(k => !['workspace', 'mode', 'senders', 'rooms', 'sudoActions'].includes(k)) ||
    typeof value.workspace !== 'string' || !isAbsolute(value.workspace) || !['limited', 'full'].includes(String(value.mode)) ||
    !Array.isArray(value.senders) || !value.senders.length || !value.senders.every(x => typeof x === 'string' && /^@[^\s:]+:\S+$/.test(x)) ||
    !Array.isArray(value.rooms) || !value.rooms.length || !value.rooms.every(x => typeof x === 'string' && /^![^\s:]+:\S+$/.test(x)) ||
    (value.sudoActions !== undefined && (!record(value.sudoActions) || !Object.entries(value.sudoActions).every(([k, v]) => validId(k) && argv(v))))) {
    throw new Error('Invalid executor policy: supply workspace, mode, senders, rooms and optional fixed sudoActions.');
  }
  return { workspace: realpathSync(value.workspace), mode: value.mode as ExecutorPolicy['mode'],
    senders: value.senders as string[], rooms: value.rooms as string[], sudoActions: value.sudoActions as Record<string, string[]> ?? {} };
}
export function parseExecutorRequest(body: string, bot: string, policy: ExecutorPolicy): Request | undefined {
  const prefix = `!exec ${bot} `;
  if (!body.startsWith(prefix)) return;
  if (body.length > 16_000) throw new Error('Executor request exceeds 16000 characters.');
  let v: unknown;
  try { v = JSON.parse(body.slice(prefix.length)); } catch { throw new Error('Supply one JSON object after !exec and the executor Matrix ID.'); }
  if (!record(v) || !validId(v.id)) throw new Error('Supply an id of 1–64 letters, digits, underscores or hyphens.');
  if (['status', 'cancel', 'log'].includes(String(v.action))) {
    if (Object.keys(v).some(k => !['action', 'id'].includes(k))) throw new Error('Unexpected control field.');
    return v as Request;
  }
  if (v.action !== 'run' || Object.keys(v).some(k => !['action', 'id', 'argv', 'cwd', 'timeoutSeconds', 'sudo', 'sudoAction', 'wakeIntervalSeconds'].includes(k))) throw new Error('Unknown executor action or field.');
  const wakeIntervalSeconds = v.wakeIntervalSeconds ?? 0;
  if (!Number.isInteger(wakeIntervalSeconds) || (wakeIntervalSeconds !== 0 && ((wakeIntervalSeconds as number) < 10 || (wakeIntervalSeconds as number) > 86400))) throw new Error('wakeIntervalSeconds must be 0 (off) or 10–86400.');
  const timeoutSeconds = v.timeoutSeconds ?? 3600;
  if (!Number.isInteger(timeoutSeconds) || (timeoutSeconds as number) < 1 || (timeoutSeconds as number) > 86400) throw new Error('timeoutSeconds must be 1–86400.');
  if (v.cwd !== undefined && typeof v.cwd !== 'string') throw new Error('cwd must be a workspace directory.');
  const cwd = realpathSync(resolve(policy.workspace, v.cwd as string ?? '.'));
  const rel = relative(policy.workspace, cwd);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('cwd must be inside the workspace.');
  let command: string[];
  if (v.sudoAction !== undefined) {
    if (typeof v.sudoAction !== 'string' || !Object.hasOwn(policy.sudoActions, v.sudoAction) || v.argv !== undefined || v.sudo !== undefined) throw new Error('Use an owner-configured sudoAction without argv or sudo.');
    command = ['/usr/bin/sudo', '-n', '--', ...policy.sudoActions[v.sudoAction]];
  } else {
    if (!argv(v.argv) || (v.sudo !== undefined && typeof v.sudo !== 'boolean')) throw new Error('argv must start with an absolute executable path.');
    if (v.sudo && policy.mode !== 'full') throw new Error('Arbitrary sudo is disabled by the owner.');
    command = v.sudo ? ['/usr/bin/sudo', '-n', '--', ...v.argv] : v.argv;
  }
  return { action: 'run', id: v.id, argv: command, cwd, timeoutSeconds: timeoutSeconds as number, wakeIntervalSeconds: wakeIntervalSeconds as number };
}

export function executorRoomAllowed(state: any[], bot: string, sender: string, policy: ExecutorPolicy): boolean {
  const get = (type: string) => state.find(e => e.type === type && e.state_key === '')?.content;
  return policy.senders.includes(sender) && get('m.room.encryption')?.algorithm === 'm.megolm.v1.aes-sha2' &&
    get('m.room.join_rules')?.join_rule === 'invite' && get('m.room.history_visibility')?.history_visibility === 'joined' &&
    [bot, sender].every(id => state.some(e => e.type === 'm.room.member' && e.state_key === id && e.content?.membership === 'join'));
}
