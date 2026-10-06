#!/usr/bin/env python3
"""Save a fetched response into <workspace>/.fetch/<name> without following symlinks.

The connector runs outside the agent's sandbox, but the workspace is writable by the
agent, which could swap any directory on the way for a symlink. So every path
component is opened relative to the previous directory descriptor with O_NOFOLLOW
(Node has no openat), starting from "/": a swap at any moment makes the save fail
instead of redirecting it.

Usage: fetch-save.py WORKSPACE NAME MAX_BYTES
WORKSPACE must be an absolute path without symlinks (the connector passes its
realpath). After the file is created the helper prints "ready". stdin then carries
frames: a 4-byte big-endian length and that many bytes; a zero length commits.
If stdin ends before the commit or SIGTERM arrives, the file is removed. Prints "saved BYTES" on success.
"""
import os
import re
import signal
import sys

DIR = '.fetch'


def open_dir(name, parent):
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)


def read_exact(n):
    data = b''
    while len(data) < n:
        chunk = sys.stdin.buffer.read(n - len(data))
        if not chunk:
            raise EOFError('input ended before the commit')
        data += chunk
    return data


def write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError('no progress writing the file')
        view = view[written:]


def main():
    workspace, name, max_bytes = sys.argv[1], sys.argv[2], int(sys.argv[3])
    if not workspace.startswith('/') or not re.fullmatch(r'[0-9]+-[0-9a-f]+\.(txt|bin)', name):
        raise ValueError('bad arguments')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    for part in [p for p in workspace.split('/') if p]:
        if part in ('.', '..'):
            raise ValueError('bad workspace path')
        child = open_dir(part, fd)
        os.close(fd)
        fd = child
    try:
        os.mkdir(DIR, 0o700, dir_fd=fd)
    except FileExistsError:
        pass
    target = open_dir(DIR, fd)
    os.close(fd)
    out = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=target)
    committed, total = False, 0
    try:
        print('ready', flush=True)
        while True:
            size = int.from_bytes(read_exact(4), 'big')
            if size == 0:
                committed = True
                break
            total += size
            if total > max_bytes:
                raise ValueError('more data than allowed')
            write_all(out, read_exact(size))
    finally:
        os.close(out)
        # The name is removed relative to the same pinned directory, never by path.
        if not committed:
            os.unlink(name, dir_fd=target)
        os.close(target)
    print(f'saved {total}', flush=True)


if __name__ == '__main__':
    # SystemExit unwinds through main's finally, which removes an uncommitted file.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(1))
    try:
        main()
    except Exception as error:
        print(f'{type(error).__name__}: {error}', file=sys.stderr)
        sys.exit(1)
