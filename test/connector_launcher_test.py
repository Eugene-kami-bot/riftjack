import importlib.util
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('connector_launcher', Path(__file__).parents[1] / 'scripts/connector-launcher.py')
launcher = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = launcher
spec.loader.exec_module(launcher)
NODE = os.environ.get('LAUNCHER_TEST_NODE') or shutil.which('node')


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='riftjack-launcher-')
        self.addCleanup(self.temp.cleanup)
        self.root = os.path.realpath(self.temp.name)
        self.data = Path(self.root) / 'data'
        self.code = Path(self.root) / 'code with spaces'
        (self.code / 'src').mkdir(parents=True)
        self.children = []
        self.addCleanup(self.cleanup_children)

    def cleanup_children(self):
        for child in self.children:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)

    def start(self, name, script, cwd=None):
        path = self.code / 'src' / f'{name}.ts'
        path.write_text(script)
        child = subprocess.Popen([NODE, str(path)], cwd=cwd or self.root,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.children.append(child)
        self.assertEqual(child.stdout.readline().strip(), 'ready')
        return child

    def test_real_standalone_connector_and_stale_pid(self):
        unrelated = self.start('unrelated', "console.log('ready'); setInterval(() => {}, 1000)")
        owner = self.start('main', "console.log('ready'); setInterval(() => {}, 1000)")
        self.data.mkdir()
        (self.data / 'connector.pid').write_text(str(unrelated.pid))
        found = launcher.instance_processes(self.root, NODE)
        self.assertEqual([p.pid for p in found['main']], [owner.pid])
        launcher.replace_instance(self.root, NODE)
        self.assertEqual(owner.wait(timeout=5), -signal.SIGTERM)
        self.assertIsNone(unrelated.poll())
        self.assertEqual((self.data / 'connector.pid').read_text(), str(unrelated.pid))

    def test_other_instance_is_untouched(self):
        other = Path(self.root) / 'other'
        other.mkdir()
        child = self.start('supervisor', "console.log('ready'); setInterval(() => {}, 1000)", cwd=other)
        launcher.replace_instance(self.root, NODE)
        self.assertIsNone(child.poll())

    def test_real_supervisor_exits_before_connector_cleanup(self):
        owner = self.start('main', "console.log('ready'); setInterval(() => {}, 1000)")
        supervisor = self.start('supervisor', f"""
import {{ writeFileSync }} from 'node:fs';
console.log('ready');
setInterval(() => {{}}, 1000);
process.on('SIGTERM', () => {{
  process.kill({owner.pid}, 0);
  writeFileSync('supervisor-stopped', 'connector was still alive');
  process.exit(0);
}});
""")
        launcher.replace_instance(self.root, NODE)
        self.assertEqual(supervisor.wait(timeout=5), 0)
        self.assertEqual(owner.wait(timeout=5), -signal.SIGTERM)
        self.assertTrue((Path(self.root) / 'supervisor-stopped').exists())

    def test_timeout_does_not_start_replacement(self):
        owner = self.start('main', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)")
        process = launcher.current_process(owner.pid)
        with self.assertRaisesRegex(RuntimeError, 'not stopped'):
            launcher.stop_processes([process], timeout=0.1)
        self.assertIsNone(owner.poll())
        with patch.object(launcher, 'replace_instance', side_effect=RuntimeError('not stopped')), \
                patch.object(launcher.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(RuntimeError, 'not stopped'):
                launcher.launch(self.root, NODE, str(self.data), str(self.code), 'tsx')
            spawn.assert_not_called()

    def test_pid_reuse_is_not_signalled(self):
        old = launcher.Process(123, 'old start', '/usr/bin/node /code/src/main.ts')
        replacement = launcher.Process(123, 'new start', '/usr/bin/node /code/src/main.ts')
        with patch.object(launcher, 'current_process', return_value=replacement), patch('os.kill') as kill:
            launcher.stop_processes([old], timeout=0)
            kill.assert_not_called()

    def test_unknown_cwd_aborts_before_any_signal(self):
        entry = self.code / 'src/supervisor.ts'
        entry.touch()
        record = 'Mon Oct  5 10:00:00 2026 S /usr/bin/node ' + str(entry)
        with patch('subprocess.check_output', return_value='123 ' + record), \
                patch('subprocess.run', return_value=Mock(stdout='')), \
                patch.object(launcher, 'current_process', return_value=launcher.parse_process(123, record)), \
                patch('os.kill') as kill:
            with self.assertRaisesRegex(RuntimeError, 'Cannot identify'):
                launcher.replace_instance(self.root, '/usr/bin/node')
            kill.assert_not_called()

    def test_simultaneous_launch_is_rejected_and_lock_survives(self):
        with launcher.startup_lock(self.data):
            with self.assertRaisesRegex(RuntimeError, 'startup is in progress'):
                with launcher.startup_lock(self.data):
                    self.fail('acquired twice')
        inode = (self.data / 'connector-start.lock').stat().st_ino
        with launcher.startup_lock(self.data):
            self.assertEqual((self.data / 'connector-start.lock').stat().st_ino, inode)

    def test_new_supervisor_during_stop_aborts(self):
        old = launcher.Process(123, 'old', 'node /code/src/supervisor.ts')
        new = launcher.Process(456, 'new', 'node /code/src/supervisor.ts')
        with patch.object(launcher, 'instance_processes', side_effect=[
            {'supervisor': [old], 'main': []}, {'supervisor': [new], 'main': []}
        ]), patch.object(launcher, 'stop_processes') as stop:
            with self.assertRaisesRegex(RuntimeError, 'appeared during shutdown'):
                launcher.replace_instance(self.root, NODE)
            stop.assert_called_once_with([old])

    def test_eval_and_check_commands_are_not_services(self):
        entry = self.code / 'src/main.ts'
        entry.touch()
        for command in [f'node unrelated.js {entry}', 'node -e /code/src/main.ts', 'node --eval=/code/src/main.ts',
                        'node /code/src/main.ts --check-config', 'node /code/src/main.ts --bootstrap-codex']:
            self.assertIsNone(launcher.role(launcher.Process(123, 'now', command), 'node', self.root))

    def test_foreground_releases_lock_before_wait_and_forwards_signal(self):
        child = Mock()
        child.wait.return_value = 0
        def wait():
            with launcher.startup_lock(self.data):
                signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
            return 0
        child.wait.side_effect = wait
        with patch.object(launcher, 'replace_instance') as replace, patch('subprocess.Popen', return_value=child) as spawn:
            self.assertEqual(launcher.launch(self.root, NODE, str(self.data), str(self.code), 'tsx', True), 0)
            replace.assert_called_once_with(self.root, NODE)
            self.assertNotIn('start_new_session', spawn.call_args.kwargs)
            child.send_signal.assert_called_once_with(signal.SIGTERM)

    def test_background_launch_waits_for_replacement_then_detaches(self):
        order = []
        child = Mock(pid=12345)
        child.poll.return_value = None
        def spawn(*args, **kwargs):
            order.append('spawn')
            self.assertTrue(kwargs['start_new_session'])
            return child
        with patch.object(launcher, 'replace_instance', side_effect=lambda *args: order.append('stop')), \
                patch('subprocess.Popen', side_effect=spawn), patch('time.sleep'):
            self.assertEqual(launcher.launch(self.root, NODE, str(self.data), str(self.code), 'tsx'), 0)
        self.assertEqual(order, ['stop', 'spawn'])
        child.wait.assert_not_called()


if __name__ == '__main__':
    unittest.main()
