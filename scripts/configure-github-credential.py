#!/usr/bin/env python3
"""Verify a dedicated GitHub PAT and store it in this checkout's ignored env file.

No token arguments, task-token export, raw API responses, or credential logging.
"""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import warnings

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_REPOSITORY = 'thepsychonaut421/Financio-Flow-ERP'


class ConfigurationError(Exception):
    pass


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        # argparse normally echoes unknown arguments, possibly a pasted secret.
        self.exit(2, 'Invalid setup arguments. Use --token-file or hidden stdin input; never pass a token argument.\n')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ConfigurationError('GitHub redirected the request; credential not stored.')


def read_token(token_file=None, from_env=False):
    if from_env:
        token = os.environ.get('TRUST_CENTER_GITHUB_TOKEN', '').strip()
    elif token_file:
        with Path(token_file).open('r', encoding='ascii') as source:
            token = source.read(4097).strip()
    elif sys.stdin.isatty():
        with warnings.catch_warnings():
            warnings.simplefilter('error', getpass.GetPassWarning)
            try:
                token = getpass.getpass('Dedicated fine-grained GitHub token (hidden): ').strip()
            except getpass.GetPassWarning:
                raise ConfigurationError('Hidden input is unavailable. Use a protected secret file or dedicated environment binding.') from None
    else:
        token = sys.stdin.read(4097).strip()
    if not re.fullmatch(r'github_pat_[A-Za-z0-9_]{20,4000}', token):
        raise ConfigurationError('Provide a dedicated fine-grained PAT; task credentials and classic tokens are not accepted.')
    return token


def github_get(token, endpoint):
    request = urllib.request.Request('https://api.github.com/' + endpoint, headers={
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Financio-Trust-Center-Setup',
    })
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=15) as response:
            body = response.read(1000001)
        if len(body) > 1000000:
            raise ConfigurationError('GitHub response exceeds the setup limit; credential not stored.')
        return json.loads(body)
    except urllib.error.HTTPError as error:
        if error.code in (401, 403, 404):
            raise ConfigurationError('GitHub denied access. Check the selected repository, Contents: read and Commit statuses: read.') from None
        raise ConfigurationError('GitHub verification failed; credential not stored.') from None
    except (urllib.error.URLError, TimeoutError, ValueError):
        raise ConfigurationError('GitHub verification unavailable; credential not stored.') from None


def verify_access(token, repository, getter=github_get):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ConfigurationError('Invalid source repository.')
    prefix = 'repos/' + repository + '/'
    commit = getter(token, prefix + 'commits/main')
    sha = commit.get('sha') if isinstance(commit, dict) else None
    if not isinstance(sha, str) or not re.fullmatch(r'[a-f0-9]{40}', sha):
        raise ConfigurationError('Cannot verify the main SHA; credential not stored.')
    status = getter(token, prefix + 'commits/' + sha + '/status')
    if not isinstance(status, dict) or status.get('sha') != sha or not isinstance(status.get('statuses'), list):
        raise ConfigurationError('Cannot verify commit status access; credential not stored.')
    # A pending/missing/failing release gate still demonstrates read access.
    # Setup never publishes, modifies the repository or treats CI as deployment.
    return sha


def store_credentials(root, destination, token, repository):
    root = root.resolve()
    destination = Path(destination)
    destination = destination if destination.is_absolute() else root / destination
    try:
        relative = destination.absolute().relative_to(root)
    except ValueError:
        raise ConfigurationError('Credential destination must be inside the dedicated Trust Center checkout.') from None
    if destination.is_symlink() or destination.parent.resolve() != root:
        raise ConfigurationError('Use a regular env file in the Trust Center checkout root; symlinks are refused.')
    if not destination.name.startswith('.env') or destination.name.endswith('.example'):
        raise ConfigurationError('Use an ignored .env file, not a source/example file.')
    tracked = subprocess.run(['git', '-C', str(root), 'ls-files', '--error-unmatch', '--', str(relative)], capture_output=True)
    ignored = subprocess.run(['git', '-C', str(root), 'check-ignore', '--quiet', '--', str(relative)], capture_output=True)
    if tracked.returncode == 0 or ignored.returncode != 0:
        raise ConfigurationError('Credential destination must be ignored and untracked by Git.')
    if destination.exists() and not stat.S_ISREG(destination.stat().st_mode):
        raise ConfigurationError('Credential destination must be a regular file.')
    template = root / '.env.financio.example'
    existing = destination.read_text() if destination.exists() else template.read_text() if template.exists() else ''
    retained = ''.join(line for line in existing.splitlines(keepends=True)
                       if not re.match(r'^\s*(?:export\s+)?TRUST_CENTER_(?:GITHUB_TOKEN|SOURCE_REPOSITORY)\s*=', line))
    content = retained.rstrip('\n') + '\nTRUST_CENTER_SOURCE_REPOSITORY=' + repository + '\nTRUST_CENTER_GITHUB_TOKEN=' + token + '\n'
    descriptor, temporary = tempfile.mkstemp(prefix='.github-credential-', dir=root)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, 'w') as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = SafeArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--repository', default=DEFAULT_REPOSITORY)
    parser.add_argument('--env-file', default='.env.financio.local')
    source = parser.add_mutually_exclusive_group()
    source.add_argument('--token-file', help='Explicit secret-manager file binding; never pass the token itself.')
    source.add_argument('--from-env', action='store_true', help='Use the dedicated TRUST_CENTER_GITHUB_TOKEN secret binding.')
    arguments = parser.parse_args()
    try:
        token = read_token(arguments.token_file, arguments.from_env)
        sha = verify_access(token, arguments.repository)
        store_credentials(ROOT, arguments.env_file, token, arguments.repository)
        print('Verified GitHub read access for ' + arguments.repository + ' at ' + sha + '.')
        print('Saved the dedicated credential to the ignored env file with mode 0600.')
        print('Only read access was tested. Confirm read-only permissions and expiration in GitHub token settings.')
        return 0
    except ConfigurationError as error:
        print(str(error), file=sys.stderr)
    except (OSError, UnicodeError):
        print('Cannot read the explicit secret binding or update the env file; credential setup failed.', file=sys.stderr)
    except Exception:
        print('Credential setup failed; no diagnostic containing credential data is displayed.', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
