import { getSettings } from '@/lib/api';
import Link from 'next/link';

export default async function Footer() {
  const settings = await getSettings();

  const footerText = settings?.footer_text || `© ${new Date().getFullYear()} ${settings?.company_name || 'Financio Flow'}. All rights reserved.`;
  const footerLinks = settings?.footer_links || [];

  return (
    <footer className="financio-footer mt-auto border-t">
      <div className="container mx-auto px-4 py-10">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3 mb-8">
          <div>
            <p className="font-semibold text-base">{settings?.company_name || 'Financio Flow'} <span className="financio-mint">Trust Center</span></p>
            <p className="financio-muted mt-3 text-sm leading-relaxed max-w-sm">Published security information, document access and approved updates for Financio Flow.</p>
          </div>
          <nav aria-label="Financio Flow links" className="flex flex-col items-start gap-3 text-sm">
            <span className="financio-label">Financio Flow</span>
            <a href="https://app.financioflow.com/login">Open ERP ↗</a>
            <a href="https://financioflow.com">Product website ↗</a>
            <a href="https://financioflow.com/security">ERP security information ↗</a>
          </nav>
          <nav aria-label="Trust Center source" className="flex flex-col items-start gap-3 text-sm">
            <span className="financio-label">About this portal</span>
            <a href="https://github.com/thepsychonaut421/financio-trust-center">Portal source ↗</a>
            <a href="https://github.com/kutcode/trust-center">Original open-source project ↗</a>
            <Link href="/security-updates">Published updates</Link>
          </nav>
        </div>
        {/* Footer Links */}
        {footerLinks.length > 0 && (
          <div className="flex flex-wrap gap-6 mb-6">
            {footerLinks.map((link, index) => (
              <Link
                key={index}
                href={link.url}
                className="text-gray-600 hover:text-gray-900 transition-colors"
              >
                {link.label}
              </Link>
            ))}
          </div>
        )}

        {/* Footer Text */}
        <p className="financio-muted border-t border-gray-200 pt-6 text-sm">
          {footerText}
        </p>

        {/* Social Links */}
        {settings?.social_links && Object.keys(settings.social_links).length > 0 && (
          <div className="flex justify-center gap-4 mt-4">
            {Object.entries(settings.social_links).map(([platform, url]) => (
              <a
                key={platform}
                href={url as string}
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-500 hover:text-gray-700 transition-colors"
              >
                {platform.charAt(0).toUpperCase() + platform.slice(1)}
              </a>
            ))}
          </div>
        )}
      </div>
    </footer>
  );
}
