#!/usr/bin/env python3
"""Copy the latest encrypted Trust Center backup over operator-configured SSH."""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import uuid

NAME = r'financio-trust-center_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{8}\.tar\.age'
REMOTE_DIRECTORY = '/var/backups/financio-trust-center'
REMOTE_METADATA = r'''
import json,pathlib,re
root=pathlib.Path('/var/backups/financio-trust-center')
files=[p for p in root.glob('financio-trust-center_*.tar.age') if not p.is_symlink()
       and re.fullmatch(r'financio-trust-center_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{8}\.tar\.age',p.name)
       and p.with_suffix('.age.json').is_file()]
if not files: raise RuntimeError('No completed backup')
p=max(files,key=lambda p:p.name)
receipt=json.loads(p.with_suffix('.age.json').read_text())
assert receipt['backup']==p.name and receipt['bytes']==p.stat().st_size
print(json.dumps(receipt))
'''


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def remote_command(code):
    return 'sudo -n /usr/bin/python3 -c ' + shlex.quote(code)


def sync(config_path):
    info = config_path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.geteuid():
        raise ValueError('Private operator configuration required')
    config = json.loads(config_path.read_text())
    ssh = config['ssh_argv']
    if not ssh or Path(ssh[0]).name != 'ssh':
        raise ValueError('A normal SSH command is required')
    directory = Path(config['directory'])
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink() or directory.stat().st_mode & 0o077:
        raise ValueError('Private backup directory required')
    with (directory / '.pull.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = subprocess.run(ssh + [remote_command(REMOTE_METADATA)],
                                capture_output=True, timeout=40)
        if result.returncode:
            raise RuntimeError('Backup metadata read failed')
        receipt = json.loads(result.stdout)
        if not re.fullmatch(NAME, receipt['backup']) or not re.fullmatch(r'[a-f0-9]{64}', receipt['sha256']):
            raise ValueError('Invalid backup metadata')
        if not 0 < receipt['bytes'] <= 1024 * 1024 * 1024:
            raise ValueError('Backup size exceeds the off-host limit')
        target = directory / receipt['backup']
        if target.is_symlink():
            raise ValueError('Refusing a symlink backup destination')
        if not target.exists() or digest(target) != receipt['sha256']:
            pending = target.with_suffix('.age.' + uuid.uuid4().hex + '.partial')
            # The file is already encrypted; the VM never receives the age identity.
            code = 'import pathlib,sys,shutil\np=pathlib.Path(' + repr(REMOTE_DIRECTORY + '/' + target.name) + ')\n'
            code += "assert not p.is_symlink()\nwith p.open('rb') as f: shutil.copyfileobj(f,sys.stdout.buffer)\n"
            try:
                with pending.open('xb') as output:
                    copied = subprocess.run(ssh + [remote_command(code)], stdout=output,
                                            stderr=subprocess.DEVNULL, timeout=300)
                    output.flush()
                    os.fsync(output.fileno())
                if copied.returncode or pending.stat().st_size != receipt['bytes'] or digest(pending) != receipt['sha256']:
                    raise RuntimeError('Off-host backup copy failed verification')
                os.replace(pending, target)
            finally:
                pending.unlink(missing_ok=True)
        receipt['off_host_checksum_verified'] = True
        receipt['off_host_verified_at'] = dt.datetime.now(dt.timezone.utc).isoformat()
        target.with_suffix('.age.json').write_text(json.dumps(receipt, indent=2) + '\n')
        (directory / 'latest.json').write_text(json.dumps(receipt, indent=2) + '\n')
        return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        print(json.dumps(sync(args.config)))
    except (OSError, ValueError, RuntimeError, KeyError, subprocess.TimeoutExpired):
        print('Encrypted backup copy failed; verify SSH access and the protected task configuration.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
