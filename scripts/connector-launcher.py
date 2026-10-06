"""Replace this instance's processes before starting a foreground/background supervisor."""
import fcntl
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import time
from contextlib import contextmanager
from dataclasses import dataclass


@dataclass(frozen=True)
class Process:
    pid: int
    started: str
    command: str


def parse_process(pid, value):
    # lstart has five fields; stat identifies zombies, which no longer hold locks.
    fields = value.strip().split(None, 6)
    if len(fields) != 7 or fields[5].startswith('Z'):
        return None
    return Process(pid, ' '.join(fields[:5]), fields[6])


def current_process(pid):
    result = subprocess.run(['ps', '-ww', '-p', str(pid), '-o', 'lstart=,stat=,command='],
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)
    if result.returncode not in (0, 1):
        raise RuntimeError(f'Cannot inspect process {pid}; not starting another instance.')
    return parse_process(pid, result.stdout)


def role(process, node, root):
    try:
        args = shlex.split(process.command)
    except ValueError:
        return None
    if not args or os.path.basename(args[0]) != os.path.basename(node):
        return None
    # Recognize the Node invocation, not a filename passed to an unrelated script
    # or embedded in -e/-p code. Only these startup options precede our entry point.
    options = ('--import', '--require', '-r', '--env-file', '--env-file-if-exists')
    index = 1
    while index < len(args):
        arg = args[index]
        if any(arg.startswith(option + '=') for option in options):
            index += 1
        elif arg in options and index + 1 < len(args):
            index += 1
            end = index + 1
            # ps does not quote paths with spaces. Resolve a split option value
            # only when it names an existing file; bare module names stay intact.
            if os.path.isabs(args[index]):
                while end < len(args) and not Path(' '.join(args[index:end])).is_file():
                    end += 1
            index = end
        else:
            break
    entry = ' '.join(args[index:])
    if not entry or entry.startswith('-') or not (Path(root) / entry).is_file():
        return None
    for name in ('supervisor', 'main'):
        if entry == f'src/{name}.ts' or entry.endswith(f'/src/{name}.ts'):
            return name
    return None


def instance_processes(root, node):
    table = subprocess.check_output(['ps', '-axww', '-o', 'pid=,lstart=,stat=,command='], text=True)
    found = {'supervisor': [], 'main': []}
    for line in table.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) != 2:
            continue
        process = parse_process(int(fields[0]), fields[1])
        name = role(process, node, root) if process else None
        if not name:
            continue
        result = subprocess.run(['lsof', '-a', '-p', str(process.pid), '-d', 'cwd', '-Fn'],
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)
        directories = [line[1:] for line in result.stdout.splitlines() if line.startswith('n')]
        if current_process(process.pid) != process:
            continue
        if not directories:
            raise RuntimeError(f'Cannot identify {name} {process.pid}; leaving running processes untouched.')
        if any(os.path.realpath(path) == root for path in directories):
            found[name].append(process)
    return found


def stop_processes(processes, timeout=30):
    for process in processes:
        # A saved PID (including connector.pid) is never sufficient evidence.
        if current_process(process.pid) != process:
            continue
        print(f'Stopping process {process.pid}.', flush=True)
        try:
            os.kill(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + timeout
    while any(current_process(process.pid) == process for process in processes):
        if time.monotonic() >= deadline:
            raise RuntimeError('The old process has not stopped; not starting another instance.')
        time.sleep(0.1)


def replace_instance(root, node):
    existing = instance_processes(root, node)
    # Stop supervision first so it cannot respawn a connector we are stopping.
    # Its own shutdown waits for its connector and handles an unresponsive child.
    stop_processes(existing['supervisor'])
    remaining = instance_processes(root, node)
    if remaining['supervisor']:
        raise RuntimeError('A supervisor appeared during shutdown; not starting another instance.')
    # Include a standalone connector, or one orphaned by an old supervisor crash.
    stop_processes(list(set(existing['main'] + remaining['main'])))
    if any(instance_processes(root, node).values()):
        raise RuntimeError('An instance process is still running; not starting another instance.')


@contextmanager
def startup_lock(data):
    data.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Keep the inode: the OS releases the lock after a crash or reboot.
    with (data / 'connector-start.lock').open('a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another startup is in progress. Try again in a few seconds.')
        yield


def launch(root, node, directory, code, tsx, foreground=False):
    data = Path(directory)
    log = data / 'connector-supervisor.log'
    child = None

    def stop(signum, frame):
        if child is None:
            raise KeyboardInterrupt()
        child.send_signal(signum)

    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, stop)
    with startup_lock(data):
        replace_instance(root, node)
        args = [node, '--import', tsx, str(Path(code) / 'src/supervisor.ts')]
        if foreground:
            child = subprocess.Popen(args, cwd=root, close_fds=True)
        else:
            with log.open('ab', buffering=0) as output:
                child = subprocess.Popen(args, cwd=root, stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                                         start_new_session=True, close_fds=True)
            time.sleep(2)
            if child.poll() is not None:
                raise RuntimeError(f'Connector supervisor exited. Check {log}')
            print(f'Started connector supervisor (PID {child.pid}). You can close this terminal.')
            print(f'Bot readiness and errors: {log}')
    # Release the startup lock before waiting, so another manual start can replace us.
    return child.wait() if foreground else 0


if __name__ == '__main__':
    try:
        root, node, directory, code, tsx, mode = sys.argv[1:]
        sys.exit(launch(root, node, directory, code, tsx, mode == '--foreground'))
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        sys.exit(str(error))
    except KeyboardInterrupt:
        sys.exit(130)
