import { z } from 'zod';

const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const commitSchema = z.object({
  sha: shaSchema,
  commit: z.object({ message: z.string().max(20000) }).optional(),
  files: z.array(z.object({ filename: z.string().max(2048) })).max(300).optional(),
});
const statusSchema = z.object({
  sha: shaSchema,
  statuses: z.array(z.object({
    context: z.string().max(200), state: z.enum(['success', 'pending', 'failure', 'error']),
    target_url: z.string().nullable().optional(), updated_at: z.string().optional(),
  })).max(1000),
});
export class EvidenceError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export function sourceRepository(): string {
  const repository = process.env.TRUST_CENTER_SOURCE_REPOSITORY || 'thepsychonaut421/Financio-Flow-ERP';
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) throw new EvidenceError(503, 'Invalid configured source repository');
  return repository;
}
function safeStatusUrl(value: string | null | undefined): string | null {
  try {
    const url = new URL(value || '');
    if (url.protocol !== 'https:' || !['github.com', 'ci.financioflow.com'].includes(url.hostname) || url.username || url.password || url.port) return null;
    url.search = ''; url.hash = '';
    return url.href;
  } catch { return null; }
}
function changeContext(sha: string, payload: unknown) {
  const parsed = commitSchema.safeParse(payload);
  const commit = parsed.success && parsed.data.sha === sha ? parsed.data : undefined;
  const areas = new Set<string>();
  for (const file of commit?.files || []) {
    const path = file.filename.toLowerCase();
    if (/(^|\/)(package(?:-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|go\.(mod|sum)|requirements[^/]*\.txt|poetry\.lock|cargo\.(toml|lock))$/.test(path)) areas.add('dependency maintenance');
    else if (/(^|\/)(\.github\/workflows|\.woodpecker|__tests__|tests?)(\/|\.)|\.(test|spec)\.[^/]+$/.test(path)) areas.add('automated validation');
    else if (/(^|\/)(security|auth|authorization|policies|cerbos)(\/|\.)|(?:^|[-_/])rls(?:[-_/.]|$)/.test(path)) areas.add('access control and security configuration');
    else if (/(^|\/)(docs?\/|readme[^/]*$)|\.(md|rst)$/.test(path)) areas.add('documentation');
    else if (/(^|\/)(dockerfile[^/]*|(?:docker-)?compose[^/]*\.ya?ml)$/.test(path)) areas.add('deployment configuration');
    else areas.add('application files');
  }
  return {
    summary: commit?.commit?.message.split('\n')[0].slice(0, 200) || null,
    areas: [...areas].sort(), observedFileCount: commit?.files?.length ?? null,
    coverage: !commit?.files ? 'not_collected' : commit.files.length === 300 ? 'possibly_partial' : 'reported_commit_files',
  };
}
export function buildEvidence(repository: string, sha: string, payload: unknown, collectedAt: string, commitDetails?: unknown) {
  const parsed = statusSchema.safeParse(payload);
  const matching = parsed.success && parsed.data.sha === sha;
  const gate = matching ? parsed.data.statuses.find(s => s.context === 'ci/woodpecker/push/required-release-gate') : undefined;
  const observedSecurityChecks = matching ? parsed.data.statuses
    .filter(s => /(?:security|dependency|sast|trivy|codeql|aikido|npm[-_/ .]audit)/i.test(s.context))
    .map(s => ({ context: s.context, state: s.state, source: safeStatusUrl(s.target_url) }))
    .sort((a, b) => a.context < b.context ? -1 : a.context > b.context ? 1 : 0).slice(0, 50) : [];
  return {
    schemaVersion: 1, repository, sha, collectedAt,
    merged: { state: 'confirmed', source: `https://github.com/${repository}/commit/${sha}` },
    ci: { state: gate?.state || 'unknown', source: safeStatusUrl(gate?.target_url),
      provenance: 'GitHub commit status mirror; executed Woodpecker config not independently verified' },
    change: changeContext(sha, commitDetails),
    securityChecks: { source: 'GitHub commit status mirror', observations: observedSecurityChecks,
      scope: 'Up to 50 security-labelled job statuses; no security findings, coverage, deployment or remediation claim' },
    deploy: { state: 'not_configured' }, securityCloud: { state: 'not_configured' }, ai: { state: 'not_configured' },
  };
}
export function draftFromEvidence(evidence: ReturnType<typeof buildEvidence>) {
  const checks = evidence.ci.state === 'success'
    ? 'The required automated release checks reported success for this change.'
    : 'Automated release validation has not been confirmed for this change.';
  // Commit messages and filenames are private review context, never public copy.
  // The template describes observed file areas without claiming behavior or fixes.
  const areas = evidence.change.areas.length ? ` Observed changed files cover ${evidence.change.areas.join(', ')}.` : '';
  return {
    title: 'Financio Flow engineering update',
    content: `An engineering change has been integrated into Financio Flow.${areas} ${checks}${evidence.securityChecks.observations.length ? ' Security-related CI job results are available as private review context; they do not establish the closure of findings.' : ''}\n\nDeployment and remediation verification have not been confirmed. This update does not announce a production rollout or the closure of security findings.`,
    evidence: { ...evidence, generator: 'evidence-template-v2' },
  };
}

export async function collectDraft(requestedSha?: string, request: typeof fetch = fetch) {
  const repository = sourceRepository();
  const token = process.env.TRUST_CENTER_GITHUB_TOKEN;
  if (!token) throw new EvidenceError(503, 'Configure a dedicated read-only GitHub credential to collect private repository evidence');
  async function get(path: string): Promise<unknown> {
    try {
      const response = await request(`https://api.github.com/repos/${repository}/${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        redirect: 'error', signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new EvidenceError(503, 'GitHub evidence collection failed; check the dedicated credential and source repository');
      const body = await response.text();
      if (body.length > 1000000) throw new EvidenceError(503, 'Evidence response exceeds the size limit');
      return JSON.parse(body);
    } catch (error) {
      if (error instanceof EvidenceError) throw error;
      throw new EvidenceError(503, 'GitHub evidence collection unavailable');
    }
  }
  const parsed = commitSchema.safeParse(await get('commits/main'));
  if (!parsed.success) throw new EvidenceError(503, 'Invalid source commit evidence');
  const sha = parsed.data.sha;
  if (requestedSha && requestedSha !== sha) throw new EvidenceError(409, 'The requested SHA is not the current main head; refresh the source');
  // The commit must be an observed main head. PR-only statuses never satisfy the push gate.
  let status: unknown;
  try { status = await get(`commits/${sha}/status`); } catch { status = null; }
  return draftFromEvidence(buildEvidence(repository, sha, status, new Date().toISOString(), parsed.data));
}
