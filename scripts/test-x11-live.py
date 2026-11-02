#!/usr/bin/env python3
"""Run real authenticated Xvfb/OpenSSH/X-client QA inside an isolated container.

This deliberately refuses a native host. It creates disposable test users only
inside its own Docker namespace; it never installs a host X server or uses xhost.
Usage: AIDE_X11_QA_CONTAINER=1 python3 scripts/test-x11-live.py [command ...]
"""
import atexit
import json
import os
from pathlib import Path
import pwd
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time

if os.environ.get('AIDE_X11_QA_CONTAINER') != '1' or not Path('/.dockerenv').exists() or os.geteuid() != 0:
    raise SystemExit('X11 live QA requires an explicitly opted-in disposable Docker container running as root')
for tool in ('Xvfb', 'xauth', 'sshd', 'ssh-keygen', 'xmessage', 'xwininfo', 'xwd', 'node', 'useradd', 'chpasswd'):
    if not shutil.which(tool):
        raise SystemExit('missing QA dependency: ' + tool)

processes = []
temporary = Path(tempfile.mkdtemp(prefix='aide-real-x11-'))
client = temporary / 'client'
server = temporary / 'server'
client.mkdir(mode=0o700)
server.mkdir(mode=0o755)
os.chmod(temporary, 0o755)
client_uid = 1000
try:
    client_info = pwd.getpwuid(client_uid)
except KeyError:
    subprocess.run(['useradd', '-m', '-u', str(client_uid), '-s', '/bin/sh', 'terminal-x11-client'], check=True)
    client_info = pwd.getpwuid(client_uid)
device = 'terminal-x11-device'
try:
    pwd.getpwnam(device)
except KeyError:
    subprocess.run(['useradd', '-m', '-s', '/bin/sh', device], check=True)
# Unlock this container-only account for public-key login. Password auth stays
# disabled in sshd, and the random credential is neither returned nor logged.
subprocess.run(['chpasswd'], input=device + ':' + secrets.token_urlsafe(40) + '\n', text=True, check=True)
os.chown(client, client_uid, client_info.pw_gid)

def unprivileged():
    os.setgroups([])
    os.setgid(client_info.pw_gid)
    os.setuid(client_uid)

def cleanup():
    for process in reversed(processes):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
    shutil.rmtree(temporary, ignore_errors=True)
atexit.register(cleanup)

key = client / 'identity'
hostkey = server / 'host_ed25519'
for output in (key, hostkey):
    subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(output)], check=True)
os.chown(key, client_uid, client_info.pw_gid)
os.chown(key.with_suffix('.pub'), client_uid, client_info.pw_gid)
device_info = pwd.getpwnam(device)
ssh_directory = Path(device_info.pw_dir) / '.ssh'
ssh_directory.mkdir(mode=0o700, exist_ok=True)
os.chown(ssh_directory, device_info.pw_uid, device_info.pw_gid)
authorized = ssh_directory / 'authorized_keys'
authorized.write_bytes(key.with_suffix('.pub').read_bytes())
authorized.chmod(0o600)
os.chown(authorized, device_info.pw_uid, device_info.pw_gid)

display = ':97'
if Path('/tmp/.X11-unix/X97').exists():
    raise SystemExit('refuse to reuse a pre-existing X server')
authority = client / 'Xauthority'
authority.touch(mode=0o600)
os.chown(authority, client_uid, client_info.pw_gid)
env = {**os.environ, 'DISPLAY': display, 'XAUTHORITY': str(authority)}
subprocess.run(['xauth', '-f', str(authority), 'add', display, 'MIT-MAGIC-COOKIE-1', secrets.token_hex(16)],
               env=env, preexec_fn=unprivileged, stdout=subprocess.DEVNULL, check=True)
Path('/tmp/.X11-unix').mkdir(mode=0o1777, exist_ok=True)
os.chmod('/tmp/.X11-unix', 0o1777)
xlog = open(temporary / 'xvfb.log', 'wb')
processes.append(subprocess.Popen(['Xvfb', display, '-screen', '0', '800x600x24', '-nolisten', 'tcp', '-auth', str(authority), '-noreset'],
                                  env=env, preexec_fn=unprivileged, stdout=xlog, stderr=subprocess.STDOUT))
for _ in range(100):
    if subprocess.run(['xwininfo', '-root'], env=env, preexec_fn=unprivileged, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        break
    time.sleep(0.05)
else:
    raise SystemExit('authenticated Xvfb failed to become ready')

with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    port = listener.getsockname()[1]
Path('/run/sshd').mkdir(exist_ok=True)
configuration = server / 'sshd_config'
configuration.write_text(f'''Port {port}
ListenAddress 127.0.0.1
HostKey {hostkey}
PidFile {server / 'sshd.pid'}
AuthorizedKeysFile {authorized}
StrictModes yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
UsePAM no
AllowUsers {device}
X11Forwarding yes
X11UseLocalhost yes
XAuthLocation /usr/bin/xauth
LogLevel VERBOSE
''')
slog = open(temporary / 'sshd.log', 'wb')
processes.append(subprocess.Popen(['/usr/sbin/sshd', '-D', '-e', '-f', str(configuration)], stdout=slog, stderr=subprocess.STDOUT))
for _ in range(100):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=0.2):
            break
    except OSError:
        time.sleep(0.05)
else:
    raise SystemExit('private loopback sshd failed to become ready')

env.update({'HOME': client_info.pw_dir, 'AIDE_LIVE_X11_ROOT': str(client), 'AIDE_LIVE_X11_PORT': str(port),
            'AIDE_LIVE_X11_USER': device, 'AIDE_LIVE_X11_CLIENT_UID': str(client_uid)})
command = sys.argv[1:] or ['node', 'test/x11-live.cjs']
print(json.dumps({'stage': 'real-X11-QA', 'clientUID': client_uid, 'display': display,
                  'XServer': 'real Xvfb, cookie authenticated, Unix socket only', 'xauth': '/usr/bin/xauth',
                  'SSHServer': 'real OpenSSH, loopback only, public-key auth', 'command': command}), flush=True)
try:
    result = subprocess.run(command, env=env, preexec_fn=unprivileged)
    if result.returncode:
        slog.flush()
        print('private sshd diagnostics:', (temporary / 'sshd.log').read_text()[-8192:], file=sys.stderr)
finally:
    # Diagnostics contain SSH errors, never xauth list output or credentials.
    if processes[-1].poll() not in (None, 0):
        print('private sshd exited:', processes[-1].returncode, file=sys.stderr)
raise SystemExit(result.returncode)
