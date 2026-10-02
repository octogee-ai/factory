import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest


RUN = Path(__file__).parents[1] / 'rootfs/usr/local/bin/octo-desktop-run'
SERVICES = ('labwc', 'octo-seat-input', 'wayvnc', 'octo-desktop-openclaw-vnc',
            'websockify', 'octo-desktop-control')
BROWSER = 'octo-desktop-browser'


class SupervisionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        binary = self.root / 'bin'
        binary.mkdir()
        (self.root / '.local/state/octo-desktop').mkdir(parents=True)
        (self.root / 'pids').mkdir()
        stub = '''
import os
from pathlib import Path
import sys
import time
root = Path(os.environ['HOME'])
name = Path(sys.argv[0]).name
if name == 'wlr-randr':
    sys.exit(0)
if name == 'labwc':
    (root / 'wayland-0').touch()
if name == 'octo-seat-input':
    print('ready', flush=True)
pid_file = root / 'pids' / name
pid_file.with_suffix('.pending').write_text(str(os.getpid()))
pid_file.with_suffix('.pending').replace(pid_file)
while not (root / ('exit-' + name)).exists():
    time.sleep(0.01)
sys.exit(int((root / ('exit-' + name)).read_text()))
'''
        for name in (*SERVICES, BROWSER, 'wlr-randr'):
            executable = binary / name
            executable.write_text(f'#!{sys.executable}\n' + stub)
            executable.chmod(0o755)
        script = self.root / 'run'
        script.write_text(RUN.read_text().replace('/usr/local/bin/', str(binary) + '/'))
        self.log = (self.root / 'output').open('w+')
        self.addCleanup(self.log.close)
        self.process = subprocess.Popen(
            [os.environ.get('OCTOGEE_TEST_BASH', shutil.which('bash')), str(script)],
            env={**os.environ, 'HOME': str(self.root), 'XDG_RUNTIME_DIR': str(self.root),
                 'OCTO_COMPOSITOR': 'labwc', 'PATH': f'{binary}:{os.environ["PATH"]}'},
            stdout=self.log, stderr=subprocess.STDOUT, start_new_session=True,
        )
        self.addCleanup(self.stop)
        self.wait_for(lambda: all((self.root / 'pids' / name).exists()
                                 for name in (*SERVICES, BROWSER)))

    def output(self):
        return (self.root / 'output').read_text()

    def wait_for(self, predicate):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.01)
        self.fail(self.output())

    def stop(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait(timeout=3)

    def exit_child(self, name, status=0):
        exit_file = self.root / ('exit-' + name)
        pending = exit_file.with_suffix('.pending')
        pending.write_text(str(status))
        pending.replace(exit_file)

    def assert_services_running(self):
        self.assertIsNone(self.process.poll(), self.output())
        for name in SERVICES:
            os.kill(int((self.root / 'pids' / name).read_text()), 0)

    def assert_stopped(self):
        self.process.wait(timeout=5)
        for pid_file in (self.root / 'pids').iterdir():
            with self.assertRaises(ProcessLookupError, msg=pid_file.name):
                os.kill(int(pid_file.read_text()), 0)

    def test_closing_chromium_preserves_the_desktop_services(self):
        self.exit_child(BROWSER)
        self.wait_for(lambda: 'Chromium exited (status=0)' in self.output() or self.process.poll() is not None)
        self.assert_services_running()
        self.assertIn('Chromium exited (status=0)', self.output())

    def test_chromium_crash_is_reported_without_stopping_the_desktop(self):
        self.exit_child(BROWSER, 17)
        self.wait_for(lambda: 'Chromium exited (status=17)' in self.output() or self.process.poll() is not None)
        self.assert_services_running()
        self.assertIn('Chromium exited (status=17)', self.output())

    def test_core_service_exit_stops_the_remaining_session(self):
        self.exit_child('wayvnc', 23)
        self.assert_stopped()
        self.assertIn('status=23', self.output())

    def test_core_service_exit_after_chromium_closed_still_stops_the_session(self):
        self.exit_child(BROWSER)
        self.wait_for(lambda: 'Chromium exited' in self.output() or self.process.poll() is not None)
        self.assert_services_running()
        self.exit_child('labwc', 23)
        self.assert_stopped()
        self.assertIn('status=23', self.output())

    def test_session_stop_terminates_chromium_and_core_services(self):
        self.process.terminate()
        self.assert_stopped()


if __name__ == '__main__':
    unittest.main()
