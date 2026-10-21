# Coolify migration of the existing Financio portal

Base source: the user's existing fork branch `codex/financio-assisted-trust-center`, exact commit `9a73bc6fcf5466062736b68b49beab76384e6998`, matching the clean Git checkout on Proxmox VM145. This preserves the Financio document workflow, changelog review, authorization, branding, recovery callback and dependency corrections. Do not rebuild the older default-branch upstream snapshot (`06cb59d8`) for this migration.

The source-build variant adds the reviewed public Financio branding/navigation, public ERP availability observation and private scheduled evidence drafts described in docs/FINANCIO_PUBLIC_BRANDING.md and docs/FINANCIO_AUTOMATION.md. Existing approved content, dependency locks, database schema and review/publication rules remain unchanged. Read `FINANCIO_SETUP.md`, `docs/FINANCIO_READINESS.md` and `docs/FINANCIO_RECOVERY.md` for the portal's existing operating and content boundaries. Changelog drafts and document publication continue to require explicit administrator decisions. No demo certification, initializer or migration runs during this move.

There are two complete Compose files:

- `docker-compose.coolify.recovered-images.yml` uses the already deployed image bytes for the initial migration. Root supplies verified immutable image references in `TRUST_CENTER_FRONTEND_IMAGE` and `TRUST_CENTER_BACKEND_IMAGE`. It has no application build instructions.
- `docker-compose.coolify.yml` builds the corrected two services using this branch's `frontend/Dockerfile` and `backend/Dockerfile` for later deployments from the fork. It also mounts the private automation receipt volume; the recovered-image variant intentionally retains the original application behavior.

Both expose only the gateway on the internal Docker network at port8080. In Coolify assign `http://trust.financioflow.com` to that service. Neither file publishes host ports or declares fixed container names or a database. The Cloudflare tunnel should route the hostname to the Coolify proxy only after the new portal is verified. ERP remains a separate application.

The existing dependency is Supabase Cloud at `https://euajlfcbdlccnzaqcltz.supabase.co`. Preserve that project, Auth users, SQL rows, RLS policies and anon/service keys. There is no PostgreSQL migration here. The service key is backend-only. The frontend keeps its existing public Supabase URL/anon key and same public API origin, so its recovered image does not need rebuilding merely to change the server host.

The private settings file is `/opt/financio-trust-center/.env.financio.local` on VM145. Both new Compose files use its existing variable names. Root transfers those values through protected files/Coolify bindings without printing or committing them. Migration bindings are the restored uploads volume name, gateway image digest and (for the initial variant) the two recovered image references. The later automated collector additionally requires explicit enablement and an existing administrator delegate; configure its single Coolify Scheduled Task and private receipt volume as documented in docs/FINANCIO_AUTOMATION.md. The optional GitHub evidence token remains backend-only. The source's existing admin signup, demo and test-email settings remain disabled.

The actual document volume is `financio-trust-center_trust-center-uploads`, containing7 regular files and178704bytes at inspection. Root must back up, restore and compare every file hash, preserving uid1000 and `/app/uploads`, before binding `TRUST_CENTER_UPLOADS_VOLUME`. Requiring an external volume prevents silently creating an empty replacement. Preserve the current upload setting; root can set `DOCUMENT_UPLOADS_ENABLED=false` during a reviewed migration preview if necessary to avoid two independent file writers sharing SQL metadata.

The gateway retains the existing25MiB request limit and redacts access-link tokens and query strings in its request log. It routes Express `/api/*` and `/health`, while exact `/api/revalidate` belongs to Next. Server rendering uses `http://backend:4000`; browser requests use the unchanged public portal origin. Supabase browser traffic continues to its preserved public origin.

Backend readiness uses the read-only `/api/documents` contract and requires an array response; this reaches PostgREST and the actual documents table. Frontend and gateway checks cover HTML plus the public list. These checks do not prove user authentication, mail delivery, file completeness, private-document boundaries or content acceptance; verify those separately before cutover.

Proposed initial runtime caps total960MiB: frontend512MiB, backend384MiB, gateway64MiB. Root must assess actual VPS headroom and observed usage before applying these limits. No capacity claim follows from this configuration.

Before cutover compare source/target public API counts and content, all7 uploaded file hashes, an existing public file download when an approved public document exists, protected-file rejection without approval when applicable, preserved administrator authentication and all portal pages. Do not publish draft documents/changelog entries or send test email to real recipients as a side effect of readiness. Preserve the VM as a rollback source until the new portal is accepted.

## Preview write boundaries

The original production branch has no scheduler, SQL initializer, background changelog generation or autonomous webhook loop when `DEMO_MODE=false`. Its only recurring timer clears the in-memory rate-limit map. The server Supabase client disables token auto-refresh and session persistence. Startup can create a missing local uploads directory; restore and verify the real volume first.

`DOCUMENT_UPLOADS_ENABLED=false` is not a global read-only mode. Other explicit contact/request/admin operations can write or send email. Even `GET /api/access/<valid-token>` records the first use; `/auth/callback` can consume a recovery token. Keep the preview private, use only ordinary public read-only routes for readiness, and do not supply real access/recovery tokens during preview. Webhooks run from explicit request/approval/denial handlers, rather than startup.

## Observed hosting migration

On22 October2026 the three recovered-image services were created and started in Coolify as `Financio Trust Center Production`. All three became healthy before routing changed. The restored external uploads volume contained all7 original files, totaling178704bytes, with every hash matching. Both services retained their original environment values. The public settings and four public content lists matched the Proxmox portal; all four lists were empty on the original too, so the move did not remove published content. Cloudflare then routed `trust.financioflow.com` to the VPS Coolify proxy. The original VM remains available for rollback. No ERP container was stopped for this move.

These observations cover the recovered baseline only. A source release's exact Git revision, CI result, new image identities, scheduled collector result and actual public branding must be recorded separately. Public availability does not establish administrator acceptance or a successful mail transaction.
