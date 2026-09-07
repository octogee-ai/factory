import os
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


class CandidateBuildTests(unittest.TestCase):
    def test_candidate_does_not_advance_family(self):
        for candidate in [False, True]:
            with self.subTest(candidate=candidate), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                key = root / 'key'
                key.touch()
                (root / "key.pub").write_text("ssh-ed25519 fixture")
                gcloud = root / 'gcloud'
                gcloud.write_text('''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['BUILD_CALLS'], 'a') as log: log.write(json.dumps(args) + '\\n')
if args[:3] == ['compute', 'instances', 'describe']: sys.exit(1)
if 'ssh' in args and 'tail -n' in args[-1]: print('PIPELINE_DONE')
''')
                gcloud.chmod(0o755)
                result = subprocess.run(['bash', str(Path(__file__).with_name('build.sh')), '--project', 'fixture', *(['--candidate'] if candidate else [])],
                    env={**os.environ, 'PATH': f'{root}:{os.environ["PATH"]}', 'OCTOGEE_GCE_SSH_KEY': str(key), 'BUILD_CALLS': str(root / 'calls'), 'OCTOGEE_IMAGE_RUN_ID': '123-1' if candidate else 'manual'}, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                calls = [json.loads(line) for line in (root / 'calls').read_text().splitlines()]
                registration = next(args for args in calls if args[:3] == ['compute', 'images', 'create'])
                self.assertEqual('--family' in registration, not candidate)
                builder = next(args for args in calls if args[:3] == ['compute', 'instances', 'create'])
                self.assertEqual('--max-run-duration=2h' in builder, candidate)
                self.assertEqual('--instance-termination-action=DELETE' in builder, candidate)


if __name__ == '__main__':
    unittest.main()
