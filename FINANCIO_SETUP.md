# Financio Flow Trust Center

This adaptation uses the original `kutcode/trust-center` portal at upstream commit
`06cb59d899f24bcd2a4bba20b20b3de3ba273e80`. The MIT license and original copyright
notice remain in `LICENSE`. It is a separate service, not an ERP module.

## What this implementation adds

- Financio branding defaults and neutral public wording. Migration `036` changes
  only the untouched upstream placeholder row; custom branding remains intact.
  It does not seed certifications, findings, reports, or compliance claims.
- An admin changelog workflow based on GitHub evidence, with editable drafts,
  explicit human publish/reject decisions, revisions, and atomic decision history.
- The original public/restricted document, access request, organization approval,
  and magic-link flows remain in the upstream application.
- Salesforce routes and the configuration page are disabled in this adaptation.
- A separate Compose deployment template and persistent document volume.
- Privileged user-management RPCs are limited to the backend service role in
  migration `037`; ordinary/anonymous browser roles cannot execute them.
- Public branding is projected through the API; migration `037` restricts direct
  settings-table reads to administrators so notification recipients stay private.
- Browser roles can read public update copy but not its private draft linkage;
  the API exposes a safe content-format marker to preserve approved plain text.

OpenAI key provisioning was skipped at the user's request. Draft preparation uses
the local evidence-based generator and does not call OpenAI. If an AI provider is
added later, it must use a dedicated Trust Center backend credential. The ERP's
integrated-AI key must not be reused or modified. Never expose a secret through a
`NEXT_PUBLIC_*` variable.

## Prepare, review, then publish

1. Open **Admin → Changelog Review** and select the release evidence to collect.
   The current collector requires a dedicated read-only GitHub credential.
   It reads the current `main` commit and its matching release-gate status.
   Commit subjects remain private review context; broad changed-file areas help
   prepare public wording without copying internal paths or commit messages.
2. Generate a draft from the collected evidence. Observing a commit on `main`
   and a successful CI status supports statements about that source version.
   The collector does not independently establish merged PR metadata or prove that
   version is deployed or that a Security Cloud finding is closed.
3. Review the proposed public text and its evidence. Remove sensitive technical
   details, internal identifiers, and private links from public copy. Edit the
   draft if necessary; edits create a new revision.
4. Make an explicit publish or reject decision on the current revision. No
   scheduler, webhook, CI status, or generator is authorized to publish it.
5. Published text is immutable through this workflow. Prepare a new draft for a
   correction, and retain the original review history.

The admin API lives under `/api/changelog` and requires an authenticated admin:

| Operation | Endpoint |
| --- | --- |
| Configuration/available evidence sources | `GET /api/changelog/config` |
| List entries | `GET /api/changelog` |
| Prepare evidence-backed draft | `POST /api/changelog/generate` with `{}` or an optional full lowercase `sha` equal to the current `main` head |
| Edit a draft | `PATCH /api/changelog/:id` with `revision`, `title`, `content` |
| Decide on a draft | `POST /api/changelog/:id/review` with `revision`, `decision` (`publish` or `reject`), `note`, and `confirm: true` |
| View revisions and decisions | `GET /api/changelog/:id/history` |

States are `draft`, `rejected`, and `published`. Only drafts can be edited or
reviewed. A stale revision cannot be approved. Database mutations and history are
atomic, and workflow tables/RPCs are restricted to the server's service role.

There is no live Woodpecker log collector, production deployment attestation, or
Security Cloud rescan/closure automation in this checkout. GitHub commit statuses
can surface a Woodpecker result when Woodpecker reports it to GitHub. Missing
evidence stays missing; the portal must not infer production acceptance or finding
closure. Importing evidence is an admin action in this first version.

## Dedicated server configuration

Provision a dedicated Supabase project/database and its auth users for the Trust
Center. Use separate service/public keys, backups, upload storage, domains, and
operator access from Financio Flow ERP. Do not point this service at the ERP's
database or reuse its `.env` file.

On the Trust Center server:

```sh
cp .env.financio.example .env.financio.local
chmod 600 .env.financio.local
```

Fill the ignored local file using the server's secret manager or protected editor.
Do not paste credentials into chat, source control, build arguments, or CI logs.
The Compose file maps backend variables explicitly and does not pass backend
credentials to the frontend. `.dockerignore` files exclude secret files from both
build contexts. Only the public Supabase anon key may be passed to the frontend.

Required configuration:

- `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
  `SUPABASE_SERVICE_KEY`: the dedicated Trust Center Supabase project.
- `TRUST_CENTER_PUBLIC_URL`: `https://trust.financioflow.com` after the operator
  configures DNS and TLS. This is a proposed domain, not a deployment claim.
- `TRUST_CENTER_PUBLIC_API_URL`: browser-facing API origin, normally the same URL.
  Compose also maps it to backend `BACKEND_PUBLIC_URL`, so approved-document
  email downloads use the public HTTPS origin instead of a container/localhost URL.
- `EMAIL_PROVIDER` plus its dedicated provider credential and verified
  `SMTP_FROM`: real delivery must be tested before using restricted document links.
- `TRUST_CENTER_SOURCE_REPOSITORY`: defaults to
  `thepsychonaut421/Financio-Flow-ERP`.
- `TRUST_CENTER_GITHUB_TOKEN`: backend-only credential scoped to the one private
  source repository, with contents and commit statuses read access. It is required
  to collect evidence; the portal/document features remain usable without it.
  No administration, write, or organization-wide permission.

### Configure the dedicated GitHub credential

The Codex GitHub connection is for this task. Its credential is not exported or
reused on the server. GitHub does not offer an API for this integration to issue
a permanent personal access token on the user's behalf.

[Create a prefilled fine-grained token](https://github.com/settings/personal-access-tokens/new?name=Financio%20Trust%20Center%20-%20evidence&description=Read-only%20release%20evidence&target_name=thepsychonaut421&expires_in=30&contents=read&statuses=read).
Select **Only select repositories → Financio-Flow-ERP**, confirm **Contents:
read-only** and **Commit statuses: read-only**, and retain the 30-day expiration.
Metadata read access is automatic. Store the token in the dedicated server secret
manager; do not paste it into chat or a shell command.

On the dedicated Trust Center VM, from this checkout, run:

```sh
# A protected file explicitly supplied by the server secret manager.
python3 scripts/configure-github-credential.py --token-file /run/secrets/trust-center-github-token
```

Alternatively omit `--token-file` and enter the credential at the hidden terminal
prompt. A dedicated `TRUST_CENTER_GITHUB_TOKEN` environment secret binding is also
supported with `--from-env`; the helper never falls back to `GH_TOKEN` or the
Codex task connection. The helper first verifies `main` and that SHA's combined commit status
through read-only GitHub requests. On success it atomically updates only the
two Trust Center GitHub fields in ignored `.env.financio.local`, mode0600,
preserving other settings. It refuses tracked files, symlinks, destinations in
the ERP checkout, task credentials and classic tokens. Validation failures leave
the env file unchanged. The helper confirms read access, not that an incorrectly
configured token has no additional write permissions; inspect those in GitHub.

After the VM has its other required settings and an installed backend image,
reload only the backend so the credential becomes effective:

```sh
docker compose --env-file .env.financio.local -f docker-compose.financio.yml up -d --no-deps backend
```

Rotate with the same helper before expiration, validate collection, then revoke
the previous token through GitHub settings. This read-only token is for evidence
collection; it does not grant the Codex integration permission to create forks.
If that integration continues to return403, create the dedicated
`financio-trust-center` fork through [GitHub's fork page](https://github.com/kutcode/trust-center/fork).
The existing app installation selects all repositories, so the new fork should
become available to it; verify access before pushing the reviewed branch.

### Host placement

Use a dedicated Proxmox VM named `financio-trust-center`, with its own operator
account, Docker installation, backups and secret bindings. A starting allocation
is 2 vCPU, 4GiB RAM and 32GiB storage, adjusted for document volume. Choose an
available VM ID during provisioning. Keep the existing CI guest separate; verify
its current VM/container ID in Proxmox rather than relying on an older runbook.
The selected VM/node/access path must be established before any remote changes;
this repository does not assert that the VM has been provisioned.

For a **fresh native Supabase project**, use the reviewed initializer instead of
running every upstream SQL file:

```sh
# Bind PGHOST, PGPORT, PGDATABASE, PGUSER, and the dedicated migration credential
# through the server secret manager / protected PG* environment or .pgpass.
# Configure PGSSLROOTCERT for certificate verification if the client needs it.
TRUST_CENTER_DATABASE_PURPOSE=financio-trust-center bash scripts/init-financio-database.sh
```

The script uses `psql`, one transaction, `ON_ERROR_STOP`, and a lock. It refuses
projects with existing application tables/views and expects native Supabase auth,
storage, and roles. It defaults to TLS certificate verification and takes no
secret connection URL as an argument. It skips `000_auth_schema.sql`, which is a
development bootstrap that replaces Supabase auth helper functions, and
`018_seed_plaid_categories.sql`, which contains unverified sample SOC 2, ISO,
AWS certification, and other public assertions. Those upstream reference files
remain preserved in the repository; they are not Financio evidence.

Hosted Supabase owns `storage.buckets` and already enables its row-level security.
Migration `032` preserves that setting without repeating an owner-only `ALTER`.
For a local installation with RLS disabled it still enables RLS, and a role that
cannot enable the required protection causes initialization to roll back.

Use the project's **Database Settings → SSL configuration → Download certificate**
link to obtain the provider CA and bind its protected local path as
`PGSSLROOTCERT`. Keep `PGSSLMODE=verify-full`; do not disable certificate or hostname
verification to work around a connection error. IPv4-only servers can use the
project's **Connect → Direct → Session pooler** endpoint on port5432, with the
displayed `postgres.<project-ref>` user. Copy the complete hostname from that
dialog and keep the password in a protected binding, never in a connection URL
argument.

For an existing upstream installation, back up first and apply only unapplied
migrations, including `035`, `036`, and `037`, after reviewing any existing public claims.
The adaptation does not delete or rewrite existing operator controls. The
standalone Compose file does not apply migrations or provision Supabase. Do not
run the development SQL initialization against an existing live database.

Create the first administrator through the dedicated Supabase Auth administration
interface, then insert the matching user ID/email into `admin_users` as described
in the upstream README. Admin signup and the test-email endpoint remain disabled.

The production template is **standalone**, not an overlay on the development
stack. It uses its own Compose project, no fixed container names, loopback ports
3101/4101 by default, and its own project-scoped upload volume:

```sh
docker compose --env-file .env.financio.local -f docker-compose.financio.yml config --quiet
docker compose --env-file .env.financio.local -f docker-compose.financio.yml up -d --build
```

The first command validates configuration; the second changes the server and is
an operator deployment step. Neither command proves production readiness. Do not
print the rendered Compose configuration because it contains interpolated secrets.
Configured public frontend URLs are baked into the Next.js build: rebuild when
those URLs or the public anon key change.

Configure a TLS reverse proxy on the same host to forward `/api/*` to
`127.0.0.1:4101` and other paths to `127.0.0.1:3101`. Preserve the `/api` path prefix.
Forward uploads through API routes, never directly from `/app/uploads`. Keep the
Supabase service-role key and raw upload directory inaccessible to browsers.

## Documents, backup, and operating checks

The implemented document uploader stores **local files in `UPLOADS_DIR`**. The
presence of Supabase Storage services in the upstream development stack does not
move those documents to Supabase Storage. The production template persists
`/app/uploads` in the dedicated `trust-center-uploads` named volume.

Before release and periodically afterward:

1. Back up the dedicated Supabase database/auth project and the upload volume in a
   consistent maintenance window. Encrypt backups and restrict backup access.
2. Restore both into an isolated instance and verify a public document and an
   approved restricted document. Restoring only metadata or only files is
   insufficient.
3. Verify anonymous visitors cannot fetch restricted files, unapproved requests,
   draft changelog entries, internal evidence, or administrator settings.
4. Verify expired/revoked links and the chosen organization-domain approval policy.
   The upstream application reuses organization approvals by email domain;
   evaluate that behavior before uploading confidential customer documents.
5. Replace the sample NDA with approved wording and review access expiration,
   notification recipients, contact details, and public policy links.
6. Monitor API health, delivery failures, document storage, and backups. The
   `/health` probe only establishes that the backend responds; it is not a full
   database, authorization, or mail-delivery check.

## Validation and limits

Development checks should run in the adapted repository:

```sh
cd backend
npm ci
npm run build
npm test
```

Run frontend `npm run typecheck`, build, and `npm run test:changelog-ui` with
configured public Supabase values and the intended API URL for the build.
The UI test uses mocked connections and requires no credentials.
The upstream Next.js build skips typechecking, so CI runs it separately.
Tests must verify access control, revision conflicts, and
publish history in addition to ordinary build checks. The Trust Center repository
has its own upstream GitHub Actions workflows; it does not inherit the ERP's
Woodpecker release gate or its results.

The PGlite database tests execute PostgreSQL migration behavior in memory; Jest
uses the Node VM-modules flag included in the npm test scripts for PGlite's dynamic imports. They do
not substitute for applying migrations and testing permissions on the actual
dedicated Supabase project.

This file describes implementation and deployment prerequisites. It does not
assert that a remote fork/PR exists, that CI has run remotely, that Supabase
migrations have been applied remotely, or that the service has been deployed.
The implementation handoff must report checks actually executed and any remaining
access/runtime blockers separately.
