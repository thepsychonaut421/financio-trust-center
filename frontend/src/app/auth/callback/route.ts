import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// Fixed destination: recovery cannot turn this endpoint into an open redirect.
export async function GET(request: NextRequest) {
  // Next can reconstruct request.url with the container hostname behind a
  // reverse proxy. Recovery must return to the configured public application.
  const publicOrigin = process.env.TRUST_CENTER_PUBLIC_URL || request.nextUrl.origin;
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
        const response = NextResponse.redirect(new URL('/admin/reset-password', publicOrigin));
        response.headers.set('Cache-Control', 'no-store');
        response.headers.set('Referrer-Policy', 'no-referrer');
        return response;
      }
      // Log only the provider's classification, never the link, tokens or session.
      const errorCode = result.error?.code;
      console.warn('Recovery verification failed', {
        code: errorCode && /^[a-z_]{1,80}$/.test(errorCode) ? errorCode : 'auth_error',
        status: result.error?.status,
      });
    } catch {
      console.warn('Recovery verification failed', { code: 'session_exchange_failed' });
    }
  }
  const response = NextResponse.redirect(new URL('/admin/reset-password?error=invalid_link', publicOrigin));
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
