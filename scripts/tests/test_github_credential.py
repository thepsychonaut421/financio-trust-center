import importlib.util
import io
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('credential_setup', Path(__file__).resolve().parents[1] / 'configure-github-credential.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)
TOKEN = 'github_pat_' + 'test_only_' * 4
SHA = 'a' * 40


class CredentialSetupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        subprocess.run(['git', 'init', '--quiet', str(self.root)], check=True)
        (self.root / '.gitignore').write_text('.env.*\n')
        self.destination = self.root / '.env.financio.local'

    def tearDown(self):
        self.temporary.cleanup()

    def test_only_reads_exact_source_and_sha_without_requiring_green_ci(self):
        calls = []
        def getter(token, endpoint):
            calls.append((token, endpoint))
            return {'sha': SHA} if endpoint.endswith('/main') else {'sha': SHA, 'statuses': [{'state': 'failure'}]}
        self.assertEqual(setup.verify_access(TOKEN, 'owner/repo', getter), SHA)
        self.assertEqual([call[1] for call in calls], ['repos/owner/repo/commits/main', 'repos/owner/repo/commits/' + SHA + '/status'])

    def test_invalid_status_or_repository_never_passes_verification(self):
        with self.assertRaises(setup.ConfigurationError):
            setup.verify_access(TOKEN, '../wrong/repo', lambda *args: {})
        with self.assertRaises(setup.ConfigurationError):
            setup.verify_access(TOKEN, 'owner/repo', lambda token, endpoint: {'sha': SHA} if endpoint.endswith('/main') else {'sha': 'b' * 40, 'statuses': []})

    def test_atomic_private_file_preserves_other_credentials_and_replaces_duplicates(self):
        self.destination.write_text('SUPABASE_SERVICE_KEY=other-test-secret\nOPENAI_API_KEY=untouched-test-key\nTRUST_CENTER_GITHUB_TOKEN=old\nexport TRUST_CENTER_GITHUB_TOKEN=duplicate\n')
        setup.store_credentials(self.root, self.destination, TOKEN, 'owner/repo')
        stored = self.destination.read_text()
        self.assertIn('SUPABASE_SERVICE_KEY=other-test-secret', stored)
        self.assertIn('OPENAI_API_KEY=untouched-test-key', stored)
        self.assertEqual(stored.count('TRUST_CENTER_GITHUB_TOKEN='), 1)
        self.assertEqual(self.destination.stat().st_mode & 0o777, 0o600)
        self.assertFalse(list(self.root.glob('.github-credential-*')))

    def test_refuses_symlink_tracked_file_and_erp_destination(self):
        target = self.root / 'source.txt'
        target.write_text('unchanged')
        self.destination.symlink_to(target)
        with self.assertRaises(setup.ConfigurationError):
            setup.store_credentials(self.root, self.destination, TOKEN, 'owner/repo')
        self.destination.unlink()
        self.destination.write_text('unchanged')
        subprocess.run(['git', '-C', str(self.root), 'add', '--force', str(self.destination)], check=True)
        with self.assertRaises(setup.ConfigurationError):
            setup.store_credentials(self.root, self.destination, TOKEN, 'owner/repo')
        with self.assertRaises(setup.ConfigurationError):
            setup.store_credentials(self.root, self.root.parent / '.env.erp', TOKEN, 'owner/repo')
        self.assertEqual(target.read_text(), 'unchanged')

    def test_failed_verification_does_not_store_or_log_token(self):
        self.destination.write_text('SUPABASE_SERVICE_KEY=unchanged\n')
        output, error = io.StringIO(), io.StringIO()
        with patch.object(setup, 'ROOT', self.root), patch.object(setup, 'read_token', return_value=TOKEN), \
             patch.object(setup, 'verify_access', side_effect=setup.ConfigurationError('GitHub denied access.')), \
             patch('sys.argv', ['setup']), patch('sys.stdout', output), patch('sys.stderr', error):
            self.assertEqual(setup.main(), 1)
        self.assertNotIn(TOKEN, output.getvalue() + error.getvalue())
        self.assertEqual(self.destination.read_text(), 'SUPABASE_SERVICE_KEY=unchanged\n')

    def test_refuses_task_token_and_redirects(self):
        with patch('sys.stdin', io.StringIO('ghs_task_credential')):
            with self.assertRaises(setup.ConfigurationError):
                setup.read_token()
        with self.assertRaises(setup.ConfigurationError):
            setup.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://outside.example')

    def test_mistaken_token_argument_is_not_echoed(self):
        error = io.StringIO()
        with patch('sys.argv', ['setup', '--token', TOKEN]), patch('sys.stderr', error):
            with self.assertRaises(SystemExit):
                setup.main()
        self.assertNotIn(TOKEN, error.getvalue())

    def test_named_secret_binding_does_not_fall_back_to_task_credentials(self):
        with patch.dict(os.environ, {'TRUST_CENTER_GITHUB_TOKEN': TOKEN, 'GH_TOKEN': 'ghs_task'}, clear=True):
            self.assertEqual(setup.read_token(from_env=True), TOKEN)
        with patch.dict(os.environ, {'GH_TOKEN': 'ghs_task'}, clear=True):
            with self.assertRaises(setup.ConfigurationError):
                setup.read_token(from_env=True)

    def test_unavailable_hidden_prompt_fails_without_reading_echoed_input(self):
        with patch('sys.stdin.isatty', return_value=True), \
             patch.object(setup.getpass, 'getpass', side_effect=setup.getpass.GetPassWarning('No hidden terminal')):
            with self.assertRaises(setup.ConfigurationError):
                setup.read_token()


if __name__ == '__main__':
    unittest.main()
