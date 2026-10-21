import { supabase } from '../server';

export function hasExpired(value: string | null | undefined): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return !Number.isFinite(timestamp) || timestamp <= Date.now();
}

// The upstream sample is not an approved agreement. Use an immutable,
// versioned URL when an administrator approves the actual terms.
export function approvedNdaUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const url = value.trim();
  try {
    const parsed = new URL(url, 'https://trust.invalid');
    if (parsed.pathname.endsWith('/nda-sample.html')) return null;
    if (url.startsWith('/') && !url.startsWith('//') && !url.includes('\\')) return url;
    if (url.startsWith('https://') && parsed.protocol === 'https:' && !parsed.username && !parsed.password) return url;
  } catch { /* Fail closed when the agreement URL is invalid. */ }
  return null;
}

export async function currentNdaUrl(): Promise<string | null> {
  const { data, error } = await supabase.from('trust_center_settings')
    .select('nda_url').limit(1).maybeSingle();
  if (error) throw error;
  return approvedNdaUrl(data?.nda_url);
}

export async function accessRequestError(request: any): Promise<string | null> {
  if (!['approved', 'auto_approved'].includes(request.status)) return 'Access not approved';
  if (!request.magic_link_expires_at || hasExpired(request.magic_link_expires_at)
    || hasExpired(request.access_expires_at)) return 'This link has expired';
  if (request.organization_id) {
    const { data: org, error } = await supabase.from('organizations')
      .select('status,is_active').eq('id', request.organization_id).maybeSingle();
    if (error) throw error;
    if (!org || org.status === 'no_access' || org.is_active === false) return 'Access not approved';
  }
  return null;
}

export function isAvailableDocument(document: any): boolean {
  return document.status === 'published' && document.is_current_version !== false
    && !hasExpired(document.expires_at);
}

export async function requestedPublishedDocuments(ids: string[]): Promise<any[] | null> {
  const { data, error } = await supabase.from('documents').select('*').in('id', ids);
  if (error) throw error;
  if (!data || data.length !== ids.length || data.some(doc => !isAvailableDocument(doc))) return null;
  return data;
}
