# Financio Trust Center — Service Provider Register

DRAFT FOR REVIEW — version 2026-10-11. Account contracts and transfer review pending.

This register describes the Trust Center pilot, not every provider used by the
ERP. It does not identify every provider as a GDPR processor in every activity;
the relevant contract and role must be reviewed.

## Providers currently used

- **Supabase:** dedicated PostgreSQL database and administrator authentication;
  request metadata, review/audit records and authentication data. Project
  location: Frankfurt. Uploaded document bytes are stored by the application,
  not intentionally in a Supabase object bucket in this deployment.
- **Cloudflare:** public HTTPS/tunnel routing and edge security. Handles
  connection metadata and traffic necessary to serve the portal. Edge processing
  is not limited to the database region.
- **Resend:** transactional document-access and administrator-recovery emails.
  Handles recipient addresses, email content and delivery/security metadata.
  Sending region: Ireland. Access messages contain bearer links and document
  titles; they do not attach restricted documents.
- **Proton:** receives operator mailbox messages at the Financio Flow domain,
  including notifications, reports and correspondence. The outgoing Trust
  Center subdomain uses Resend; it is not an additional Proton mailbox domain.
- **GitHub:** code hosting, pull requests, CI and source evidence collection.
  The evidence credential is dedicated and read-only. The normal document
  request flow does not intentionally send request records to GitHub.
- **Operator-controlled infrastructure:** a dedicated application VM stores
  uploaded document files and encrypted backups. An operator workstation holds
  encrypted backup copies and the recovery identity separately from the VM.

## Approval checklist

For each provider, record the contracted legal entity, applicable DPA and role,
subprocessor list, processing/storage locations, access controls, retention and
deletion settings, and the applicable Chapter V GDPR transfer mechanism where
required. Review email tracking and security-log settings against the notice.
Provider headquarters, an EU region or a vendor certificate alone do not
establish EEA-only processing or certify Financio Flow.

No external AI generator or Salesforce integration is configured for this
portal. A future integration requires a register update and a decision before
sending request data or confidential documents to it.
