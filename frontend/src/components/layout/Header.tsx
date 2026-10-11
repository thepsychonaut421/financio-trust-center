import { getSettings } from '@/lib/api';
import HeaderClient from './HeaderClient';

export default async function Header() {
  const settings = await getSettings();

  return (
    <HeaderClient
      companyName={settings?.company_name || 'Financio Flow'}
      primaryColor={settings?.primary_color || '#1e3a8a'}
      logoUrl={settings?.company_logo_url}
      isDemoMode={process.env.NEXT_PUBLIC_DEMO_MODE === 'true' || process.env.DEMO_MODE === 'true'}
    />
  );
}
