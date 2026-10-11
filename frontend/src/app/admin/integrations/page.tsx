import { notFound } from 'next/navigation';

// Salesforce customer access sync is disabled in the Financio adaptation.
export default function IntegrationsAdminPage() {
  notFound();
}
