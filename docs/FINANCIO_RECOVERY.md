# Financio backup and recovery

The dedicated deployment uses hosted Supabase PostgreSQL 17 and local files in
`financio-trust-center_trust-center-uploads`. The upstream `db-backup.sh` and
`db-restore-verify.sh` target a development database container and do **not** back
up this deployment.

## What the encrypted backup contains

`scripts/financio-backup.py create` uses the dedicated project credential with
TLS hostname/certificate verification. It briefly stops only the Trust Center
backend while taking a consistent database/file snapshot, then starts it again
and waits for health. Frontend, ERP and CI services are not operated by this script.
Schedule this short API maintenance window outside normal use.

The archive contains:

- A PostgreSQL custom-format dump of `public`, native `auth` and `extensions`,
  using one exported read-only snapshot, explicitly including UUID/crypto/statistics
  extension definitions. Ownership, RLS, policies and grants remain
  in the dump. A manifest records row counts and sensitive RPC permissions.
- Every regular file in the dedicated upload volume, with SHA-256 checksums.
- Explicitly configured recovery files, including the application environment,
  database backup credential, Supabase CA, tunnel credential and service config.
  These contain secrets and must remain encrypted outside temporary private staging.

`age` encrypts the tar stream for a public recipient. Only the public recipient
is stored on the VM. The **private identity remains on the operator's iMac** in
the dedicated protected secrets directory. Decrypted dump staging is private
and temporary in `/dev/shm`; no decrypted archive is stored on disk by the backup.
Treat the encrypted archive as sensitive, too.

The protected `/etc/financio-trust-center/backup.json` supplies the project
identity, PG connection fields, public recipient and explicitly named files.
The password is in its own mode0600 `.pgpass`; it is never an argument, log, or
source-controlled value. Inherited PG task credentials are discarded. The helper
refuses an ERP checkout, a mismatched project user, public configuration files,
special upload files, and concurrent backup/drill runs.

```sh
sudo python3 scripts/financio-backup.py create
```

Completed ciphertext and safe receipts live in
`/var/backups/financio-trust-center`, mode0700. A daily systemd timer runs at
04:00 UTC. Receipts prove completion and backend health; they do not establish
an off-host copy or a successful restore. No automatic pruning is configured:
delete only these task-owned old backups after verifying retained off-host copies.

## Off-host copy and identity custody

`scripts/financio-backup-pull.py --config <protected-operator-config>` copies the
latest completed **encrypted** backup through normal SSH and verifies the
ciphertext size/checksum before atomically storing it. Its configuration contains
the authorized SSH argv (key paths, strict known-host checking and proxy jump)
and a separate private backup directory; it does not contain private key values.
The iMac runs this hourly through a user LaunchAgent, and also when loaded.

The iMac must be awake, connected, and logged in for that user agent to run. Check
`latest.json` in its protected backups directory after an outage. A VM copy alone
does not protect against losing the VM. The iMac copy separates hosts but remains
in the same physical location; an additional encrypted copy in a separate location
is still needed for protection against loss of the site.

Keep a second protected copy of `secrets/backup-age-identity` somewhere independently
recoverable. Losing the identity makes its encrypted archives unrecoverable.
Do not paste it into chat, environment files, source control or command arguments.
An identity rotation needs backups encrypted to the new recipient and a successful
drill before retiring the old identity.

## Isolated restore drill

Use the pinned official PostgreSQL 17 image recorded in the deployment runbook.
Decrypt on the iMac and stream the plaintext archive over SSH stdin to:

```sh
sudo python3 scripts/financio-backup.py verify \
  --image postgres:17-bookworm@sha256:<recorded-image-digest>
```

The `verify` command takes **only a decrypted tar on stdin**, not a production
connection. It rejects links, path traversal, duplicate/unlisted files, oversized
archives and mismatched hashes. It creates a randomly named, temporary container
with `--network=none`, Unix sockets only, and tmpfs database storage. It recreates
non-login roles for the drill, restores ownership/grants, compares all table row
counts, RLS policies and protected RPC permissions, and checks every document's
local upload reference. It then removes the container and temporary plaintext.
There is no command in this helper to restore into production.

The drill demonstrates logical database/file recovery. It does **not** provision
the Supabase Auth service, configure SMTP/OAuth/redirects, recreate Cloudflare DNS
or a tunnel, or exercise an approved-document email/magic-link flow. Those require
a separate recovery environment and operator verification. With zero documents,
the upload check cannot demonstrate real document delivery.

## Recovery after losing VM or project

1. Preserve the original encrypted archive and checksum. Decrypt only into a
   protected recovery environment and repeat the isolated drill first.
2. Recreate a dedicated VM and check out the recorded source SHA. Recover the
   application/tunnel configuration through protected files and the original
   upload volume ownership (`uid1000`). Do not copy the ERP's environment.
3. If Supabase still exists, reconnect to that project with its current keys and
   restore only missing VM files. Do not overwrite a healthy project.
4. If the project was lost, provision native Supabase first and use its supported
   restore process for application data and Auth users/identities. The logical dump
   preserves provider-owned schema data but is not a complete provider project
   backup. Check the native schema version and roles before importing; do not run
   the fresh initializer over restored tables.
5. Restore Auth URL/redirect settings, disabled public signup, SMTP and the first
   admin. Rotate lost/exposed credentials, then rebuild frontend public URL/anon
   configuration. Provider settings are documented separately from the SQL dump.
6. Verify public/private API separation, admin login and review history. Test
   actual public/restricted document downloads and expired/revoked links with
   explicit operator-approved test recipients before returning to normal use.

Check failures with `systemctl status financio-trust-center-backup.service` and
`journalctl -u financio-trust-center-backup.service`. Logs contain step failures and
safe receipts, never raw pg_dump output or provider SQL errors. If interrupted,
verify backend health before doing anything else.
