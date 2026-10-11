import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// Fixed destination: recovery cannot turn this endpoint into an open redirect.
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const tokenHash = request.nextUrl.searchParams.get('token_hash');
  const type = request.nextUrl.searchParams.get('type');
  if (code || (tokenHash && type === 'recovery')) {
    try {
      const supabase = await createClient();
      const result = code
        ? await supabase.auth.exchangeCodeForSession(code)
        : await supabase.auth.verifyOtp({ token_hash: tokenHash!, type: 'recovery' });
      if (!result.error && result.data.session) {
        const response = NextResponse.redirect(new URL('/admin/reset-password', request.url));
        response.headers.set('Cache-Control', 'no-store');
        response.headers.set('Referrer-Policy', 'no-referrer');
        return response;
      }
    } catch { /* Invalid/used recovery links must not leave tokens in the URL. */ }
  }
  const response = NextResponse.redirect(new URL('/admin/reset-password?error=invalid_link', request.url));
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
