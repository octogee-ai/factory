import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

SESSION = Path(__file__).parents[2] / 'gateway/hobby-session.sh'


@unittest.skipUnless(sys.platform == 'linux', 'production session requires Linux Bash 5')
class HobbySessionTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.binary = self.root / 'bin'
        self.binary.mkdir()
        (self.root / 'runtime/octogee-openclaw-vnc').mkdir(parents=True)
        commands = ('Xvnc', 'openbox', 'octo-desktop-control', 'entrypoint.sh', 'octogee-desktop-node', 'octo-desktop-browser', 'tigervncpasswd', 'xdpyinfo')
        stub = '''
import os
from pathlib import Path
import signal
import sys
import time
root = Path(os.environ['HOME'])
name = Path(sys.argv[0]).name
if name == 'xdpyinfo':
    sys.exit(0)
if name == 'tigervncpasswd':
    sys.stdin.read()
    sys.stdout.write('encoded-password')
    sys.exit(0)
with (root / ('launches-' + name)).open('a') as f:
    f.write(str(os.getpid()) + '\\n')
if name == 'octo-desktop-control' and os.environ.get('EARLY_RESTART') == '1':
    os.kill(int(os.environ['OCTO_SUPERVISOR_PID']), signal.SIGUSR1)
while not (root / ('exit-' + name)).exists():
    time.sleep(0.01)
sys.exit(0)
'''
        for command in commands:
            path = self.binary / command
            path.write_text(f'#!{sys.executable}\n' + stub)
            path.chmod(0o755)
        self.script = self.root / 'session.sh'
        self.script.write_text(SESSION.read_text().replace('/usr/local/bin/', str(self.binary) + '/'))
        self.log = (self.root / 'log').open('w+')
        self.process = None

    def tearDown(self):
        if self.process:
            if self.process.poll() is None:
                self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait()
        self.log.close()
        self.directory.cleanup()

    def launch(self, early=False):
        env = {**os.environ, 'HOME': str(self.root), 'PATH': f'{self.binary}:{os.environ["PATH"]}',
               'XDG_RUNTIME_DIR': str(self.root / 'runtime'), 'OPENCLAW_GATEWAY_TOKEN': 'test-gateway-token', 'EARLY_RESTART': '1' if early else '0'}
        self.process = subprocess.Popen(['bash', str(self.script)], env=env, stdout=self.log, stderr=self.log, start_new_session=True)
        self.await_condition(lambda: self.count('octo-desktop-browser') >= 1)
        self.await_condition(lambda: self.count('octogee-desktop-node') == 1)

    def count(self, name):
        path = self.root / ('launches-' + name)
        return len(path.read_text().splitlines()) if path.exists() else 0

    def await_condition(self, predicate):
        deadline = time.monotonic() + 5
        while not predicate():
            if time.monotonic() >= deadline:
                self.log.seek(0)
                self.fail(self.log.read())
            time.sleep(0.01)

    def test_restarts_chromium_without_restarting_gateway_or_node(self):
        self.launch()
        self.process.send_signal(signal.SIGUSR1)
        self.await_condition(lambda: self.count('octo-desktop-browser') == 2)
        self.assertIsNone(self.process.poll())
        self.assertEqual(self.count('entrypoint.sh'), 1)
        self.assertEqual(self.count('octogee-desktop-node'), 1)
        password = self.root / 'runtime/octogee-openclaw-vnc/password'
        self.assertEqual(len(password.read_text().strip()), 8)
        self.assertEqual(password.stat().st_mode & 0o777, 0o600)

    def test_an_early_egress_signal_still_starts_a_browser(self):
        self.launch(early=True)
        self.assertIsNone(self.process.poll())

    def test_required_desktop_process_failure_restarts_the_container(self):
        self.launch()
        (self.root / 'exit-openbox').touch()
        self.assertEqual(self.process.wait(timeout=5), 1)
        self.log.seek(0)
        self.assertIn('required process', self.log.read())

    def test_closed_browser_is_relaunched(self):
        self.launch()
        (self.root / 'exit-octo-desktop-browser').touch()
        self.await_condition(lambda: self.count('octo-desktop-browser') >= 2)
        self.assertIsNone(self.process.poll())
