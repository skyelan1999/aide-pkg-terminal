"""Exercise real networking, native serial binding and SSH from the runtime ZIP alone."""
import argparse
import json
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path
root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('archive', type=Path)
parser.add_argument('--live-x11', action='store_true', help='also run real Xvfb/xauth/sshd rendering; invoke through the isolated X11 QA wrapper')
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix='aide-terminal-runtime-') as temporary:
    target = Path(temporary)
    with zipfile.ZipFile(args.archive) as archive:
        assert archive.testzip() is None
        for item in archive.infolist():
            parts = Path(item.filename).parts
            assert not Path(item.filename).is_absolute() and all(p not in ('.', '..') and not p.startswith('.') for p in parts)
            destination = target / item.filename
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(archive.read(item))
    tests = target / 'test'
    tests.mkdir()
    for name in ['sessions.test.js', 'ssh.test.js', 'communications.test.js', 'communications-security.test.js', 'ssh-auth.test.js', 'serial-devices.test.js', 'relay.test.js', 'reconnect.test.js', 'withdrawn-desktop.test.js', 'tcp-proxy-backpressure.test.js', 'telnet.test.js', 'session-copy.test.js', 'x11.test.js', 'xserver.test.js', 'workbench-sandbox.test.js', 'session-feature-fixture.js', 'input-readback.test.js', 'session-log-api.test.js']:
        shutil.copyfile(root / 'test' / name, tests / name)
    subprocess.run(['node', '--test', *[str(file) for file in sorted(tests.glob('*.test.js'))]], cwd=target, check=True)
    print('PASS: tests loaded only the extracted runtime and its bundled production dependencies')
    if args.live_x11:
        for name in ('x11-live.cjs', 'xwd-to-png.py'):
            shutil.copyfile(root / 'test' / name, tests / name)
        subprocess.run(['node', str(tests / 'x11-live.cjs')], cwd=target, check=True)
        print('PASS: real X11 rendering loaded only the extracted runtime')
