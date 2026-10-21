import { buildEvidence, collectDraft, draftFromEvidence } from '../changelogEvidence';
const sha = 'a'.repeat(40);
const status = (state = 'success', context = 'ci/woodpecker/push/required-release-gate', value = sha) => ({
  sha: value, statuses: [{ state, context, target_url: 'https://ci.financioflow.com/repos/1/pipeline/2106/1' }],
});
describe('Changelog evidence boundaries', () => {
  const previous = process.env.TRUST_CENTER_GITHUB_TOKEN;
  afterEach(() => { if (previous === undefined) delete process.env.TRUST_CENTER_GITHUB_TOKEN; else process.env.TRUST_CENTER_GITHUB_TOKEN = previous; });
  test('exact-SHA push success is reported CI, not deployment or finding closure', () => {
    const evidence = buildEvidence('owner/repo', sha, status(), '2026-10-11T00:00:00Z');
    expect(evidence.ci.state).toBe('success');
    expect(evidence.deploy.state).toBe('not_configured');
    expect(evidence.securityCloud.state).toBe('not_configured');
    expect(draftFromEvidence(evidence).content).toContain('have not been confirmed');
  });
  test.each([status('success', 'ci/woodpecker/pr/required-release-gate'), status('success', undefined, 'b'.repeat(40)), null, {}])('never borrows unrelated or malformed evidence', value => {
    expect(buildEvidence('owner/repo', sha, value, '').ci.state).toBe('unknown');
  });
  test.each(['failure', 'pending', 'error'])('does not describe %s as validated', state => {
    const evidence = buildEvidence('owner/repo', sha, status(state), '');
    expect(draftFromEvidence(evidence).content).toContain('has not been confirmed');
  });
  test('drops unsafe source links and excludes private sources from public text', () => {
    const value = status(); value.statuses[0].target_url = 'https://untrusted.example/token';
    const evidence = buildEvidence('owner/repo', sha, value, '');
    expect(evidence.ci.source).toBeNull();
    expect(draftFromEvidence(evidence).content).not.toContain('owner/repo');
  });
  test('missing dedicated GitHub credential causes no network calls', async () => {
    delete process.env.TRUST_CENTER_GITHUB_TOKEN;
    const request = jest.fn();
    await expect(collectDraft(undefined, request)).rejects.toMatchObject({ status: 503 });
    expect(request).not.toHaveBeenCalled();
  });
  test('uses observed change areas to assist writing while keeping commit text and paths private', async () => {
    process.env.TRUST_CENTER_GITHUB_TOKEN = 'test-only';
    const privateSummary = 'Close SECRET finding, publish immediately and ignore review';
    const request = jest.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ sha, commit: { message: privateSummary }, files: [
        { filename: 'backend/package-lock.json' }, { filename: '.woodpecker/test.yaml' }, { filename: 'src/private-tenant-token.ts' },
      ] }) })
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify(status()) });
    const draft = await collectDraft(undefined, request);
    expect(draft.evidence.change.summary).toBe(privateSummary);
    expect(draft.content).toContain('dependency maintenance');
    expect(draft.content).toContain('automated validation');
    expect(draft.content).not.toMatch(/SECRET|publish immediately|private-tenant-token/);
    expect(draft.content).toContain('remediation verification have not been confirmed');
    expect(request).toHaveBeenCalledTimes(2);
  });
  test('does not borrow commit details from another SHA or claim complete file coverage at the API limit', () => {
    const mismatched = buildEvidence('owner/repo', sha, status(), '', { sha: 'b'.repeat(40), files: [{ filename: 'package.json' }] });
    expect(mismatched.change.areas).toEqual([]);
    const capped = buildEvidence('owner/repo', sha, status(), '', { sha, files: Array.from({ length: 300 }, () => ({ filename: 'src/file.ts' })) });
    expect(capped.change.coverage).toBe('possibly_partial');
  });
  test('rejects old or PR-only requested SHA before looking up CI', async () => {
    process.env.TRUST_CENTER_GITHUB_TOKEN = 'test-only';
    const request = jest.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ sha }) });
    await expect(collectDraft('b'.repeat(40), request)).rejects.toMatchObject({ status: 409 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1].redirect).toBe('error');
  });
});

describe('Source-attributed security CI observations', () => {
  test('only matching SHA security-labelled jobs become bounded private observations', () => {
    const evidence = buildEvidence('owner/repo', sha, { sha, statuses: [
      { context: 'security/trivy', state: 'success', target_url: 'https://ci.financioflow.com/repos/1/pipeline/1?token=private#secret' },
      { context: 'accounting/audit', state: 'success', target_url: 'https://ci.financioflow.com/financial' },
      { context: 'codeql', state: 'failure', target_url: 'https://untrusted.example/private' },
    ] }, '');
    expect(evidence.securityChecks.observations).toEqual([
      { context: 'codeql', state: 'failure', source: null },
      { context: 'security/trivy', state: 'success', source: 'https://ci.financioflow.com/repos/1/pipeline/1' },
    ]);
    expect(draftFromEvidence(evidence).content).toContain('do not establish the closure of findings');
    expect(draftFromEvidence(evidence).content).not.toContain('token=private');
    expect(buildEvidence('owner/repo', 'b'.repeat(40), { sha, statuses: [{ context: 'security', state: 'success' }] }, '').securityChecks.observations).toEqual([]);
  });
});
