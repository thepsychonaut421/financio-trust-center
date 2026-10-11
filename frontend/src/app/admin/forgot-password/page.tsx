'use client';

import { useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (loading) return;
    setLoading(true); setError(''); setMessage('');
    try {
      const { error: recoveryError } = await createClient().auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/auth/callback`,
      });
      if (recoveryError) throw recoveryError;
      setMessage('If this address has an account, a password recovery email will arrive shortly. Open the link in this browser.');
    } catch {
      setError('Recovery could not be requested. Please wait before trying again or contact support.');
    } finally { setLoading(false); }
  };
  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="max-w-md w-full bg-white rounded-lg shadow p-8">
        <h1 className="text-2xl font-bold mb-4">Recover administrator access</h1>
        <p className="text-sm text-gray-600 mb-6">Enter the email address used for your Trust Center account.</p>
        {message && <p role="status" className="mb-4 text-green-800">{message}</p>}
        {error && <p role="alert" className="mb-4 text-red-700">{error}</p>}
        <form onSubmit={submit} className="space-y-4">
          <label className="block text-sm font-medium" htmlFor="recovery-email">Email</label>
          <input id="recovery-email" type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} disabled={loading} className="w-full border rounded px-3 py-2" />
          <button disabled={loading} className="w-full bg-blue-600 text-white rounded px-4 py-2 disabled:opacity-50">{loading ? 'Sending...' : 'Send recovery email'}</button>
        </form>
        <Link href="/admin/login" className="inline-block mt-6 text-blue-700 underline">Back to login</Link>
      </div>
    </main>
  );
}
