import express from 'express';
import request from 'supertest';
import { supabase } from '../../server';
import { collectDraft } from '../../services/changelogEvidence';
import changelog from '../changelog';
import securityUpdates from '../securityUpdates';
jest.mock('../../server', () => ({ supabase: { rpc: jest.fn(), from: jest.fn() } }));
jest.mock('../../middleware/auth', () => ({ requireAdmin: (req: any, res: any, next: any) => {
  if (req.headers.authorization !== 'Bearer test-admin') return res.status(401).json({ error: 'Unauthorized' });
  req.admin = { id: '00000000-0000-4000-8000-000000000001', email: 'reviewer@example.com' }; next();
} }));
jest.mock('../../services/changelogEvidence', () => ({ ...jest.requireActual('../../services/changelogEvidence'), collectDraft: jest.fn(), sourceRepository: () => 'owner/repo' }));
jest.mock('../../utils/activityLogger', () => ({ logActivity: jest.fn() }));
const app = express(); app.use(express.json()); app.use('/api/changelog', changelog); app.use('/api/security-updates', securityUpdates);
const id = '00000000-0000-4000-8000-000000000002'; const auth = 'Bearer test-admin';
describe('Draft review routes', () => {
  beforeEach(() => jest.clearAllMocks());
  test.each(['/', '/config', `/${id}/history`])('requires admin for private read %s', async path => {
    expect((await request(app).get('/api/changelog' + path)).status).toBe(401);
    expect(supabase.from).not.toHaveBeenCalled();
  });
  test('cannot generate anonymously or list drafts through public updates', async () => {
    expect((await request(app).post('/api/changelog/generate').send({})).status).toBe(401);
    expect((await request(app).get('/api/security-updates?include_unpublished=true')).status).toBe(401);
    expect(collectDraft).not.toHaveBeenCalled(); expect(supabase.from).not.toHaveBeenCalled();
  });
  test.each([{ revision: 1, decision: 'publish', note: 'Reviewed' }, { revision: 1, decision: 'publish', note: '', confirm: true },
    { revision: 1, decision: 'publish', note: 'Reviewed', confirm: true, title: 'Unsaved replacement' }])('requires explicit review of saved text', async payload => {
    expect((await request(app).post(`/api/changelog/${id}/review`).set('Authorization', auth).send(payload)).status).toBe(400);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
  test('publishes via one atomic RPC bound to authenticated reviewer', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValue({ data: { id, state: 'published' }, error: null });
    expect((await request(app).post(`/api/changelog/${id}/review`).set('Authorization', auth).send({ revision: 2, decision: 'publish', note: 'Reviewed', confirm: true })).status).toBe(200);
    expect(supabase.rpc).toHaveBeenCalledWith('review_changelog_draft', expect.objectContaining({ p_revision: 2, p_actor_email: 'reviewer@example.com', p_action: 'publish', p_title: null, p_content: null }));
    expect(supabase.from).not.toHaveBeenCalled();
  });
  test('returns conflict without retrying stale approval', async () => {
    (supabase.rpc as jest.Mock).mockResolvedValue({ data: null, error: { code: '40001' } });
    expect((await request(app).post(`/api/changelog/${id}/review`).set('Authorization', auth).send({ revision: 1, decision: 'publish', note: 'Reviewed', confirm: true })).status).toBe(409);
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
  });
  test('editing cannot modify state, evidence or reviewer identity', async () => {
    expect((await request(app).patch(`/api/changelog/${id}`).set('Authorization', auth).send({ revision: 1, title: 'Title', content: 'Content', state: 'published', evidence: {} })).status).toBe(400);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
  test('legacy creation cannot attach unreviewed draft', async () => {
    expect((await request(app).post('/api/security-updates').set('Authorization', auth).send({ title: 'Title', content: 'Content', source_draft_id: id })).status).toBe(400);
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
