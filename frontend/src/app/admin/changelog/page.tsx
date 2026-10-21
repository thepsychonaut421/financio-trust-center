'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { apiRequestWithAuth } from '@/lib/api';
import ConfirmModal from '@/components/ui/ConfirmModal';
import toast from 'react-hot-toast';

interface ChangelogDraft {
    id: string;
    title: string;
    content: string;
    state: 'draft' | 'rejected' | 'published';
    revision: number;
    evidence: Record<string, unknown>;
    created_at: string;
    updated_at: string;
}

interface ChangelogConfig {
    repository: string;
    github: 'configured' | 'not_configured';
    ai: 'not_configured';
    deploy: 'not_configured';
    securityCloud: 'not_configured';
    automation?: { enabled: boolean; actorConfigured: boolean; intervalSeconds: number };
}

interface HistoryEvent {
    action: string;
    actor_email: string;
    revision: number;
    title: string;
    content: string;
    note: string | null;
    created_at: string;
}

interface ReviewConfirmation {
    id: string;
    revision: number;
    title: string;
    decision: 'publish' | 'reject';
    note: string;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'The request could not be completed.';
}

function dateLabel(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString();
}

// Only known evidence providers become links. All remaining evidence is plain text.
function evidenceLinks(evidence: Record<string, unknown>): string[] {
    const links = new Set<string>();
    function visit(value: unknown, depth: number) {
        if (depth > 8 || links.size >= 50) return;
        if (typeof value === 'string') {
            try {
                const url = new URL(value);
                if (url.protocol === 'https:' && !url.username && !url.password &&
                    !url.port && ['github.com', 'ci.financioflow.com'].includes(url.hostname)) {
                    links.add(url.href);
                }
            } catch { /* A regular evidence value is not a link. */ }
        } else if (Array.isArray(value)) {
            value.forEach(item => visit(item, depth + 1));
        } else if (value && typeof value === 'object') {
            Object.values(value).forEach(item => visit(item, depth + 1));
        }
    }
    visit(evidence, 0);
    return [...links];
}

async function sessionToken(): Promise<string> {
    const { data: { session } } = await createClient().auth.getSession();
    if (!session) throw new Error('Your session has expired. Please sign in again.');
    return session.access_token;
}

const buttonStyle = 'px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed';
const inputStyle = 'w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 disabled:bg-gray-100 disabled:text-gray-500';

export default function ChangelogReviewPage() {
    const [drafts, setDrafts] = useState<ChangelogDraft[]>([]);
    const [config, setConfig] = useState<ChangelogConfig | null>(null);
    const [selected, setSelected] = useState<ChangelogDraft | null>(null);
    const selectedId = useRef<string | null>(null);
    const [form, setForm] = useState({ title: '', content: '' });
    const [sha, setSha] = useState('');
    const [note, setNote] = useState('');
    const [reviewed, setReviewed] = useState(false);
    const [confirmation, setConfirmation] = useState<ReviewConfirmation | null>(null);
    const [history, setHistory] = useState<HistoryEvent[]>([]);
    const [historyError, setHistoryError] = useState('');
    const [historyLoading, setHistoryLoading] = useState(false);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    const [fresh, setFresh] = useState(false);
    const [error, setError] = useState('');

    const selectDraft = useCallback((draft: ChangelogDraft | null) => {
        selectedId.current = draft?.id ?? null;
        setSelected(draft);
        setForm({ title: draft?.title ?? '', content: draft?.content ?? '' });
        setNote('');
        setReviewed(false);
        setConfirmation(null);
    }, []);

    const loadDrafts = useCallback(async (preferredId?: string) => {
        const token = await sessionToken();
        const [rows, settings] = await Promise.all([
            apiRequestWithAuth<ChangelogDraft[]>('/api/changelog', token, { cache: 'no-store' }),
            apiRequestWithAuth<ChangelogConfig>('/api/changelog/config', token, { cache: 'no-store' }),
        ]);
        setDrafts(rows);
        setConfig(settings);
        const id = preferredId ?? selectedId.current;
        const requested = rows.find(row => row.id === id);
        selectDraft(requested ?? (preferredId ? null : rows[0] ?? null));
        if (preferredId && !requested) setError('The requested draft is not in the current list. Select a draft from the list to review it.');
        setFresh(true);
    }, [selectDraft]);

    useEffect(() => {
        const preferredId = new URLSearchParams(window.location.search).get('draft') ?? undefined;
        loadDrafts(preferredId).catch(failure => setError(errorMessage(failure))).finally(() => setLoading(false));
    }, [loadDrafts]);

    useEffect(() => {
        let cancelled = false;
        setHistory([]);
        setHistoryError('');
        if (!selected) {
            setHistoryLoading(false);
            return;
        }
        setHistoryLoading(true);
        const id = selected.id;
        sessionToken()
            .then(token => apiRequestWithAuth<HistoryEvent[]>(`/api/changelog/${encodeURIComponent(id)}/history`, token, { cache: 'no-store' }))
            .then(rows => { if (!cancelled) setHistory(rows); })
            .catch(failure => { if (!cancelled) setHistoryError(errorMessage(failure)); })
            .finally(() => { if (!cancelled) setHistoryLoading(false); });
        return () => { cancelled = true; };
    }, [selected]);

    const dirty = !!selected && (form.title !== selected.title || form.content !== selected.content);
    const editable = fresh && selected?.state === 'draft' && !busy;
    const validForm = !!form.title.trim() && !!form.content.trim();
    const validNote = !!note.trim() && note.length <= 2000;

    // A failed write can have reached the server. Refresh once and require a new
    // human review; never retry a publish or silently reuse an old revision.
    async function runAction(action: () => Promise<void>) {
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        setError('');
        try {
            await action();
        } catch (failure) {
            setFresh(false);
            setConfirmation(null);
            const message = errorMessage(failure);
            try {
                await loadDrafts();
                setError(`${message} Drafts have been refreshed. Review the current revision before taking another action.`);
            } catch {
                setError(`${message} Refresh failed; actions are disabled until the current drafts can be loaded.`);
            }
        } finally {
            busyRef.current = false;
            setBusy(false);
        }
    }

    async function generateDraft(event: React.FormEvent) {
        event.preventDefault();
        if (sha.trim() && !/^[0-9a-f]{40}$/i.test(sha.trim())) {
            setError('Enter a full 40-character commit SHA, or leave it empty for the latest main commit.');
            return;
        }
        await runAction(async () => {
            const token = await sessionToken();
            const draft = await apiRequestWithAuth<ChangelogDraft>('/api/changelog/generate', token, {
                method: 'POST', body: JSON.stringify(sha.trim() ? { sha: sha.trim().toLowerCase() } : {}),
            });
            await loadDrafts(draft.id);
            toast.success('Private draft prepared. Review and edit it before publication.');
        });
    }

    async function saveDraft(event: React.FormEvent) {
        event.preventDefault();
        if (!editable || !selected || !validForm) return;
        const current = selected;
        await runAction(async () => {
            const token = await sessionToken();
            const draft = await apiRequestWithAuth<ChangelogDraft>(`/api/changelog/${encodeURIComponent(current.id)}`, token, {
                method: 'PATCH', body: JSON.stringify({ revision: current.revision, title: form.title, content: form.content }),
            });
            setDrafts(rows => rows.map(row => row.id === draft.id ? draft : row));
            selectDraft(draft);
            toast.success('Draft saved. Review the saved preview before publishing.');
        });
    }

    function requestReview(decision: 'publish' | 'reject') {
        if (!editable || !selected || dirty || !validNote || (decision === 'publish' && !reviewed)) return;
        setConfirmation({ id: selected.id, revision: selected.revision, title: selected.title, decision, note: note.trim() });
    }

    async function confirmReview() {
        if (!confirmation || !editable || !selected || dirty || selected.id !== confirmation.id ||
            selected.revision !== confirmation.revision) return;
        const review = confirmation;
        await runAction(async () => {
            const token = await sessionToken();
            const draft = await apiRequestWithAuth<ChangelogDraft>(`/api/changelog/${encodeURIComponent(review.id)}/review`, token, {
                method: 'POST', body: JSON.stringify({ revision: review.revision, decision: review.decision, note: review.note, confirm: true }),
            });
            setDrafts(rows => rows.map(row => row.id === draft.id ? draft : row));
            selectDraft(draft);
            toast.success(review.decision === 'publish' ? 'Approved revision published to Security Updates.' : 'Draft rejected.');
        });
    }

    if (loading) return <div className="p-6 text-gray-600" role="status">Loading changelog drafts…</div>;

    return (
        <div className="space-y-6">
            <ConfirmModal
                isOpen={!!confirmation}
                onClose={() => setConfirmation(null)}
                onConfirm={confirmReview}
                title={confirmation?.decision === 'publish' ? 'Publish approved revision?' : 'Reject this draft?'}
                message={confirmation?.decision === 'publish'
                    ? `Publish saved revision ${confirmation.revision} of “${confirmation.title}” to the public Trust Center? Only the title and content are published. Private evidence and review notes stay in the admin console.`
                    : `Reject saved revision ${confirmation?.revision} of “${confirmation?.title}”? The draft and your decision remain in the private review history.`}
                confirmLabel={confirmation?.decision === 'publish' ? 'Publish publicly' : 'Reject draft'}
                confirmStyle={confirmation?.decision === 'publish' ? 'primary' : 'danger'}
                isLoading={busy}
            />

            <div className="flex flex-wrap justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Changelog Review</h1>
                    <p className="mt-1 text-sm text-gray-600">Prepare a private draft from evidence, edit the wording, then decide what to publish.</p>
                </div>
                <Link href="/admin/security-updates" className="text-sm text-blue-700 underline">Published security updates</Link>
            </div>

            {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div>}

            <section className="rounded-lg border border-gray-200 bg-white p-5 space-y-4" aria-labelledby="generate-heading">
                <h2 id="generate-heading" className="font-semibold text-gray-900">Prepare a draft</h2>
                <p className="text-sm text-gray-600">Repository: <span className="font-mono">{config?.repository || 'Not configured'}</span></p>
                <p className="text-sm text-gray-600">Scheduled evidence collection: {config?.automation?.enabled && config.automation.actorConfigured ? 'enabled for private drafts' : 'not enabled'}. Automatic drafts still require your review before publication.</p>
                <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                    AI drafting is not configured. Drafts currently use an evidence-based template from GitHub. Deploy and Security Cloud integrations are not configured; a green CI result does not establish a deployment or a verified remediation.
                </div>
                <form onSubmit={generateDraft} className="flex flex-wrap items-end gap-3">
                    <div className="flex-1 min-w-64">
                        <label htmlFor="commit-sha" className="mb-1 block text-sm font-medium text-gray-700">Commit SHA (optional)</label>
                        <input id="commit-sha" value={sha} onChange={event => setSha(event.target.value)} maxLength={40}
                            disabled={busy} className={`${inputStyle} font-mono text-sm`} placeholder="Leave empty for the latest main commit" />
                    </div>
                    <button type="submit" disabled={busy || !fresh || config?.github !== 'configured'} className={`${buttonStyle} bg-blue-600 text-white hover:bg-blue-700`}>
                        {busy ? 'Working…' : 'Prepare private draft'}
                    </button>
                    <button type="button" disabled={busy} className={`${buttonStyle} border border-gray-300 text-gray-700`}
                        onClick={() => runAction(() => loadDrafts())}>Refresh</button>
                </form>
                {config?.github !== 'configured' && <p className="text-sm text-gray-600">GitHub evidence access must be configured before generating a draft.</p>}
            </section>

            <div className="grid gap-6 lg:grid-cols-[minmax(220px,1fr)_minmax(0,3fr)]">
                <section aria-labelledby="draft-list-heading" className="rounded-lg border border-gray-200 bg-white p-4">
                    <h2 id="draft-list-heading" className="mb-3 font-semibold text-gray-900">Drafts and decisions</h2>
                    {drafts.length === 0 && <p className="text-sm text-gray-500">No drafts yet. Preparing a draft does not publish anything.</p>}
                    <ul className="space-y-2">
                        {drafts.map(draft => <li key={draft.id}>
                            <button type="button" disabled={busy} onClick={() => selectDraft(draft)} aria-pressed={selected?.id === draft.id}
                                className={`w-full rounded-lg border p-3 text-left disabled:opacity-50 ${selected?.id === draft.id ? 'border-blue-400 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'}`}>
                                <span className="block break-words text-sm font-medium text-gray-900">{draft.title}</span>
                                <span className="mt-1 block text-xs text-gray-600">{draft.state} · revision {draft.revision}</span>
                                <span className="mt-1 block text-xs text-gray-500">{dateLabel(draft.updated_at)}</span>
                            </button>
                        </li>)}
                    </ul>
                </section>

                {selected && <div className="min-w-0 space-y-5">
                    <section className="rounded-lg border border-gray-200 bg-white p-5 space-y-4" aria-labelledby="editor-heading">
                        <div className="flex flex-wrap justify-between gap-2">
                            <h2 id="editor-heading" className="font-semibold text-gray-900">{selected.state === 'draft' ? 'Edit draft' : 'Reviewed revision'}</h2>
                            <span className="text-sm text-gray-500">{selected.state} · revision {selected.revision}</span>
                        </div>
                        {selected.state !== 'draft' && <p className="text-sm text-gray-600">This decision is final for this draft. Prepare a new draft for a correction.</p>}
                        <form onSubmit={saveDraft} className="space-y-4">
                            <div>
                                <label htmlFor="draft-title" className="mb-1 block text-sm font-medium text-gray-700">Public title</label>
                                <input id="draft-title" required maxLength={200} value={form.title} disabled={!editable}
                                    onChange={event => { setForm(current => ({ ...current, title: event.target.value })); setReviewed(false); }} className={inputStyle} />
                            </div>
                            <div>
                                <label htmlFor="draft-content" className="mb-1 block text-sm font-medium text-gray-700">Public content (plain text)</label>
                                <textarea id="draft-content" required rows={9} maxLength={20000} value={form.content} disabled={!editable}
                                    onChange={event => { setForm(current => ({ ...current, content: event.target.value })); setReviewed(false); }} className={`${inputStyle} text-sm`} />
                            </div>
                            {selected.state === 'draft' && <button type="submit" disabled={!editable || !dirty || !validForm}
                                className={`${buttonStyle} bg-blue-600 text-white hover:bg-blue-700`}>Save changes</button>}
                        </form>
                        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4" aria-labelledby="preview-heading">
                            <h3 id="preview-heading" className="mb-2 text-sm font-semibold text-gray-700">Public preview {dirty && '(unsaved)'}</h3>
                            <h4 className="mb-3 break-words text-lg font-semibold text-gray-900">{form.title}</h4>
                            <p className="whitespace-pre-wrap break-words text-sm text-gray-800">{form.content}</p>
                        </div>
                        {selected.state === 'draft' && <div className="border-t border-gray-200 pt-4 space-y-3">
                            <p className="text-sm text-gray-600">Check the private evidence below. Publish only claims supported by it, without sensitive technical details.</p>
                            {dirty && <p className="text-sm text-amber-800">Save your edits before making a decision.</p>}
                            <label htmlFor="review-note" className="block text-sm font-medium text-gray-700">Private decision note (required)</label>
                            <textarea id="review-note" rows={3} maxLength={2000} disabled={!editable} value={note}
                                onChange={event => setNote(event.target.value)} className={`${inputStyle} text-sm`} placeholder="Record why this revision is suitable to publish or why it should be rejected." />
                            <label className="flex items-start gap-2 text-sm text-gray-700">
                                <input type="checkbox" className="mt-1" checked={reviewed} disabled={!editable || dirty}
                                    onChange={event => setReviewed(event.target.checked)} />
                                I reviewed the saved public preview and its evidence and approve this wording for publication.
                            </label>
                            <div className="flex flex-wrap gap-3">
                                <button type="button" disabled={!editable || dirty || !validNote || !reviewed} onClick={() => requestReview('publish')}
                                    className={`${buttonStyle} bg-blue-600 text-white hover:bg-blue-700`}>Review publication</button>
                                <button type="button" disabled={!editable || dirty || !validNote} onClick={() => requestReview('reject')}
                                    className={`${buttonStyle} border border-red-300 text-red-700 hover:bg-red-50`}>Reject draft</button>
                            </div>
                        </div>}
                    </section>

                    <section className="rounded-lg border border-gray-200 bg-white p-5" aria-labelledby="evidence-heading">
                        <h2 id="evidence-heading" className="font-semibold text-gray-900">Private evidence</h2>
                        <p className="mt-1 text-sm text-gray-500">Evidence is available to administrators and is not included in the public update.</p>
                        <ul className="mt-3 space-y-1">
                            {evidenceLinks(selected.evidence).map(url => <li key={url}><a href={url} target="_blank" rel="noopener noreferrer" className="break-all text-sm text-blue-700 underline">{url}</a></li>)}
                        </ul>
                        <details className="mt-4">
                            <summary className="cursor-pointer text-sm text-gray-700">View collected evidence</summary>
                            <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-3 text-xs text-gray-700">{JSON.stringify(selected.evidence, null, 2)}</pre>
                        </details>
                    </section>

                    <section className="rounded-lg border border-gray-200 bg-white p-5" aria-labelledby="history-heading">
                        <h2 id="history-heading" className="font-semibold text-gray-900">Private review history</h2>
                        {historyLoading && <p className="mt-3 text-sm text-gray-500" role="status">Loading history…</p>}
                        {historyError && <p className="mt-3 text-sm text-red-700" role="alert">{historyError}</p>}
                        <ol className="mt-3 space-y-3">
                            {history.map((event, index) => <li key={`${event.created_at}-${index}`} className="rounded-lg border border-gray-200 p-3 text-sm">
                                <p className="font-medium text-gray-900">{event.action} · revision {event.revision}</p>
                                <p className="mt-1 text-gray-500">{event.actor_email} · {dateLabel(event.created_at)}</p>
                                {event.note && <p className="mt-2 whitespace-pre-wrap break-words text-gray-700">{event.note}</p>}
                                <details className="mt-2">
                                    <summary className="cursor-pointer text-gray-600">Revision snapshot</summary>
                                    <p className="mt-2 font-medium text-gray-900">{event.title}</p>
                                    <p className="mt-2 whitespace-pre-wrap break-words text-gray-700">{event.content}</p>
                                </details>
                            </li>)}
                        </ol>
                    </section>
                </div>}
            </div>
        </div>
    );
}
