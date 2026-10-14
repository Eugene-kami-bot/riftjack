import { openSync, closeSync, writeFileSync, fsyncSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export function syncDirectory(dir) {
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
// Persist contents before replacement, then the directory entry before returning.
// Callers must not launch a command or acknowledge admission if this fails.
export function saveJson(path, value) {
  const temp = path + '.tmp';
  const fd = openSync(temp, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  syncDirectory(dirname(path));
}
