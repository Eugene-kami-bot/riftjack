import { realpathSync, statSync, accessSync, mkdirSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname, basename, join } from 'node:path';
import type { Config } from './config.js';
import { audioOutsideWorkspace } from './audio-transcription.js';
import { PublicError } from './errors.js';
import type { Interact } from './interactions.js';

function expandWorkspace(path: string, base: string): string {
  if (!path || path.length > 4096 || /[\0\r\n]/.test(path)) throw new PublicError('Workspace must be a non-empty local directory path.');
  return path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(base, path);
}

export function resolveWorkspace(path: string, base: string): string {
  const expanded = expandWorkspace(path, base);
  try {
    const directory = realpathSync(expanded);
    if (!statSync(directory).isDirectory()) throw new Error('not a directory');
    accessSync(directory, constants.R_OK | constants.X_OK);
    return directory;
  } catch {
    throw new PublicError('Workspace does not exist, is not a directory, or is inaccessible. Create the folder on the connector host first and use its absolute path.');
  }
}

export function configForWorkspace(config: Config, workspace?: string): Config {
  const selected = workspace === undefined ? config : { ...config, workspace: resolveWorkspace(workspace, config.workspace) };
  if (selected.audioTranscription) {
    try { audioOutsideWorkspace(selected.audioTranscription, selected.workspace); }
    catch {
      return { ...selected, audioTranscription: undefined,
        audioTranscriptionWarning: 'Audio transcription is disabled: its files must be outside every agent workspace. Original audio attachments remain available. Move the transcription files and restart to enable transcription.' };
    }
  }
  return selected;
}

// Resolve existing ancestors too, so the confirmation shows the actual destination.
function inspectWorkspace(path: string): { path: string; exists: boolean; identity?: string } {
  try {
    const stat = statSync(path);
    if (!stat.isDirectory()) throw new PublicError('The path is a file, not a directory. Choose another folder.');
    accessSync(path, constants.R_OK | constants.X_OK);
    return { path: realpathSync(path), exists: true, identity: `${stat.dev}:${stat.ino}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof PublicError) throw error;
      throw new PublicError('Could not access the workspace. Check its path and permissions.');
    }
    const parent = dirname(path);
    if (parent === path) throw new PublicError('Could not find a parent directory.');
    return { path: join(inspectWorkspace(parent).path, basename(path)), exists: false };
  }
}

// null means declined; undefined retains the configured default workspace.
export async function creationWorkspace(config: Config, requested: string | undefined, sender: string,
  interact: Interact | undefined, signal: AbortSignal): Promise<string | undefined | null> {
  if (requested !== undefined && sender !== config.owner) throw new PublicError('Only the initial owner can select a custom workspace when creating a bot.');
  if (!interact) throw new PublicError('Could not request workspace confirmation. Bot creation cancelled.');
  const target = expandWorkspace(requested ?? config.workspace, config.workspace);
  while (true) {
    signal.throwIfAborted();
    const before = inspectWorkspace(target);
    const answer = await interact({
      text: before.exists
        ? `This folder already exists:\n${before.path}\nUse it for the new bot? The bot will work with the files in this folder.`
        : `This folder does not exist yet:\n${before.path}\nCreate it, including any missing parent directories, and use it for the new bot?`,
      approve: { approved: true }, deny: { approved: false },
    }, signal);
    signal.throwIfAborted();
    if ((answer as { approved?: boolean }).approved !== true) return null;
    const after = inspectWorkspace(target);
    // A newly appeared/replaced directory needs its own confirmation.
    if (before.path !== after.path || before.exists !== after.exists || before.identity !== after.identity) continue;
    if (!after.exists) {
      try { mkdirSync(after.path, { recursive: true, mode: 0o700 }); }
      catch { throw new PublicError('Could not create the workspace. Check its path and permissions. The bot was not created.'); }
    }
    const directory = resolveWorkspace(after.path, config.workspace);
    return requested === undefined ? undefined : directory;
  }
}
