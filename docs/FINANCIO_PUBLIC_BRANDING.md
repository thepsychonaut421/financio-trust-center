# Public Trust Center branding

Impact map: public portal navigation and presentation only. The touched files are
the public conditional layout, header, footer, homepage, security-updates page and
scoped public CSS, plus a focused UI smoke test. No database model, migration,
authorization, document access, publication state, email or backup workflow changes.

The portal uses Financio Flow's existing dark design tokens: navy canvas and
surfaces, restrained blue links, mint brand accent, Inter typography, thin borders
and compact controls. The public wrapper scopes those styles away from the
administrator console. Existing configurable company name, logo, hero copy and
footer links remain supported; approved document and update content is unchanged.

Both desktop navigation and the mobile menu link back to the ERP. The footer
identifies the Financio portal source and original upstream project. Public copy
distinguishes published information and access review from drafts and independent
assurance without adding certifications or operational badges.

The homepage links the six existing ERP security, privacy, terms, subprocessors,
Impressum and contact pages. A bounded server-side observation from the fixed
public ERP server-info endpoint displays its observed response time. The current
public endpoint does not expose a release SHA; the portal says so explicitly.
Missing or invalid observations remain unavailable; neither Git main nor CI is
substituted for production identity. This read creates no ERP data or API route.

Validation: frontend typecheck, production build, existing changelog/access UI
checks and a public-shell smoke check for navigation, responsive styles, scoped
theme and content preservation. These source checks are separate from deployment
and live desktop/mobile acceptance.

Local validation on22October2026: frontend typecheck, production build, existing
changelog and access UI checks, and the new public-brand UI check passed. Chromium
preview at1440×1000 and390×844 verified the six reference links, desktop/mobile
ERP navigation, dark public canvas, no horizontal overflow and no application
JavaScript errors. Preview portal records were synthetic; the optional ERP
observation used only the fixed public endpoint. Those captures are layout proof,
not evidence that the portal version is deployed or that restricted delivery works.
