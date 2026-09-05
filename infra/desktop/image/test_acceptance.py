import os
from pathlib import Path
import subprocess
import tempfile
import unittest


MOCK = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
case = os.environ['ACCEPTANCE_CASE']
if name == 'gcloud':
    if 'describe' in args: print('192.0.2.1')
elif name == 'scp':
    pathlib.Path(args[-1]).write_bytes(b'fixture screenshot')
elif name == 'ssh':
    command = args[-1]
    if 'cat /etc/octogee-computer-image' in command: print('fixture-image')
    elif 'systemd-analyze verify' in command:
        if case == 'nonexecutable-agent':
            print('octo-gateway-agent.service: Command is not executable', file=sys.stderr)
            sys.exit(1)
    elif 'systemd-analyze' in command: print('Startup finished in 1s')
    elif 'lsmod' in command: print(1 if case == 'missing-module' else 2)
    elif 'systemctl is-active' in command:
        states = ['active', 'failed' if case == 'inactive-unit' else 'active', 'active', 'active']
        if 'octo-gateway-agent.service' in command:
            states.append('failed' if case == 'inactive-agent' else 'active')
        print(' '.join(states))
    elif 'systemctl show' in command: print(1 if case == 'desktop-restarted' else 0)
    elif '/health' in command: print(json.dumps({'clients': ['chromium']}))
    elif '/windows' in command: print(json.dumps([{'class': 'chromium', 'title': 'Example Domain - Chromium'}]))
    elif command.startswith('echo persist-'):
        pathlib.Path(os.environ['ACCEPTANCE_MARKER']).write_text(command.split()[1])
    elif 'cat ~/persist-marker' in command:
        print(pathlib.Path(os.environ['ACCEPTANCE_MARKER']).read_text())
        if 'profile-present' in command and '.config/octogee-chromium/Default/Cookies' in command and case != 'missing-profile':
            print('profile-present')
'''


class ImageAcceptanceTests(unittest.TestCase):
    def run_acceptance(self, case):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ('gcloud', 'scp', 'ssh'):
                path = root / name
                path.write_text(MOCK)
                path.chmod(0o755)
            return subprocess.run(
                ['bash', str(Path(__file__).with_name('test.sh')), '--project', 'fixture', '--stop-start'],
                env={**os.environ, 'PATH': f'{root}:{os.environ["PATH"]}',
                     'ACCEPTANCE_CASE': case, 'ACCEPTANCE_MARKER': str(root / 'marker')},
                capture_output=True, text=True, timeout=15,
            )

    def test_current_browser_profile_survives_restart(self):
        result = self.run_acceptance('success')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('Home survives stop/start | yes', result.stdout)

    def test_missing_profile_fails_acceptance(self):
        result = self.run_acceptance('missing-profile')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_missing_drm_module_fails_acceptance(self):
        result = self.run_acceptance('missing-module')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_failed_unit_fails_acceptance(self):
        result = self.run_acceptance('inactive-unit')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_boot_that_requires_service_restart_fails_acceptance(self):
        result = self.run_acceptance('desktop-restarted')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_nonexecutable_registration_agent_fails_acceptance(self):
        result = self.run_acceptance('nonexecutable-agent')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_inactive_registration_agent_fails_acceptance(self):
        result = self.run_acceptance('inactive-agent')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
