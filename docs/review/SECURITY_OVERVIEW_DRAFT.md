# Financio Trust Center — Security Overview

DRAFT FOR REVIEW — version 2026-10-11. Scope: the Trust Center pilot.

## What this service provides

The Trust Center is a dedicated portal for approved security information and
controlled document access relating to Financio Flow. It is adapted from the
open-source kutcode/trust-center project. Its application deployment, database
project and operational credentials are separate from the ERP.

This overview describes this portal. It is not a certification or a statement
that every ERP control has been independently verified.

## Publication and document access

New uploads and replacement files are saved as private drafts. An authorized
administrator reviews the content and intended audience before publication.
Security update drafts can be prepared from observed source and CI evidence;
publication requires a human review of the current draft revision.

Restricted requests require a manual administrator decision. Approval sends a
limited-duration access link, without a document attachment. The server checks
request approval, link/access expiry, organization access, document publication
and document expiry at download time. NDA-protected documents additionally
require explicit acceptance of the currently approved agreement URL for that
request. Revocation stops future link downloads, but not use of an earlier copy.

## Operations

The portal uses HTTPS at its public endpoint. Administrator authentication is
provided through its dedicated Supabase project, with public administrator
registration disabled. Public listing APIs expose published content; private
drafts and internal notification settings are restricted.

Encrypted daily backups and a checksum-verified copy to an operator workstation
are configured. An isolated database restore has been exercised. This does not
constitute a full provider-authentication or whole-application disaster-recovery
certification. Backup retention and a geographically separate recovery copy
still require operational decisions.

CI runs application tests/build checks and dependency/container checks. Their
results are point-in-time evidence, not a guarantee of security or a substitute
for validating a specific finding. No ISO 27001, SOC 2 or independent penetration
test certification is claimed for the portal.

## Contacts

Security reports: security@financioflow.com.
Access, privacy and administration: info@financioflow.com.
Operator: Rares-Daniel Balauta, identified in the Financio Flow Impressum.
