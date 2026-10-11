-- Financio defaults for new installations. Never overwrite custom branding.
ALTER TABLE trust_center_settings
  ALTER COLUMN company_name SET DEFAULT 'Financio Flow',
  ALTER COLUMN hero_title SET DEFAULT 'Financio Flow Trust Center',
  ALTER COLUMN hero_subtitle SET DEFAULT 'Security documents and approved updates for Financio Flow.',
  ALTER COLUMN primary_color SET DEFAULT '#1e3a8a',
  ALTER COLUMN secondary_color SET DEFAULT '#475569';

-- Earlier migrations insert an upstream placeholder row. Change only that
-- untouched placeholder; customized installations keep all their content.
UPDATE trust_center_settings
SET company_name = 'Financio Flow',
    hero_title = 'Financio Flow Trust Center',
    hero_subtitle = 'Security documents and approved updates for Financio Flow.',
    about_section = 'Find published security documents and approved updates for Financio Flow here.',
    contact_email = NULL,
    footer_text = NULL,
    primary_color = '#1e3a8a',
    secondary_color = '#475569'
WHERE company_name = 'Trust Center'
  AND hero_title = 'Security & Compliance'
  AND hero_subtitle = 'Your trusted partner for security and compliance documentation'
  AND about_section = 'Welcome to our Trust Center. We are committed to maintaining the highest standards of security and compliance.'
  AND contact_email = 'security@example.com'
  AND footer_text = '© 2024 Trust Center. All rights reserved.'
  AND company_logo_url IS NULL
  AND hero_image_url IS NULL
  AND favicon_url IS NULL
  AND support_email IS NULL
  AND primary_color = '#007bff'
  AND secondary_color = '#6c757d'
  AND accent_color = '#2563eb'
  AND font_family = 'Inter'
  AND social_links = '{}'::jsonb
  AND footer_links = '[]'::jsonb
  AND updated_by IS NULL;

-- A new settings row uses column defaults rather than unsupported assurances.
INSERT INTO trust_center_settings (company_name, hero_title, hero_subtitle)
SELECT 'Financio Flow', 'Financio Flow Trust Center',
       'Security documents and approved updates for Financio Flow.'
WHERE NOT EXISTS (SELECT 1 FROM trust_center_settings);

-- Salesforce is disabled. Removing its navigation entry preserves all others.
UPDATE trust_center_settings
SET admin_nav_order = array_remove(admin_nav_order, 'integrations')
WHERE 'integrations' = ANY(admin_nav_order);

ALTER TABLE trust_center_settings
ALTER COLUMN admin_nav_order SET DEFAULT ARRAY[
  'dashboard', 'controls', 'documents', 'certifications', 'security-updates', 'changelog',
  'requests', 'tickets', 'organizations', 'users', 'activity', 'settings'
];

-- No certifications, findings, documents, or compliance claims are seeded.
