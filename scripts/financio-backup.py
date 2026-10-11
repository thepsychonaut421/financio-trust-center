#!/usr/bin/env python3
"""Encrypted native Supabase + local-upload backup; isolated restore drill only."""
import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

SCHEMAS = ('public', 'auth', 'extensions')
VOLUME = 'financio-trust-center_trust-center-uploads'
MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024
MAX_ARCHIVE_FILES = 10000
SECURITY_SQL = """
SELECT jsonb_build_object(
 'rls', (SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity)
          ORDER BY n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname IN ('public','auth') AND c.relkind='r'),
 'policies', (SELECT jsonb_agg(to_jsonb(p) ORDER BY schemaname,tablename,policyname)
             FROM pg_policies p WHERE schemaname IN ('public','auth')),
 'rpc_access', (SELECT jsonb_agg(jsonb_build_object('function',p.oid::regprocedure::text,
               'anon',has_function_privilege('anon',p.oid,'execute'),
               'authenticated',has_function_privilege('authenticated',p.oid,'execute'),
               'service_role',has_function_privilege('service_role',p.oid,'execute')) ORDER BY p.oid::regprocedure::text)
               FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
               AND p.proname IN ('create_changelog_draft','review_changelog_draft',
                 'create_user_with_password','update_user_password','get_all_users'))
);
"""
COUNTS_SQL = r"""
SELECT format('SELECT %L || ''|'' || count(*) FROM %I.%I;',
              n.nspname||'.'||c.relname,n.nspname,c.relname)
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('public','auth') AND c.relkind='r' ORDER BY n.nspname,c.relname
\gexec
"""
ROLES_SQL = """
SELECT jsonb_agg(jsonb_build_object('name',rolname,'inherit',rolinherit,'bypassrls',rolbypassrls)
                ORDER BY rolname) FROM pg_roles WHERE rolname NOT LIKE 'pg_%' AND rolname<>'postgres';
SELECT jsonb_agg(jsonb_build_array(r.rolname,m.rolname) ORDER BY r.rolname,m.rolname)
 FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member;
"""
EXTENSIONS_SQL = """
SELECT jsonb_agg(jsonb_build_object('name',e.extname,'schema',n.nspname,'version',e.extversion)
                ORDER BY e.extname)
 FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
 WHERE n.nspname IN ('public','auth','extensions');
"""


class BackupError(Exception):
    pass


def run(args, *, input=None, env=None, cwd=None, timeout=120):
    """Never include captured provider errors, SQL, config or credentials in logs."""
    result = subprocess.run(args, input=input, env=env, cwd=cwd,
                            capture_output=True, timeout=timeout)
    if result.returncode:
        step = ' '.join(args[:2]) if Path(args[0]).name == 'docker' else Path(args[0]).name
        raise BackupError(f'{step} operation failed (exit {result.returncode})')
    return result.stdout


def protected_file(path):
    path = Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.geteuid():
        raise BackupError('Secret/config file must be a regular file owned by the operator with mode 0600')
    return path


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def read_config(path):
    config = json.loads(protected_file(path).read_text())
    if config.get('purpose') != 'financio-trust-center':
        raise BackupError('A dedicated Financio Trust Center backup configuration is required')
    if not re.fullmatch(r'[a-z]{20}', config.get('project_ref', '')):
        raise BackupError('Invalid dedicated Supabase project reference')
    pg = config['postgres']
    if pg['user'] != 'postgres.' + config['project_ref'] or pg.get('database') != 'postgres':
        raise BackupError('Database identity does not match the dedicated project')
    if not re.fullmatch(r'age1[0-9a-z]{58}', config.get('recipient', '')):
        raise BackupError('An age public recipient is required; private keys must remain off this VM')
    protected_file(pg['passfile'])
    app = Path(config['app_dir']).resolve()
    if app.name != 'financio-trust-center' or not (app / 'docker-compose.financio.yml').is_file():
        raise BackupError('Refusing a checkout other than the dedicated Trust Center')
    env = os.environ.copy()
    # Clear inherited PG selectors; the protected task config is the only source.
    for key in list(env):
        if key.startswith('PG'):
            del env[key]
    env.update(PGHOST=pg['host'], PGPORT=str(pg['port']), PGDATABASE=pg['database'],
               PGUSER=pg['user'], PGPASSFILE=pg['passfile'], PGSSLMODE='verify-full',
               PGSSLROOTCERT=pg['rootcert'], PGCONNECT_TIMEOUT='10',
               PGOPTIONS='-c statement_timeout=60000')
    if not Path(pg['rootcert']).is_file():
        raise BackupError('Supabase TLS verification certificate is missing')
    return config, app, env


class Snapshot:
    def __init__(self, env):
        self.process = subprocess.Popen(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'],
                                        env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, text=True)

    def query(self, sql):
        marker = '__financio_' + uuid.uuid4().hex
        self.process.stdin.write(sql + f"\nSELECT '{marker}';\n")
        self.process.stdin.flush()
        output = []
        while True:
            line = self.process.stdout.readline()
            if not line:
                raise BackupError('Read-only database snapshot failed')
            if line.rstrip('\n') == marker:
                return output
            output.append(line.rstrip('\n'))

    def close(self):
        with contextlib.suppress(BrokenPipeError):
            self.process.stdin.write('ROLLBACK;\n\\q\n')
            self.process.stdin.flush()
        self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.process.stdout.close()


def table_counts(lines):
    return {name: int(count) for name, count in (line.rsplit('|', 1) for line in lines)}


def dump_arguments(destination, snapshot_id, extensions):
    # --schema by itself omits extension creation. Explicit inclusion preserves
    # UUID/crypto function dependencies needed by table defaults and native Auth.
    return ['pg_dump', '--format=custom', '--file', str(destination), '--snapshot', snapshot_id] \
        + [f'--schema={schema}' for schema in SCHEMAS] \
        + [f"--extension={extension['name']}" for extension in extensions]


def regular_files(root):
    for path in sorted(Path(root).rglob('*')):
        info = path.lstat()
        if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
            raise BackupError('Upload storage contains a symlink or special file')
        if stat.S_ISREG(info.st_mode):
            yield path


def encrypted_archive(files, manifest, target, recipient):
    pending = target.with_suffix('.age.pending')
    try:
        with pending.open('xb') as destination:
            process = subprocess.Popen(['age', '-r', recipient], stdin=subprocess.PIPE,
                                       stdout=destination, stderr=subprocess.DEVNULL)
            try:
                with tarfile.open(fileobj=process.stdin, mode='w|') as archive:
                    import io
                    data = json.dumps(manifest, sort_keys=True).encode()
                    info = tarfile.TarInfo('manifest.json')
                    info.size, info.mode = len(data), 0o600
                    archive.addfile(info, io.BytesIO(data))
                    for name, path in sorted(files.items()):
                        archive.add(path, arcname=name, recursive=False)
                process.stdin.close()
                if process.wait(timeout=120):
                    raise BackupError('Backup encryption failed')
                destination.flush()
                os.fsync(destination.fileno())
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
        os.replace(pending, target)
    finally:
        pending.unlink(missing_ok=True)


def create_backup(config_path):
    config, app, env = read_config(config_path)
    backup_dir = Path(config['backup_dir'])
    backup_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if backup_dir.is_symlink() or backup_dir.stat().st_mode & 0o077:
        raise BackupError('Backup directory must be private (mode 0700)')
    # The root systemd unit hides operator home directories. Read only this
    # explicitly trusted checkout; do not depend on a user's global git config.
    git_env = os.environ.copy()
    git_env.update(GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1')
    source_sha = run(['git', '-c', 'safe.directory=' + str(app), 'rev-parse', 'HEAD'],
                     env=git_env, cwd=app).decode().strip()
    if not re.fullmatch(r'[a-f0-9]{40}', source_sha):
        raise BackupError('Unable to identify the Trust Center source revision')
    # Check credentials/connectivity before introducing any API maintenance.
    run(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT 1;'], env=env, timeout=30)
    compose = ['docker', 'compose', '--env-file', '.env.financio.local', '-f', 'docker-compose.financio.yml']
    container = run(compose + ['ps', '-q', 'backend'], cwd=app).decode().strip()
    if not container or run(['docker', 'inspect', '-f', '{{.State.Running}}', container]).strip() != b'true':
        raise BackupError('Backend must already be running; refusing to change an inactive deployment')
    started = time.monotonic()
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    target = backup_dir / f'financio-trust-center_{stamp}_{uuid.uuid4().hex[:8]}.tar.age'
    snapshot = None
    quiesced = False
    try:
        # Stop writes and file mutations for the short database/file snapshot window.
        # Set this before stopping: even a partially successful stop must be recovered.
        quiesced = True
        run(compose + ['stop', '-t', '30', 'backend'], cwd=app)
        snapshot = Snapshot(env)
        snapshot_id = snapshot.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();')[0]
        manifest = {'format': 1, 'purpose': 'financio-trust-center', 'created_at': stamp,
                    'project_ref': config['project_ref'], 'schemas': list(SCHEMAS),
                    'source_sha': source_sha,
                    'server_version': snapshot.query('SHOW server_version;')[0],
                    'table_counts': table_counts(snapshot.query(COUNTS_SQL)),
                    'security': json.loads(snapshot.query(SECURITY_SQL)[0]),
                    'extensions': json.loads(snapshot.query(EXTENSIONS_SQL)[0] or 'null') or []}
        roles = snapshot.query(ROLES_SQL)
        manifest['roles'] = json.loads(roles[0] or 'null') or []
        manifest['memberships'] = json.loads(roles[1] or 'null') or []
        with tempfile.TemporaryDirectory(prefix='financio-backup-', dir='/dev/shm') as staging:
            dump = Path(staging) / 'database.dump'
            run(dump_arguments(dump, snapshot_id, manifest['extensions']), env=env, timeout=180)
            snapshot.close()
            snapshot = None
            volume = json.loads(run(['docker', 'volume', 'inspect', VOLUME]))[0]
            uploads = Path(volume['Mountpoint'])
            files = {'database.dump': dump}
            for path in regular_files(uploads):
                files['uploads/' + path.relative_to(uploads).as_posix()] = path
            for name, source in config.get('config_files', {}).items():
                if not re.fullmatch(r'[a-zA-Z0-9_.-]+', name):
                    raise BackupError('Invalid configuration archive filename')
                source = Path(source)
                if source.is_symlink() or not source.is_file():
                    raise BackupError('Recovery configuration file is missing or is a symlink')
                files['config/' + name] = source
            manifest['hashes'] = {name: sha256(path) for name, path in files.items()}
            encrypted_archive(files, manifest, target, config['recipient'])
    finally:
        if snapshot:
            snapshot.close()
        if quiesced:
            run(compose + ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '60', 'backend'], cwd=app)
    receipt = {'backup': target.name, 'sha256': sha256(target), 'bytes': target.stat().st_size,
               'created_at': stamp, 'source_sha': manifest['source_sha'],
               'duration_seconds': round(time.monotonic() - started, 2),
               'tables': len(manifest['table_counts']), 'upload_files': sum(name.startswith('uploads/') for name in files),
               'encrypted': True, 'backend_recovered': True}
    target.with_suffix('.age.json').write_text(json.dumps(receipt, indent=2) + '\n')
    # No automatic deletion: off-host copy and restore verification must precede pruning.
    return receipt


def extract_archive(stream, directory):
    """Only regular, bounded recovery files; no links, absolute paths or traversal."""
    total = 0
    names = set()
    with tarfile.open(fileobj=stream, mode='r|') as archive:
        for member in archive:
            parts = PurePosixPath(member.name).parts
            allowed = (member.name in ('manifest.json', 'database.dump') or
                       len(parts) > 1 and parts[0] in ('uploads', 'config'))
            if not allowed or not member.isfile() or member.name.startswith('/') or '..' in parts or '\\' in member.name:
                raise BackupError('Unsafe recovery archive entry')
            if member.name in names or member.size < 0:
                raise BackupError('Duplicate or invalid recovery archive entry')
            names.add(member.name)
            total += member.size
            if total > MAX_ARCHIVE_BYTES or len(names) > MAX_ARCHIVE_FILES:
                raise BackupError('Recovery archive exceeds its limits')
            destination = directory.joinpath(*parts)
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with archive.extractfile(member) as source, destination.open('xb') as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)
    return names


def validate_archive(directory, names):
    manifest = json.loads((directory / 'manifest.json').read_text())
    if manifest.get('format') != 1 or manifest.get('purpose') != 'financio-trust-center':
        raise BackupError('Unsupported recovery archive')
    if set(manifest['hashes']) != names - {'manifest.json'} or 'database.dump' not in names:
        raise BackupError('Recovery file inventory mismatch')
    for name, expected in manifest['hashes'].items():
        if sha256(directory / name) != expected:
            raise BackupError('Recovery checksum mismatch')
    return manifest


def quote_identifier(name):
    return '"' + name.replace('"', '""') + '"'


def role_setup(manifest):
    # Only runs inside the disposable, network-isolated container; no login/passwords.
    sql = ['DROP SCHEMA public;']
    for role in manifest['roles']:
        sql.append(f"CREATE ROLE {quote_identifier(role['name'])} NOLOGIN "
                   + ('INHERIT' if role['inherit'] else 'NOINHERIT') + ' '
                   + ('BYPASSRLS' if role['bypassrls'] else 'NOBYPASSRLS') + ';')
    for parent, member in manifest['memberships']:
        sql.append(f'GRANT {quote_identifier(parent)} TO {quote_identifier(member)};')
    return '\n'.join(sql).encode()


def verify_restore(image):
    if not re.fullmatch(r'postgres:17[\w.-]*@sha256:[0-9a-f]{64}', image):
        raise BackupError('Use a pinned official PostgreSQL 17 image for the isolated drill')
    name = 'financio-restore-drill-' + uuid.uuid4().hex[:12]
    with tempfile.TemporaryDirectory(prefix='financio-restore-', dir='/dev/shm') as staging:
        directory = Path(staging)
        names = extract_archive(sys.stdin.buffer, directory)
        manifest = validate_archive(directory, names)
        if not manifest['server_version'].startswith('17.'):
            raise BackupError('The drill image does not match the database major version')
        try:
            run(['docker', 'run', '--pull=never', '--detach', '--name', name, '--network=none',
                 '--memory=768m', '--cpus=1', '--tmpfs', '/var/lib/postgresql/data:rw,size=512m',
                 '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image,
                 '-c', 'listen_addresses=', '-c', 'shared_preload_libraries=pg_stat_statements'])
            for _ in range(60):
                # The entrypoint runs a temporary init server before PID1 becomes
                # postgres. A successful pg_isready during init is not sufficient.
                probe = subprocess.run(['docker', 'exec', name, 'sh', '-c',
                                        'test "$(cat /proc/1/comm)" = postgres && pg_isready -U postgres'],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
                if probe.returncode == 0:
                    break
                time.sleep(0.5)
            else:
                raise BackupError('Isolated restore database did not become ready')
            psql = ['docker', 'exec', '-i', name, 'psql', '-X', '-qAt', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1']
            run(psql, input=role_setup(manifest))
            with (directory / 'database.dump').open('rb') as source:
                restored = subprocess.run(['docker', 'exec', '-i', name, 'pg_restore', '-U', 'postgres',
                                           '-d', 'postgres', '--exit-on-error', '--single-transaction'],
                                          stdin=source, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                          timeout=180)
            if restored.returncode:
                raise BackupError('Isolated database restore failed')
            counts = table_counts(run(psql, input=COUNTS_SQL.encode()).decode().splitlines())
            security = json.loads(run(psql, input=SECURITY_SQL.encode()))
            if counts != manifest['table_counts'] or security != manifest['security']:
                raise BackupError('Restored row counts or security policies do not match the backup')
            # Active/draft files must restore. Archiving deliberately removes the
            # bytes while retaining metadata, so archived references may be absent.
            paths = run(psql, input=b"SELECT file_url FROM public.documents WHERE status <> 'archived';").decode().splitlines()
            for path in paths:
                parts = PurePosixPath(path).parts
                if path.startswith('/') or '..' in parts or 'uploads/' + path not in names:
                    raise BackupError('A restored document references a missing upload')
            return {'restored': True, 'tables': len(counts), 'rows': sum(counts.values()),
                    'upload_files': sum(path.startswith('uploads/') for path in names),
                    'file_checksums_match': True, 'rls_policies_and_rpc_grants_match': True,
                    'source_sha': manifest['source_sha'], 'production_database_changed': False,
                    'auth_service_configuration_restored': False}
        finally:
            run(['docker', 'rm', '--force', name])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='operation', required=True)
    backup = sub.add_parser('create')
    backup.add_argument('--config', default='/etc/financio-trust-center/backup.json')
    verify = sub.add_parser('verify', help='Receive a decrypted tar on stdin; restore only into a disposable container')
    verify.add_argument('--image', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(BackupError('Operation interrupted')))
    try:
        with open('/run/lock/financio-trust-center-backup.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = create_backup(args.config) if args.operation == 'create' else verify_restore(args.image)
        print(json.dumps(result))
    except BackupError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired, tarfile.TarError):
        # Provider/database diagnostics can contain secrets or user records.
        print('Trust Center backup/restore operation failed; review protected configuration and service health.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
