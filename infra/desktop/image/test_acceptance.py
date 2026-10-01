import os
from pathlib import Path
import subprocess
import tempfile
import unittest


MOCK = r'''#!/usr/bin/env python3
import json, os, pathlib, struct, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
case = os.environ['ACCEPTANCE_CASE']
if name == 'gcloud':
    if args[:3] == ['compute', 'instances', 'create']:
        ci = os.environ['OCTOGEE_IMAGE_RUN_ID'] != 'manual'
        assert ('--max-run-duration=2h' in args) == ci
        assert ('--instance-termination-action=DELETE' in args) == ci
        if case == 'zone-exhausted' and 'us-central1-a' in args:
            print('ERROR: (gcloud.compute.instances.create) Could not fetch resource:\ncode: ZONE_RESOURCE_POOL_EXHAUSTED', file=sys.stderr)
            sys.exit(1)
        if case == 'create-failed':
            print('ERROR: (gcloud.compute.instances.create) permission denied', file=sys.stderr)
            sys.exit(1)
    if 'describe' in args: assert '--zone' in args and args[args.index('--zone') + 1] == os.environ['ACCEPTANCE_EXPECTED_ZONE']
    if 'describe' in args: print('192.0.2.1')
elif name == 'scp':
    pathlib.Path(args[-1]).write_bytes(b'\x89PNG\r\n\x1a\n' + b'\0' * 8 + struct.pack('>II', 1440, 900))
elif name == 'ssh':
    command = args[-1]
    if command == 'bash -s':
        if case == 'no-accessibility':
            print('Chromium never registered on the accessibility bus', file=sys.stderr)
            sys.exit(1)
        print('accessibility bus unix:path=/run/user/1000/at-spi/bus_0 serves: Chromium')
    elif command == 'bash -s builder-power':
        if case == 'builder-power-broken':
            print('builder power: polkit still asks octo for a password', file=sys.stderr)
            sys.exit(1)
        print('builder power: sudo and polkit passwordless, boot entry enrolled under this machine id, keeps console and drops resume after regen, no first-run tips, Omarchy is up to date')
    elif command == 'bash -s familiar':
        if case == 'familiar-broken':
            print('familiar desktop: Chromium is not floating', file=sys.stderr)
            sys.exit(1)
        print('familiar desktop: hyprbars loaded, theme octogee on 1-quattro.jpg, omarchy round trip clean, idle 1.2%')
    elif command == 'bash -s desk':
        if case == 'desk-broken':
            print('desk: default note is: hello', file=sys.stderr)
            sys.exit(1)
        print('desk: app window chrome-127.0.0.1__desk-Default floating with no browser window, page served, default note, 9 apps with chromium + Nautilus, note round trip, launch validated, time zone round trip (America/Chicago), idle 95.6% with the Desk in front, Chromium policy homepage on "Desk"')
    elif command == 'python3 -':
        if case == 'missing-resize': sys.exit(22)
        if case == 'resize-lost-after-reboot' and pathlib.Path(os.environ['ACCEPTANCE_MARKER']).exists(): sys.exit(22)
        print('display resize verified: 1440x900')
    elif 'cat /etc/octogee-computer-image' in command: print('fixture-image')
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
    elif 'systemctl show octo-home-disk.service' in command:
        if case == 'home-disk-unmounted': print('exit-code')
        else: print('success\n/dev/sdb\n/dev/sdb[/desktop-home]')
    elif 'systemctl show octo-grow-root.service' in command: print('exit-code' if case == 'grow-root-failed' else 'success')
    elif 'systemctl show' in command: print(1 if case == 'desktop-restarted' else 0)
    elif '/health' in command: print(json.dumps({'clients': ['chrome-127.0.0.1__desk-Default']}))
    elif '/windows' in command: print(json.dumps([{'class': 'chrome-127.0.0.1__desk-Default', 'title': 'Desk'}]))
    elif command.startswith('echo persist-'):
        pathlib.Path(os.environ['ACCEPTANCE_MARKER']).write_text(command.split()[1])
    elif 'cat ~/persist-marker' in command:
        print(pathlib.Path(os.environ['ACCEPTANCE_MARKER']).read_text())
        if 'profile-present' in command and '.config/octogee-chromium/Default/Cookies' in command and case != 'missing-profile':
            print('profile-present')
'''


class ImageAcceptanceTests(unittest.TestCase):
    def run_acceptance(self, case, ci=False, expected_zone='us-central1-a'):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ('gcloud', 'scp', 'ssh'):
                path = root / name
                path.write_text(MOCK)
                path.chmod(0o755)
            return subprocess.run(
                ['bash', str(Path(__file__).with_name('test.sh')), '--project', 'fixture', '--stop-start', '--zone', 'us-central1-a', '--fallback-zones', 'us-central1-b,us-central1-c'],
                env={**os.environ, 'PATH': f'{root}:{os.environ["PATH"]}',
                     'ACCEPTANCE_CASE': case, 'OCTOGEE_IMAGE_RUN_ID': '123-1' if ci else 'manual', 'ACCEPTANCE_MARKER': str(root / 'marker'),
                     'ACCEPTANCE_EXPECTED_ZONE': expected_zone},
                capture_output=True, text=True, timeout=15,
            )

    def test_current_browser_profile_survives_restart(self):
        result = self.run_acceptance('success')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('Home survives stop/start | yes', result.stdout)
        self.assertIn('| Accessibility bus | accessibility bus unix:path=/run/user/1000/at-spi/bus_0 serves: Chromium |', result.stdout)

    def test_builder_power_is_reported_and_its_failure_fails_acceptance(self):
        result = self.run_acceptance('success')
        self.assertIn('| Builder power (sudo, polkit, boot entry after regen, tips, updates) | builder power: sudo and polkit passwordless, boot entry enrolled under this machine id, keeps console and drops resume after regen, no first-run tips, Omarchy is up to date |', result.stdout)
        result = self.run_acceptance('builder-power-broken')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('builder power acceptance failed', result.stderr)

    def test_familiar_desktop_is_reported_and_its_failure_fails_acceptance(self):
        result = self.run_acceptance('success')
        self.assertIn('| Familiar desktop | familiar desktop: hyprbars loaded, theme octogee on 1-quattro.jpg, omarchy round trip clean, idle 1.2% |', result.stdout)
        result = self.run_acceptance('familiar-broken')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('familiar desktop acceptance failed', result.stderr)

    def test_desk_is_reported_and_its_failure_fails_acceptance(self):
        result = self.run_acceptance('success')
        self.assertIn('| Desk | desk: app window chrome-127.0.0.1__desk-Default floating with no browser window, page served, default note, 9 apps with chromium + Nautilus, note round trip, launch validated, time zone round trip (America/Chicago), idle 95.6% with the Desk in front, Chromium policy homepage on "Desk" |', result.stdout)
        result = self.run_acceptance('desk-broken')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('desk acceptance failed', result.stderr)

    def test_desktop_without_chromium_on_the_accessibility_bus_fails_acceptance(self):
        result = self.run_acceptance('no-accessibility')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('desktop accessibility bus does not serve Chromium', result.stderr)

    def test_ci_vm_has_independent_cloud_deletion_deadline(self):
        result = self.run_acceptance('success', ci=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_exhausted_zone_falls_back_and_addresses_the_vm_there(self):
        result = self.run_acceptance('zone-exhausted', expected_zone='us-central1-b')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('zone us-central1-a has no capacity', result.stderr)
        self.assertIn('| Zone | us-central1-b |', result.stdout)

    def test_non_capacity_create_failure_does_not_fall_back(self):
        result = self.run_acceptance('create-failed')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('permission denied', result.stderr)
        self.assertNotIn('trying the next zone', result.stderr)

    def test_missing_resize_api_fails_acceptance(self):
        result = self.run_acceptance('missing-resize')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_resize_must_survive_restart(self):
        result = self.run_acceptance('resize-lost-after-reboot')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_missing_profile_fails_acceptance(self):
        result = self.run_acceptance('missing-profile')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_missing_drm_module_fails_acceptance(self):
        result = self.run_acceptance('missing-module')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_failed_unit_fails_acceptance(self):
        result = self.run_acceptance('inactive-unit')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_failed_root_growth_fails_acceptance(self):
        result = self.run_acceptance('grow-root-failed')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('octo-grow-root did not succeed: exit-code', result.stderr)

    def test_unmounted_home_disk_fails_acceptance(self):
        result = self.run_acceptance('home-disk-unmounted')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('octo-home-disk did not mount the home disk: exit-code', result.stderr)

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
