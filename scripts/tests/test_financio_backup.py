import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('financio_backup', Path(__file__).parents[1] / 'financio-backup.py')
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


def archive(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w') as tar:
        for name, data, kind in entries:
            info = tarfile.TarInfo(name)
            info.type = kind
            info.size = len(data) if kind == tarfile.REGTYPE else 0
            if kind == tarfile.SYMTYPE:
                info.linkname = '/etc/passwd'
            tar.addfile(info, io.BytesIO(data) if kind == tarfile.REGTYPE else None)
    output.seek(0)
    return output


class BackupRecoveryTests(unittest.TestCase):
    def test_dump_includes_native_extension_dependencies_explicitly(self):
        args = backup.dump_arguments(Path('/dev/shm/database.dump'), 'snapshot-id',
                                     [{'name': 'uuid-ossp'}, {'name': 'pgcrypto'}])
        self.assertIn('--schema=auth', args)
        self.assertIn('--snapshot', args)
        self.assertIn('--extension=uuid-ossp', args)
        self.assertIn('--extension=pgcrypto', args)

    def test_archive_rejects_paths_and_links_before_writing(self):
        for name, kind in [('../database.dump', tarfile.REGTYPE),
                           ('/uploads/private.pdf', tarfile.REGTYPE),
                           ('uploads/../../outside', tarfile.REGTYPE),
                           ('uploads/link', tarfile.SYMTYPE),
                           ('config\\outside', tarfile.REGTYPE),
                           ('unlisted.txt', tarfile.REGTYPE)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as root:
                with self.assertRaises(backup.BackupError):
                    backup.extract_archive(archive([(name, b'sensitive', kind)]), Path(root))
                self.assertEqual(list(Path(root).rglob('*')), [])

    def test_archive_rejects_duplicate_files(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(backup.BackupError):
                backup.extract_archive(archive([('database.dump', b'first', tarfile.REGTYPE),
                                                ('database.dump', b'second', tarfile.REGTYPE)]), Path(root))

    def test_archive_size_limit_is_enforced(self):
        with tempfile.TemporaryDirectory() as root, patch.object(backup, 'MAX_ARCHIVE_BYTES', 2):
            with self.assertRaises(backup.BackupError):
                backup.extract_archive(archive([('database.dump', b'123', tarfile.REGTYPE)]), Path(root))

    def test_checksums_detect_tampering_and_unlisted_files(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            (directory / 'database.dump').write_bytes(b'private auth and application data')
            manifest = {'format': 1, 'purpose': 'financio-trust-center',
                        'hashes': {'database.dump': backup.sha256(directory / 'database.dump')}}
            (directory / 'manifest.json').write_text(json.dumps(manifest))
            names = {'manifest.json', 'database.dump'}
            self.assertEqual(backup.validate_archive(directory, names), manifest)
            with self.assertRaises(backup.BackupError):
                backup.validate_archive(directory, names | {'config/extra'})
            (directory / 'database.dump').write_bytes(b'tampered')
            with self.assertRaises(backup.BackupError):
                backup.validate_archive(directory, names)

    def test_secret_file_requires_private_permissions_and_no_symlink(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'config'
            path.write_text('{}')
            path.chmod(0o600)
            self.assertEqual(backup.protected_file(path), path)
            path.chmod(0o644)
            with self.assertRaises(backup.BackupError):
                backup.protected_file(path)
            path.chmod(0o600)
            link = Path(root) / 'link'
            link.symlink_to(path)
            with self.assertRaises(backup.BackupError):
                backup.protected_file(link)

    def test_restore_roles_have_no_login_and_quote_identifiers(self):
        sql = backup.role_setup({'roles': [{'name': 'role"name', 'inherit': False, 'bypassrls': True}],
                                 'memberships': []}).decode()
        self.assertIn('"role""name" NOLOGIN NOINHERIT BYPASSRLS', sql)
        self.assertNotIn('PASSWORD', sql)

    def test_verifier_rejects_unpinned_or_arbitrary_images_before_reading_input(self):
        for image in ['postgres:17', 'attacker/postgres:17@sha256:' + 'a' * 64,
                      'postgres:16@sha256:' + 'a' * 64]:
            with self.assertRaises(backup.BackupError):
                backup.verify_restore(image)

    def test_tls_and_project_guard_and_inherited_credentials(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            app = root / 'financio-trust-center'
            app.mkdir()
            (app / 'docker-compose.financio.yml').touch()
            password = root / 'pgpass'
            password.touch(mode=0o600)
            cert = root / 'ca.crt'
            cert.touch()
            config = {'purpose': 'financio-trust-center', 'project_ref': 'a' * 20,
                      'recipient': 'age1' + 'a' * 58, 'app_dir': str(app),
                      'postgres': {'host': 'pooler.example.test', 'port': 5432, 'database': 'postgres',
                                   'user': 'postgres.' + 'a' * 20, 'passfile': str(password), 'rootcert': str(cert)}}
            path = root / 'backup.json'
            path.write_text(json.dumps(config))
            path.chmod(0o600)
            with patch.dict(os.environ, {'PGPASSWORD': 'inherited-task-secret', 'PGSSLMODE': 'disable',
                                         'PGSERVICE': 'wrong-project'}):
                _, _, env = backup.read_config(path)
            self.assertEqual(env['PGSSLMODE'], 'verify-full')
            self.assertNotIn('PGPASSWORD', env)
            self.assertNotIn('PGSERVICE', env)
            config['postgres']['user'] = 'postgres.other-project'
            path.write_text(json.dumps(config))
            with self.assertRaises(backup.BackupError):
                backup.read_config(path)

    def test_failed_quiesce_still_recovers_backend_without_making_a_backup(self):
        with tempfile.TemporaryDirectory() as root:
            config = {'backup_dir': root}
            calls = []

            def operation(args, **kwargs):
                calls.append(args)
                if args[-3:] == ['ps', '-q', 'backend']:
                    return b'task-backend\n'
                if args[:2] == ['docker', 'inspect']:
                    return b'true\n'
                if 'stop' in args:
                    raise backup.BackupError('stop failed')
                return b''

            with patch.object(backup, 'read_config', return_value=(config, Path(root), {})), \
                    patch.object(backup, 'run', side_effect=operation):
                with self.assertRaises(backup.BackupError):
                    backup.create_backup('unused')
            self.assertTrue(any('up' in args and '--wait' in args for args in calls))
            self.assertEqual(list(Path(root).iterdir()), [])


if __name__ == '__main__':
    unittest.main()
