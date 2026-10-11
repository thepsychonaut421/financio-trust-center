import express from 'express';
import { supabase } from '../server';

const router = express.Router();
const DEFAULT_NDA_URL = '/nda-sample.html';
const PUBLIC_SETTINGS_FIELDS = [
  'id', 'company_name', 'company_logo_url', 'favicon_url',
  'primary_color', 'secondary_color', 'accent_color', 'font_family',
  'hero_title', 'hero_subtitle', 'hero_image_url', 'about_section',
  'contact_email', 'support_email', 'social_links', 'footer_text', 'footer_links',
  'privacy_policy_url', 'terms_of_service_url', 'nda_url', 'support_tickets_enabled',
];

const DEFAULT_PUBLIC_SETTINGS = {
  company_name: 'Financio Flow',
  hero_title: 'Financio Flow Trust Center',
  hero_subtitle: 'Security documents and approved updates for Financio Flow.',
  primary_color: '#1e3a8a',
  secondary_color: '#475569',
  nda_url: DEFAULT_NDA_URL,
};

// Get public trust center settings
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('trust_center_settings')
      // Keep internal notification recipients and administrator settings private.
      .select(PUBLIC_SETTINGS_FIELDS.join(','))
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.json(DEFAULT_PUBLIC_SETTINGS);

    const settings = data as unknown as Record<string, unknown>;
    const publicSettings = Object.fromEntries(
      PUBLIC_SETTINGS_FIELDS.filter(field => Object.prototype.hasOwnProperty.call(settings, field))
        .map(field => [field, settings[field]]),
    );
    res.json({
      ...publicSettings,
      nda_url: settings.nda_url || DEFAULT_NDA_URL,
    });
  } catch (error: unknown) {
    console.error('Route error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
