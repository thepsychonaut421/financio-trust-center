# Financio Trust Center launch preparation

The portal is a pilot for approved security documents and updates. Its existing
changelog workflow prepares evidence-backed drafts; publication requires an
administrator's explicit review of the current revision. Keep the existing draft
unpublished until that decision is made.

## Content to prepare for human review

| Item | Preparation | Decision needed before use |
| --- | --- | --- |
| Security overview | Describe the actual service, access process, and security contact; substantiate each control with current evidence. | Approve wording and intended public/restricted audience. |
| Security changelog | Use Admin → Changelog Review to collect the observed source SHA and its matching CI status. Edit the generated draft. | Approve publication; CI alone does not establish deployment or finding closure. |
| NDA | The upstream `/nda-sample.html` is excluded from active NDA settings. | Replace it with approved terms and verify the access-request acceptance flow before NDA-protected documents. |
| Privacy / terms links | Add the applicable approved policy URLs in Admin → Settings. | Confirm that the policies actually cover Trust Center request data and document access. |
| Reports / certifications | Upload actual current reports and assign their access level and validity. | Verify issuer, scope and expiration; do not use upstream demo content as evidence. |
| Incident / vulnerability contact | Security contact is `security@financioflow.com`; admin/support is `info@financioflow.com`. | Establish mailbox ownership and response process. |

Document uploads and file replacements are now private drafts. Review the file
using the administrator-only preview, then explicitly choose Published. Requests
remain pending until a human decision, including for whitelisted domains.
Approval emails contain an access-page link without document attachments.
Download checks enforce publication, expiry, revocation, organization status and
request-specific NDA acceptance. The upstream sample is disabled as active terms.

Review the prepared legal and security pack in [review/README.md](review/README.md).
The operator's Impressum identity was confirmed by the user. Final wording,
retention, provider contracts/transfer safeguards and NDA activation remain
manual decisions; draft material must not be presented as an audit report.

## Operational acceptance

Before relying on the portal for restricted documents:

1. Confirm public pages and APIs, administrator login, private draft/history
   protection and manual publication at the deployed source revision.
2. Check Resend delivery and Proton receiving aliases. The completed backend email
   test does not verify Supabase Auth recovery emails or document-delivery emails.
3. Exercise access-request approval, approved-document links and revoked/expired
   links with explicitly approved test recipients and real test documents. Clean
   up the fixtures afterward. Avoid uncontrolled production test messages.
4. Check the daily backup service, the latest checksum-verified iMac copy and a
   successful isolated restore receipt; see [FINANCIO_RECOVERY.md](FINANCIO_RECOVERY.md).
   Provider Auth/SMTP settings and complete app recovery need separate verification.
5. Rotate the dedicated GitHub read-only evidence credential before its recorded
   expiry, and verify evidence collection again. Keep it separate from operator
   and ERP credentials.

AI provisioning remains skipped. The current local generator can assist with
changelog copy without an AI key. Salesforce remains disabled. Adding deployment
or Security Cloud evidence sources is a separate configuration/integration task;
do not infer their results from a green CI status.
