'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';

export default function ResetPasswordPage() {
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [complete, setComplete] = useState(false);
  useEffect(() => {
    let active = true;
    const check = async () => {
      if (new URLSearchParams(window.location.search).has('error')) {
        if (active) setError('This recovery link is invalid, expired or already used. Request a new email.');
        return;
      }
      const supabase = createClient();
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (!user || authError) {
        if (active) setError('Open a valid recovery email before setting a new password.');
        return;
      }
      const { data: admin, error: adminError } = await supabase.from('admin_users').select('id').eq('id', user.id).maybeSingle();
      if (active) {
        if (adminError || !admin) setError('An administrator account is required.');
        else setReady(true);
      }
    };
    check().catch(() => { if (active) setError('Could not verify the recovery session. Please request a new email.'); });
    return () => { active = false; };
  }, []);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready || loading) return;
    if (password.length < 12) { setError('Use at least 12 characters.'); return; }
    if (password !== confirmation) { setError('The passwords do not match.'); return; }
    setLoading(true); setError('');
    try {
      const supabase = createClient();
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      setPassword(''); setConfirmation(''); setReady(false); setComplete(true);
      // End this browser session; leave other operator sessions to provider policy.
      await supabase.auth.signOut({ scope: 'local' });
    } catch { setError('Could not update the password. Your session may have expired; request a new recovery email.'); }
    finally { setLoading(false); }
  };
  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="max-w-md w-full bg-white rounded-lg shadow p-8">
        <h1 className="text-2xl font-bold mb-6">Set a new password</h1>
        {error && <p role="alert" className="mb-4 text-red-700">{error}</p>}
        {complete && <p role="status" className="mb-4 text-green-800">Password updated. Sign in with your new password.</p>}
        {ready && !complete && <form onSubmit={submit} className="space-y-4">
          <label htmlFor="new-password" className="block text-sm font-medium">New password</label>
          <input id="new-password" type="password" autoComplete="new-password" required minLength={12} value={password} onChange={e => setPassword(e.target.value)} disabled={loading} className="w-full border rounded px-3 py-2" />
          <label htmlFor="confirm-password" className="block text-sm font-medium">Confirm password</label>
          <input id="confirm-password" type="password" autoComplete="new-password" required minLength={12} value={confirmation} onChange={e => setConfirmation(e.target.value)} disabled={loading} className="w-full border rounded px-3 py-2" />
          <button disabled={loading} className="w-full bg-blue-600 text-white rounded px-4 py-2 disabled:opacity-50">{loading ? 'Saving...' : 'Update password'}</button>
        </form>}
        {!ready && !error && !complete && <p role="status">Verifying your recovery link...</p>}
        {!complete && <Link href="/admin/forgot-password" className="inline-block mt-6 mr-4 text-blue-700 underline">Request a new recovery email</Link>}
        <Link href="/admin/login" className="inline-block mt-6 text-blue-700 underline">Back to login</Link>
      </div>
    </main>
  );
}
