import http.server
import pathlib
import pwd
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest

ROOT = pathlib.Path('/source')


class FreshBootAuthorization(unittest.TestCase):
    def test_metadata_outage_recovery_and_revoked_key_admission(self):
        with tempfile.TemporaryDirectory(prefix='octogee-native-ssh-') as temporary:
            root = pathlib.Path(temporary)
            replies = {'outage': False, 'key': ''}

            class Metadata(http.server.BaseHTTPRequestHandler):
                def do_GET(self):
                    if replies['outage']:
                        code, body = 503, 'unavailable'
                    elif self.path.endswith('/instance/id'):
                        code, body = 200, 'fixture-instance'
                    elif self.path.endswith('/block-project-ssh-keys'):
                        code, body = 200, 'true'
                    elif self.path.endswith('/ssh-keys'):
                        code, body = 200, f"octo:{replies['key']}"
                    else:
                        code, body = 404, ''
                    self.send_response(code)
                    self.end_headers()
                    self.wfile.write(body.encode())

                def log_message(self, *_):
                    pass

            metadata = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Metadata)
            threading.Thread(target=metadata.serve_forever, daemon=True).start()
            daemon = None
            last_ssh_error = ''
            diagnostic = root / 'sshd.log'
            try:
                for name in ('host', 'A', 'B', 'C'):
                    subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(root / name)], check=True)
                try:
                    pwd.getpwnam('octo')
                except KeyError:
                    subprocess.run(['useradd', '-m', '-u', '1000', '-U', '-s', '/bin/bash', 'octo'], check=True)
                subprocess.run(['passwd', '-d', 'octo'], check=True, capture_output=True)
                ssh_home = pathlib.Path('/home/octo/.ssh')
                ssh_home.mkdir(mode=0o700, exist_ok=True)
                shutil.chown(ssh_home, user='octo', group='octo')
                ssh_home.chmod(0o700)
                authorized = ssh_home / 'authorized_keys'
                old = (root / 'A.pub').read_text()
                authorized.write_text(old)
                shutil.chown(authorized, user='octo', group='octo')
                authorized.chmod(0o600)
                private = ssh_home / 'id_user_preserved'
                private.write_text('customer private state')
                shutil.chown(private, user='octo', group='octo')
                private.chmod(0o600)
                inode = ssh_home.stat().st_ino
                helper = pathlib.Path('/usr/local/bin/octo-metadata-ssh-keys')
                helper.write_text((ROOT / 'octo-metadata-ssh-keys').read_text().replace(
                    'metadata=http://metadata.google.internal/computeMetadata/v1',
                    f'metadata=http://127.0.0.1:{metadata.server_port}/computeMetadata/v1'))
                helper.chmod(0o755)
                settings = {}
                for line in (ROOT / '10-octogee-home-authorization.conf').read_text().splitlines():
                    if '=' in line:
                        name, value = line.split('=', 1)
                        settings[name] = value
                self.assertIn('octo-home-disk.service', settings['Requires'].split())
                self.assertIn('octo-home-disk.service', settings['After'].split())
                self.assertEqual(settings['ExecStartPre'], str(helper))
                self.assertEqual(settings['StartLimitIntervalSec'], '0')
                with socket.socket() as listener:
                    listener.bind(('127.0.0.1', 0))
                    port = listener.getsockname()[1]
                version = subprocess.run(['ssh', '-V'], capture_output=True, text=True, check=True).stderr
                match = re.search(r'OpenSSH_(\d+)\.(\d+)', version)
                self.assertIsNotNone(match, version)
                penalties = 'PerSourcePenalties no\n' if tuple(map(int, match.groups())) >= (9, 8) else ''
                pathlib.Path('/run/sshd').mkdir(mode=0o755, parents=True, exist_ok=True)
                config = root / 'sshd_config'
                config.write_text(f'''Port {port}
ListenAddress 127.0.0.1
HostKey {root}/host
AuthorizedKeysFile .ssh/authorized_keys
PidFile {root}/sshd.pid
UsePAM no
PasswordAuthentication no
KbdInteractiveAuthentication no
StrictModes yes
{penalties}LogLevel VERBOSE
''')

                def authenticate(name):
                    nonlocal last_ssh_error
                    reply = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
                        '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
                        '-o', 'ConnectTimeout=1', '-i', str(root / name), '-p', str(port),
                        'octo@127.0.0.1', 'true'], capture_output=True, timeout=3)
                    last_ssh_error = reply.stderr.decode()
                    self.assertIn(reply.returncode, (0, 255), last_ssh_error)
                    return reply.returncode == 0

                def reconcile():
                    return subprocess.run([settings['ExecStartPre']], capture_output=True, timeout=10)

                def start():
                    nonlocal daemon
                    result = reconcile()
                    if result.returncode:
                        return False
                    daemon = subprocess.Popen(['/usr/sbin/sshd', '-D', '-E', str(diagnostic), '-f', str(config)],
                        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                    for _ in range(50):
                        if authenticate('B'):
                            return True
                        if daemon.poll() is not None:
                            self.fail(f'{daemon.stderr.read().decode()}; {diagnostic.read_text() if diagnostic.exists() else str(daemon.returncode)}')
                        time.sleep(0.02)
                    self.fail(f'sshd never admitted current key: {last_ssh_error}; {diagnostic.read_text()}')

                replies['outage'] = True
                replies['key'] = (root / 'B.pub').read_text().strip()
                self.assertFalse(start())
                self.assertEqual(authorized.read_text(), old)
                self.assertFalse(authenticate('A'))
                self.assertFalse(authenticate('B'))
                replies['outage'] = False
                self.assertTrue(start())
                self.assertFalse(authenticate('A'))
                self.assertTrue(authenticate('B'))
                replies['outage'] = True
                self.assertNotEqual(reconcile().returncode, 0)
                self.assertFalse(authenticate('A'))
                self.assertTrue(authenticate('B'))
                replies['outage'] = False
                replies['key'] = (root / 'C.pub').read_text().strip()
                self.assertEqual(reconcile().returncode, 0)
                self.assertFalse(authenticate('A'))
                self.assertFalse(authenticate('B'))
                self.assertTrue(authenticate('C'))
                self.assertEqual(ssh_home.stat().st_ino, inode)
                self.assertEqual(private.read_text(), 'customer private state')
            finally:
                if daemon is not None:
                    daemon.terminate()
                    daemon.wait(timeout=5)
                    daemon.stderr.close()
                metadata.shutdown()
                metadata.server_close()


if __name__ == '__main__':
    unittest.main()
