import fs from 'fs';
import os from 'os';
import path from 'path';
import { automationConfig, AutomationCursor, observationKey, privateReceiptStore, runAutomaticCollection } from '../changelogAutomation';
import { buildEvidence, draftFromEvidence } from '../changelogEvidence';
const id = '00000000-0000-4000-8000-000000000002';
const config = automationConfig({ TRUST_CENTER_AUTOMATION_ENABLED: 'true', TRUST_CENTER_AUTOMATION_ACTOR_ID: '00000000-0000-4000-8000-000000000001', TRUST_CENTER_AUTOMATION_ACTOR_EMAIL: 'delegate@example.test' });
const makeDraft = (sha = 'a'.repeat(40), state = 'success', date = '2026-10-22T00:00:00Z') => draftFromEvidence(buildEvidence('owner/repo', sha, { sha, statuses: [{ context: 'ci/woodpecker/push/required-release-gate', state }] }, date));
function fixture() {
  let cursor: AutomationCursor = { schemaVersion: 1, pending: null, last: null };
  let rows: any[] = [];
  const receipts = { read: jest.fn(() => structuredClone(cursor)), write: jest.fn((value: AutomationCursor) => { cursor = structuredClone(value); }) };
  const collect = jest.fn(async () => makeDraft());
  const find = jest.fn(async (key: string) => rows.filter(row => row.evidence.automation?.collectionKey === key));
  const create = jest.fn(async (args: any): Promise<{ data: any; error: { code?: string } | null }> => { const row = { id, state: 'draft', revision: 1, evidence: args.p_evidence }; rows.push(row); return { data: row, error: null }; });
  return { deps: { collect, find, create, receipts }, getCursor: () => cursor, setRows: (value: any[]) => { rows = value; }, getRows: () => rows };
}
describe('Scheduled private draft collection', () => {
  test('disabled collection makes no provider or receipt calls', async () => {
    const f = fixture();
    expect(await runAutomaticCollection(automationConfig({}), f.deps)).toEqual({ status: 'disabled' });
    expect(f.deps.collect).not.toHaveBeenCalled(); expect(f.deps.find).not.toHaveBeenCalled(); expect(f.deps.create).not.toHaveBeenCalled(); expect(f.deps.receipts.read).not.toHaveBeenCalled();
  });
  test('administrator delegation must be explicit', () => {
    expect(() => automationConfig({ TRUST_CENTER_AUTOMATION_ENABLED: 'true' })).toThrow('configured_administrator_delegate_required');
  });
  test('fingerprint ignores observation clock but tracks exact SHA and CI state', () => {
    expect(observationKey(makeDraft().evidence)).toBe(observationKey(makeDraft('a'.repeat(40), 'success', '2026-11-01T00:00:00Z').evidence));
    expect(observationKey(makeDraft().evidence)).not.toBe(observationKey(makeDraft('b'.repeat(40)).evidence));
    expect(observationKey(makeDraft().evidence)).not.toBe(observationKey(makeDraft('a'.repeat(40), 'pending').evidence));
  });
  test('repeat collection preserves the human-reviewed existing publication', async () => {
    const f = fixture(); expect((await runAutomaticCollection(config, f.deps)).status).toBe('created');
    f.getRows()[0].state = 'published'; f.getRows()[0].revision = 2;
    expect((await runAutomaticCollection(config, f.deps)).status).toBe('existing'); expect(f.deps.create).toHaveBeenCalledTimes(1);
    expect(f.deps.create.mock.calls[0][0]).toMatchObject({ p_actor_email: 'delegate@example.test', p_evidence: { automation: { disposition: 'private_draft_for_human_review', source: 'scheduled_collection' } } });
    expect(f.getRows()[0]).toMatchObject({ state: 'published', revision: 2 });
  });
  test('lost successful response reconciles without a second generation', async () => {
    const f = fixture(); f.deps.create.mockImplementation(async args => { f.setRows([{ id, state: 'draft', revision: 1, evidence: args.p_evidence }]); throw new Error('Lost response after commit'); });
    expect((await runAutomaticCollection(config, f.deps)).status).toBe('reconciled'); expect(f.deps.create).toHaveBeenCalledTimes(1); expect(f.getCursor().pending).toBeNull();
  });
  test('ambiguous outcome fences every newer observation until reconciled', async () => {
    const f = fixture(); f.deps.create.mockRejectedValue(new Error('Unknown outcome'));
    await expect(runAutomaticCollection(config, f.deps)).rejects.toThrow('write_outcome_unknown'); expect(f.getCursor().pending).not.toBeNull();
    f.deps.collect.mockResolvedValue(makeDraft('b'.repeat(40)));
    await expect(runAutomaticCollection(config, f.deps)).rejects.toThrow('previous_write_outcome_unknown'); expect(f.deps.collect).toHaveBeenCalledTimes(1); expect(f.deps.create).toHaveBeenCalledTimes(1);
  });
  test('later invocation can reconcile an earlier ambiguous commit', async () => {
    const f = fixture(); f.deps.create.mockRejectedValue(new Error('Unknown outcome')); await expect(runAutomaticCollection(config, f.deps)).rejects.toThrow();
    const key = f.getCursor().pending!.collectionKey; f.setRows([{ id, state: 'draft', revision: 1, evidence: { automation: { collectionKey: key } } }]);
    expect((await runAutomaticCollection(config, f.deps)).status).toBe('existing'); expect(f.deps.create).toHaveBeenCalledTimes(1); expect(f.getCursor().pending).toBeNull();
  });
  test('definite SQL rejection clears intent but is never retried in the run', async () => {
    const f = fixture(); f.deps.create.mockResolvedValue({ data: null, error: { code: '42501' } });
    await expect(runAutomaticCollection(config, f.deps)).rejects.toThrow('draft_creation_rejected'); expect(f.getCursor().pending).toBeNull(); expect(f.deps.create).toHaveBeenCalledTimes(1);
  });
  test('unavailable reconciliation and duplicates never create another draft', async () => {
    const f = fixture(); f.deps.find.mockRejectedValue(new Error('Provider unavailable'));
    await expect(runAutomaticCollection(config, f.deps)).rejects.toThrow('reconciliation_unavailable'); expect(f.deps.create).not.toHaveBeenCalled();
    const key = observationKey(makeDraft().evidence); f.deps.find.mockResolvedValue([1, 2].map(() => ({ id, state: 'draft', revision: 1, evidence: { automation: { collectionKey: key } } })));
    await expect(runAutomaticCollection(config, f.deps)).rejects.toThrow('multiple_matching_drafts_require_review'); expect(f.deps.create).not.toHaveBeenCalled();
  });
  test('missing confirmed history is not silently regenerated', async () => {
    const f = fixture(); await runAutomaticCollection(config, f.deps); f.setRows([]);
    await expect(runAutomaticCollection(config, f.deps)).rejects.toThrow('confirmed_draft_missing_requires_review'); expect(f.deps.create).toHaveBeenCalledTimes(1);
  });
  test('durable intent is mandatory before sending the RPC', async () => {
    const f = fixture(); f.deps.receipts.write.mockImplementation(() => { throw new Error('Disk full'); });
    await expect(runAutomaticCollection(config, f.deps)).rejects.toThrow('Disk full'); expect(f.deps.create).not.toHaveBeenCalled();
  });
});
describe('Private ambiguity receipt', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-collector-')); fs.chmodSync(dir, 0o700); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  test('persists a private receipt across store reconstruction', () => {
    privateReceiptStore(dir).write({ schemaVersion: 1, pending: { collectionKey: 'a'.repeat(64), sha: 'b'.repeat(40), preparedAt: '2026-10-22T00:00:00Z' }, last: null });
    expect(privateReceiptStore(dir).read().pending?.collectionKey).toBe('a'.repeat(64)); expect(fs.statSync(path.join(dir, 'collection-state.json')).mode & 0o777).toBe(0o600);
  });
  test('rejects public directories, symlink receipts and malformed state', () => {
    fs.chmodSync(dir, 0o755); expect(() => privateReceiptStore(dir)).toThrow('private_receipt_directory_required'); fs.chmodSync(dir, 0o700);
    const destination = path.join(dir, 'collection-state.json'); fs.symlinkSync(path.join(dir, 'target'), destination);
    expect(() => privateReceiptStore(dir).read()).toThrow('invalid_private_receipt'); fs.unlinkSync(destination);
    fs.writeFileSync(destination, '{broken', { mode: 0o600 }); expect(() => privateReceiptStore(dir).read()).toThrow('invalid_private_receipt');
  });
});
