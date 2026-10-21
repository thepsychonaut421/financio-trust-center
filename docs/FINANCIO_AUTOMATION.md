# Automated evidence drafts

## Impact map

- Lifecycle: periodically observe the configured ERP repository's current main commit and exact-SHA GitHub CI status mirror; create one private, source-attributed changelog draft for each distinct observation. Existing administrator edit, review, publish and reject decisions remain authoritative.
- Files/routes: existing evidence collector extended with bounded security-related CI observations; a separate backend CLI; a single scheduled CLI protected by a persistent flock and an ambiguity receipt; a Coolify scheduled task for the backend service. Existing `/api/changelog/config` gains status fields. No public endpoint, extra GitHub permissions, AI model call or automatic publication is introduced.
- Tables: reuse `changelog_drafts`, `changelog_review_events` and `admin_users`; do not create parallel security or release records. The existing `security_updates` publication contract is unchanged. A single canonical scheduler takes the shared flock before reconciling collection keys in private evidence. Ambiguous writes remain fenced by a durable receipt until the database confirms their outcome.
- Invariants: generated content remains private draft; reviewed/published history stays immutable; private paths, commit subjects and credential values never become public text. A matching GitHub CI status does not prove deployment or security-finding remediation. Missing sources stay explicit.
- Tests: exact-SHA evidence and redaction contracts; deterministic deduplication identity; automatic collection calls only the private generation RPC; disabled/misconfigured automation makes no network writes; repeat/ambiguous-outcome reconciliation and unchanged private RPC/role restrictions; existing review/publication contracts; backend/frontend build and focused UI contracts.
- Migration/data risk: no DDL or migration. No existing draft/publication row changes. The collector uses only the existing create_changelog_draft RPC and SELECT permission. Root must configure a single locked schedule and the durable private receipt volume before enabling it. Existing Supabase and GitHub bindings are reused. A configured administrator delegates draft creation only; their reviewer identity is not an approval. No seed certifications, arbitrary repository scans, live production mutations or publication side effects belong to this automation.

## Deployment contract

Build the corrected Trust Center fork, then use the source-build Coolify Compose file. It mounts a dedicated `automation-state` volume at `/var/lib/financio-trust-automation`, owned by uid1000 with mode0700; document uploads remain separate. The backend image contains `flock` and the canonical wrapper. Configure exactly one Coolify Scheduled Task targeting the backend service:

```
/bin/sh /app/scripts/collect-changelog.sh
```

Use schedule `*/15 * * * *`. This is a Coolify application task, not a second host cron or an in-process loop. The wrapper holds one shared persistent flock for the whole collection. Do not run the unlocked CLI, schedule duplicate jobs or attach different receipt volumes to overlapping collectors. There is no database-level uniqueness constraint for these JSON fingerprints in this initial slice; the single canonical lock/schedule is an explicit operating requirement.

Enable `TRUST_CENTER_AUTOMATION_ENABLED=true` only after configuring that task and its durable state. Set `TRUST_CENTER_AUTOMATION_ACTOR_ID` and `TRUST_CENTER_AUTOMATION_ACTOR_EMAIL` to an existing administrator who delegates automatic draft generation. The existing generation RPC checks that exact identity. The private evidence explicitly records scheduled generation on their behalf; it never represents a human approval. No new database credential, GitHub scope or administrator browser token is required. Keep the existing dedicated Supabase service key and GitHub read-only contents/status credential on the backend only.

Every run reconciles the fingerprint before generation. It writes and fsyncs a private intent before sending the existing `create_changelog_draft` request, with SDK retries explicitly disabled for that RPC. A lost response is reconciled by the stored fingerprint. An unresolved result blocks later generation, including newer source commits, until the database confirms it; the task never assumes an absent/failed response means no write occurred. Investigate a persistent `previous_write_outcome_unknown` using the private database and receipt; never clear the receipt or retry blindly. A confirmed draft, rejection or publication is reused without editing its text or history.

The key covers source repository, observed main SHA, matching required push CI status/source and the bounded security-labelled CI job observations. A newer CI observation for the same SHA can generate a new private draft; collection timestamps alone cannot. The collector does not backfill arbitrary commits or copy commit subjects/paths into public text.

## Source and publication limits

Automated security input is limited to the configured repository's exact-SHA GitHub commit-status mirror (for example security/dependency/CodeQL/Trivy job labels), plus broad changed-file areas. It does not call Security Cloud finding APIs, inspect private scan results, claim complete scan coverage or close findings. Missing sources remain `not_configured`, and an unrecognised provider URL is not promoted to a trusted source link. Existing private evidence includes source URLs; public copy appears only after the unchanged explicit review/publish flow.

The public ERP panel independently observes the fixed public `https://app.financioflow.com/api/server-info` response. It checks only the exposed Nest availability identity with a3-second timeout and32KiB body limit. The current public projection does not include the release SHA; that remains unknown rather than being borrowed from Git main or internal diagnostics. An unavailable/invalid public response produces no availability claim. Existing published ERP legal/security pages remain directly linked even while the Trust Center has no approved document or changelog entry.
