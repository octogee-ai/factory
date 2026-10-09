from pathlib import Path
import runpy
import subprocess
import types
import unittest


DESKTOP = 'octo-desktop.service'
USER = 'user@1000.service'
OPERATE = runpy.run_path(str(Path(__file__).parent / 'rootfs/usr/local/bin/octo-desktop-lifecycle'))['operate']


class Systemd:
    def __init__(self):
        self.calls = []
        self.active = {DESKTOP: True, USER: True}
        self.frozen = set()
        self.masked = False
        self.fail = []
        self.fail_after = []

    def __call__(self, argv, **kwargs):
        self.calls.append(argv)
        if argv in self.fail:
            self.fail.remove(argv)
            raise subprocess.CalledProcessError(1, argv, stderr='fixture failure')
        if argv[0] == 'sync':
            return types.SimpleNamespace(stdout='', returncode=0)
        action = argv[1]
        unit = argv[-1]
        if action == 'thaw' and unit == USER and self.masked:
            raise subprocess.CalledProcessError(1, argv, stderr='Unit user@1000.service is masked')
        output = ''
        if action == 'show':
            output = ('active' if self.active[unit] else 'inactive') if '--property=ActiveState' in argv else ('frozen' if unit in self.frozen else 'running')
        elif action == 'is-enabled':
            output = 'masked-runtime' if self.masked else 'static'
        elif action == 'mask': self.masked = True
        elif action == 'unmask': self.masked = False
        elif action == 'freeze': self.frozen.add(unit)
        elif action == 'thaw': self.frozen.discard(unit)
        elif action == 'stop': self.active[unit] = False
        elif action == 'start': self.active[unit] = True
        if argv in self.fail_after:
            self.fail_after.remove(argv)
            raise subprocess.CalledProcessError(1, argv, stderr='fixture reply lost after applying action')
        return types.SimpleNamespace(stdout=output, returncode=0)


class LifecycleTests(unittest.TestCase):
    def test_full_home_restore_refuses_unfenced_ssh_writers_without_mutations(self):
        systemd = Systemd()
        with self.assertRaisesRegex(RuntimeError, 'SSH session writers'):
            OPERATE('stop-home', systemd)
        self.assertEqual(systemd.calls, [])

    def test_freezes_desktop_and_user_apps_before_sync(self):
        systemd = Systemd()
        OPERATE('freeze', systemd)
        self.assertEqual(systemd.frozen, {DESKTOP, USER})
        self.assertEqual(systemd.calls[-1], ['sync', '-f', '/home/octo'])

    def test_partial_freeze_failure_thaws_only_newly_frozen_units(self):
        for already_frozen in (False, True):
            with self.subTest(already_frozen=already_frozen):
                systemd = Systemd()
                if already_frozen: systemd.frozen.add(DESKTOP)
                systemd.fail = [['systemctl', 'freeze', USER]]
                with self.assertRaises(subprocess.CalledProcessError): OPERATE('freeze', systemd)
                self.assertEqual(systemd.frozen, {DESKTOP} if already_frozen else set())

    def test_sync_failure_rolls_back_both_new_freezes(self):
        systemd = Systemd()
        systemd.fail = [['sync', '-f', '/home/octo']]
        with self.assertRaises(subprocess.CalledProcessError): OPERATE('freeze', systemd)
        self.assertFalse(systemd.frozen)

    def test_freeze_that_applies_before_reporting_failure_is_rolled_back(self):
        systemd = Systemd()
        systemd.fail_after = [['systemctl', 'freeze', USER]]
        with self.assertRaises(subprocess.CalledProcessError): OPERATE('freeze', systemd)
        self.assertFalse(systemd.frozen)

    def test_rollback_failure_is_reported(self):
        systemd = Systemd()
        systemd.fail = [['sync', '-f', '/home/octo'], ['systemctl', 'thaw', USER]]
        with self.assertRaisesRegex(RuntimeError, 'rollback'): OPERATE('freeze', systemd)
        self.assertNotIn(DESKTOP, systemd.frozen)

    def test_thaw_failure_still_attempts_other_scope(self):
        systemd = Systemd()
        systemd.frozen.update((DESKTOP, USER))
        systemd.fail = [['systemctl', 'thaw', USER]]
        with self.assertRaises(subprocess.CalledProcessError): OPERATE('thaw', systemd)
        self.assertNotIn(DESKTOP, systemd.frozen)

    def test_frozen_stop_holds_user_manager_until_explicit_start(self):
        systemd = Systemd()
        OPERATE('freeze', systemd)
        OPERATE('stop', systemd)
        self.assertFalse(any(systemd.active.values()))
        self.assertTrue(systemd.masked)
        self.assertFalse(systemd.frozen)
        self.assertLess(systemd.calls.index(['systemctl', 'mask', '--runtime', USER]), systemd.calls.index(['systemctl', 'stop', USER]))
        OPERATE('start', systemd)
        self.assertFalse(systemd.masked)
        self.assertTrue(all(systemd.active.values()))
        self.assertEqual(systemd.calls[-2:], [['systemctl', 'start', USER], ['systemctl', 'start', DESKTOP]])

    def test_failed_stop_releases_new_mask_and_explicit_start_recovers(self):
        systemd = Systemd()
        systemd.fail = [['systemctl', 'stop', USER]]
        with self.assertRaises(subprocess.CalledProcessError): OPERATE('stop', systemd)
        self.assertFalse(systemd.masked)
        OPERATE('start', systemd)
        self.assertTrue(all(systemd.active.values()))

    def test_failed_stop_preserves_existing_restore_hold(self):
        systemd = Systemd()
        systemd.masked = True
        systemd.fail = [['systemctl', 'stop', USER]]
        with self.assertRaises(subprocess.CalledProcessError): OPERATE('stop', systemd)
        self.assertTrue(systemd.masked)

    def test_mask_applied_before_reporting_failure_is_removed(self):
        systemd = Systemd()
        systemd.fail_after = [['systemctl', 'mask', '--runtime', USER]]
        with self.assertRaises(subprocess.CalledProcessError): OPERATE('stop', systemd)
        self.assertFalse(systemd.masked)

    def test_start_recovers_an_active_frozen_user_manager(self):
        systemd = Systemd()
        systemd.masked = True
        systemd.frozen.update((DESKTOP, USER))
        OPERATE('start', systemd)
        self.assertFalse(systemd.frozen)
        self.assertTrue(all(systemd.active.values()))

    def test_inactive_units_and_unknown_actions(self):
        systemd = Systemd()
        systemd.active = {DESKTOP: False, USER: False}
        OPERATE('freeze', systemd)
        self.assertFalse(systemd.frozen)
        with self.assertRaises(ValueError): OPERATE('exec', systemd)


if __name__ == '__main__':
    unittest.main()
