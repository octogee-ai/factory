import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest


class FailureEvidenceTests(unittest.TestCase):
    def run_failure(self, started=True, running=True, upload_fails=False):
        functions = Path(__file__).with_name('pipeline.sh').read_text().split('mkdir -p "$WORK"', 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'serial.log').write_text('installer failed')
            with socket.socket(socket.AF_UNIX) as monitor:
                monitor.bind(str(root / 'monitor.sock'))
                result = subprocess.run(['bash', '-c', functions + r'''
WORK="$EVIDENCE_WORK"
MONITOR="$WORK/monitor.sock"
guest_started="$TEST_STARTED"
qemu_running() { [[ "$TEST_RUNNING" == 1 ]]; }
socat() { read -r command path; [[ "$command" == screendump ]]; printf 'screen' > "$path"; }
gcloud() {
  printf '%s\n' "$*" >> "$WORK/uploads"
  [[ "$TEST_UPLOAD_FAILS" == 0 ]]
}
die 'installation timed out'
'''], env={**os.environ, 'OMARCHY_VERSION': 'fixture', 'OMARCHY_ISO_SHA256': 'fixture',
                       'IMAGE_NAME': 'candidate', 'IMAGE_BUCKET': 'gs://fixture',
                       'EVIDENCE_WORK': directory, 'TEST_STARTED': str(int(started)),
                       'TEST_RUNNING': str(int(running)), 'TEST_UPLOAD_FAILS': str(int(upload_fails))},
                    capture_output=True, text=True, timeout=10)
            uploads = (root / 'uploads').read_text() if (root / 'uploads').exists() else ''
            return result, uploads

    def test_install_timeout_captures_screen_and_serial_before_exiting(self):
        result, uploads = self.run_failure()
        self.assertEqual(result.returncode, 1)
        self.assertIn('ERROR: installation timed out', result.stdout)
        self.assertIn('gs://fixture/images/candidate.failed.screen.ppm', uploads)
        self.assertIn('gs://fixture/images/candidate.failed.serial.log', uploads)

    def test_failure_before_guest_start_does_not_upload_evidence(self):
        result, uploads = self.run_failure(started=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(uploads, '')

    def test_exited_guest_still_uploads_serial(self):
        result, uploads = self.run_failure(running=False)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('screen.ppm', uploads)
        self.assertIn('candidate.failed.serial.log', uploads)

    def test_upload_failure_is_logged_and_does_not_skip_other_evidence(self):
        result, uploads = self.run_failure(upload_fails=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout.count('could not upload failure evidence'), 2)
        self.assertIn('candidate.failed.serial.log', uploads)


if __name__ == '__main__':
    unittest.main()
