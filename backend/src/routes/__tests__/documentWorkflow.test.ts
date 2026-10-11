import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { supabase } from '../../server';
import accessRoutes from '../access';
import requestRoutes from '../documentRequests';
import adminRequestRoutes from '../admin/requests';
import { sendMagicLinkEmail } from '../../utils/email';

jest.mock('../../utils/safePath', () => ({ resolveUploadPath: (name: string) => require('path').join(process.env.UPLOADS_DIR!, name) }));
jest.mock('../../server', () => ({ supabase: { from: jest.fn() } }));
jest.mock('../../middleware/auth', () => ({ requireAdmin: (req: any, _res: any, next: any) => {
  if (!req.headers.authorization) return _res.status(401).end();
  req.admin = { id: 'admin-id', email: 'operator@example.test' }; next();
} }));
jest.mock('../../middleware/documentUploadSecurity', () => ({ enforceDocumentUploadPolicy: (_req: any, _res: any, next: any) => next() }));
jest.mock('../../middleware/rateLimit', () => ({ emailRateLimit: (_req: any, _res: any, next: any) => next() }));
jest.mock('../../utils/activityLogger', () => ({ logActivity: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/webhookDispatcher', () => ({ dispatchWebhook: jest.fn() }));
jest.mock('../../utils/adminNotifications', () => ({ notifyAdminsOfNewRequest: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../utils/email', () => ({ sendMagicLinkEmail: jest.fn().mockResolvedValue(undefined), sendRejectionEmail: jest.fn().mockResolvedValue(undefined) }));

process.env.UPLOADS_DIR = os.tmpdir();
const documentRoutes = require('../documents').default;
const app = express();
app.use(express.json());
app.use('/api/access', accessRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/document-requests', requestRoutes);
app.use('/api/admin/document-requests', adminRequestRoutes);
const docId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const reqId = '33333333-3333-4333-8333-333333333333';
const token = 'test-only-link';
let tables: Record<string, any[]>;
let uploads: string;
let fileUrl: string;
let failDocumentUpdate = false;

// A small database fixture exercises the routes' state transitions without mail
// delivery or connecting to production. Filtering applies to writes as well.
function query(table: string) {
  const filters: ((row: any) => boolean)[] = [];
  let update: any;
  let insertion: any;
  const execute = () => {
    const rows = tables[table] || [];
    if (insertion) {
      const row = { id: reqId, ...insertion };
      rows.push(row); tables[table] = rows;
      return { data: [row], error: null };
    }
    const selected = rows.filter(row => filters.every(filter => filter(row)));
    if (update && table === 'documents' && failDocumentUpdate) return { data: [], error: { message: 'Fixture database failure' } };
    if (update) for (const row of selected) Object.assign(row, update);
    return { data: JSON.parse(JSON.stringify(selected)), error: null };
  };
  const q: any = {
    select: () => q, eq: (key: string, value: unknown) => { filters.push(row => row[key] === value); return q; },
    in: (key: string, values: unknown[]) => { filters.push(row => values.includes(row[key])); return q; },
    limit: () => q, order: () => q,
    insert: (data: any) => { insertion = data; return q; },
    update: (data: any) => { update = data; return q; },
    maybeSingle: async () => { const result = execute(); return { ...result, data: result.data[0] || null }; },
    single: async () => { const result = execute(); return { ...result, data: result.data[0] || null }; },
    then: (resolve: any) => Promise.resolve(execute()).then(resolve),
  };
  return q;
}

beforeEach(() => {
  jest.clearAllMocks(); failDocumentUpdate = false;
  uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-center-doc-test-'));
  process.env.UPLOADS_DIR = uploads;
  fileUrl = 'fixture.pdf';
  fs.writeFileSync(path.join(uploads, fileUrl), '%PDF-1.4\nOwned test document\n%%EOF');
  tables = {
    documents: [{ id: docId, title: 'Owned test document', file_url: fileUrl, file_name: fileUrl,
      file_type: 'application/pdf', access_level: 'restricted', status: 'published', is_current_version: true, requires_nda: false }],
    document_requests: [{ id: reqId, requester_email: 'operator@example.test', requester_name: 'Operator',
      document_ids: [docId], magic_link_token: token, magic_link_expires_at: new Date(Date.now() + 86400000).toISOString(), status: 'approved' }],
    organizations: [], nda_acceptances: [], trust_center_settings: [{ nda_url: '/nda-v1.pdf' }],
  };
  (supabase.from as jest.Mock).mockImplementation(query);
});
afterEach(() => { fs.rmSync(uploads, { recursive: true, force: true }); delete process.env.UPLOADS_DIR; });

describe('Restricted document workflow', () => {
  it('delivers only a document included in an active request', async () => {
    expect((await request(app).get(`/api/documents/${docId}/download`)).status).toBe(403);
    const response = await request(app).get(`/api/access/${token}/download/${docId}`);
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect((await request(app).get(`/api/access/${token}/download/${otherId}`)).status).toBe(403);
  });

  it.each(['magic_link_expires_at', 'access_expires_at'])('enforces %s on listing, download and acceptance', async field => {
    tables.document_requests[0][field] = new Date(Date.now() - 1000).toISOString();
    expect((await request(app).get(`/api/access/${token}`)).status).toBe(403);
    expect((await request(app).get(`/api/access/${token}/download/${docId}`)).status).toBe(403);
    expect((await request(app).post(`/api/access/${token}/accept-nda`).send({ nda_accepted: true, nda_url: '/nda-v1.pdf' })).status).toBe(403);
    expect(tables.nda_acceptances).toHaveLength(0);
  });

  it.each(['draft', 'archived'])('withdraws %s documents even from existing approved links', async status => {
    tables.documents[0].status = status;
    expect((await request(app).get(`/api/access/${token}`)).body.request.documents).toHaveLength(0);
    expect((await request(app).get(`/api/access/${token}/download/${docId}`)).status).toBe(404);
  });

  it('blocks expired documents and blocked organizations', async () => {
    tables.documents[0].expires_at = new Date(Date.now() - 1000).toISOString();
    expect((await request(app).get(`/api/access/${token}/download/${docId}`)).status).toBe(404);
    tables.document_requests[0].organization_id = 'org-id';
    tables.organizations = [{ id: 'org-id', status: 'no_access', is_active: true }];
    expect((await request(app).get(`/api/access/${token}`)).status).toBe(403);
    expect((await request(app).get(`/api/access/${token}/download/${docId}`)).status).toBe(403);
  });

  it('requires explicit acceptance tied to this request and the current agreement URL', async () => {
    tables.documents[0].requires_nda = true;
    const denied = await request(app).get(`/api/access/${token}/download/${docId}`);
    expect(denied.status).toBe(403); expect(denied.body).toEqual({ error: 'NDA_REQUIRED', nda_url: '/nda-v1.pdf' });
    tables.nda_acceptances.push({ email: 'operator@example.test' }); // A global email record never authorizes this request.
    expect((await request(app).post(`/api/access/${token}/accept-nda`).send({})).status).toBe(400);
    expect((await request(app).post(`/api/access/${token}/accept-nda`).send({ nda_accepted: true, nda_url: '/old.pdf' })).status).toBe(400);
    expect((await request(app).post(`/api/access/${token}/accept-nda`).send({ nda_accepted: true, nda_url: '/nda-v1.pdf' })).status).toBe(200);
    expect(tables.nda_acceptances[1]).toMatchObject({ request_id: reqId, nda_url: '/nda-v1.pdf' });
    expect((await request(app).get(`/api/access/${token}/download/${docId}`)).status).toBe(200);
    tables.trust_center_settings[0].nda_url = '/nda-v2.pdf';
    expect((await request(app).get(`/api/access/${token}/download/${docId}`)).body.error).toBe('NDA_REQUIRED');
  });

  it('rejects an unapproved sample agreement', async () => {
    tables.documents[0].requires_nda = true; tables.trust_center_settings[0].nda_url = '/nda-sample.html';
    expect((await request(app).get(`/api/access/${token}/download/${docId}`)).body.error).toBe('NDA_UNAVAILABLE');
    expect((await request(app).post(`/api/access/${token}/accept-nda`).send({ nda_accepted: true, nda_url: '/nda-sample.html' })).status).toBe(409);
  });

  it('revokes an approved link without sending another email', async () => {
    expect((await request(app).patch(`/api/admin/document-requests/${reqId}/revoke`).set('Authorization', 'Bearer test-admin')).status).toBe(200);
    expect((await request(app).get(`/api/access/${token}`)).status).toBe(404);
    expect((await request(app).get(`/api/access/${token}/download/${docId}`)).status).toBe(404);
    expect((await request(app).post(`/api/access/${token}/accept-nda`).send({ nda_accepted: true, nda_url: '/nda-v1.pdf' })).status).toBe(404);
    expect(sendMagicLinkEmail).not.toHaveBeenCalled();
  });

  it('keeps even whitelisted-domain requests pending until an administrator acts', async () => {
    tables.document_requests = [];
    tables.organizations = [{ id: 'org-id', email_domain: 'example.test', status: 'whitelisted', is_active: true }];
    const response = await request(app).post('/api/document-requests').send({ name: 'Test Operator', email: 'operator@example.test', company: 'Owned fixture', document_ids: [docId] });
    expect(response.status).toBe(200); expect(response.body.auto_approved).toBe(false);
    expect(tables.document_requests[0].status).toBe('pending');
    expect(tables.document_requests[0].magic_link_token).toBeUndefined();
    expect(sendMagicLinkEmail).not.toHaveBeenCalled();
  });

  it('does not accept requests for unpublished documents', async () => {
    tables.documents[0].status = 'draft';
    expect((await request(app).post('/api/document-requests').send({ name: 'Test Operator', email: 'operator@example.test', company: 'Owned fixture', document_ids: [docId] })).status).toBe(400);
  });

  it('checks blocked organizations before changing approval state, including batch decisions', async () => {
    tables.document_requests[0].status = 'pending'; tables.document_requests[0].organization_id = 'org-id';
    tables.document_requests[0].organizations = { status: 'no_access', is_active: true };
    const response = await request(app).patch(`/api/admin/document-requests/${reqId}/approve`).set('Authorization', 'Bearer test-admin').send({});
    expect(response.status).toBe(403); expect(tables.document_requests[0].status).toBe('pending');
    const batch = await request(app).post('/api/admin/document-requests/batch-approve').set('Authorization', 'Bearer test-admin').send({ request_ids: [reqId] });
    expect(batch.body.results[0].status).toBe('skipped');
    expect(sendMagicLinkEmail).not.toHaveBeenCalled();
  });

  it('sends one approval link after a pending decision, clamps expiry and rejects reapproval', async () => {
    tables.document_requests[0].status = 'pending';
    const response = await request(app).patch(`/api/admin/document-requests/${reqId}/approve`).set('Authorization', 'Bearer test-admin').send({ expiration_days: 1 });
    expect(response.status).toBe(200); expect(response.body.emailSent).toBe(true);
    expect(Date.parse(response.body.magic_link_expires_at) - Date.now()).toBeLessThanOrEqual(86400000);
    expect(sendMagicLinkEmail).toHaveBeenCalledTimes(1);
    expect((sendMagicLinkEmail as jest.Mock).mock.calls[0][0].documents).toEqual([{ id: docId, title: 'Owned test document' }]);
    expect((await request(app).patch(`/api/admin/document-requests/${reqId}/approve`).set('Authorization', 'Bearer test-admin').send({})).status).toBe(409);
    expect(sendMagicLinkEmail).toHaveBeenCalledTimes(1);
  });

  it('requires a reviewed agreement before publishing NDA material and allows an explicit ordinary publication', async () => {
    tables.documents[0].status = 'draft'; tables.documents[0].requires_nda = true;
    tables.trust_center_settings[0].nda_url = null;
    const blocked = await request(app).patch(`/api/documents/${docId}`).set('Authorization', 'Bearer test-admin').send({ status: 'published' });
    expect(blocked.status).toBe(409); expect(tables.documents[0].status).toBe('draft');
    const published = await request(app).patch(`/api/documents/${docId}`).set('Authorization', 'Bearer test-admin').send({ status: 'published', requires_nda: false, expires_at: null });
    expect(published.status).toBe(200); expect(published.body.published_at).toBeTruthy();
  });

  it('saves replacement files as drafts and withdraws the previous approval link', async () => {
    const response = await request(app).put(`/api/documents/${docId}/replace`).set('Authorization', 'Bearer test-admin')
      .field('status', 'published').attach('file', Buffer.from('%PDF-1.4\nOwned replacement\n%%EOF'), { filename: 'replacement.pdf', contentType: 'application/pdf' });
    expect(response.status).toBe(200); expect(response.body.status).toBe('draft');
    expect(fs.existsSync(path.join(uploads, fileUrl))).toBe(false);
    expect((await request(app).get(`/api/access/${token}/download/${docId}`)).status).toBe(404);
  });

  it('keeps the previous file if saving replacement metadata fails', async () => {
    failDocumentUpdate = true;
    const response = await request(app).put(`/api/documents/${docId}/replace`).set('Authorization', 'Bearer test-admin')
      .attach('file', Buffer.from('%PDF-1.4\nOwned replacement\n%%EOF'), { filename: 'replacement.pdf', contentType: 'application/pdf' });
    expect(response.status).toBe(500);
    expect(fs.existsSync(path.join(uploads, fileUrl))).toBe(true);
    expect(tables.documents[0].file_url).toBe(fileUrl);
    expect(fs.readdirSync(path.join(uploads, 'uncategorized'))).toHaveLength(0);
  });

  it('uploads a draft even when a caller supplies published, and keeps its preview private', async () => {
    const response = await request(app).post('/api/documents').set('Authorization', 'Bearer test-admin')
      .field('title', 'Prepared policy').field('access_level', 'restricted').field('status', 'published')
      .attach('file', Buffer.from('%PDF-1.4\nOwned draft\n%%EOF'), { filename: 'draft.pdf', contentType: 'application/pdf' });
    expect(response.status).toBe(201); expect(response.body.status).toBe('draft'); expect(response.body.published_at).toBeNull();
    expect((await request(app).get(`/api/documents/${response.body.id}/download`)).status).toBe(404);
    expect((await request(app).get(`/api/documents/${response.body.id}/admin-download`)).status).toBe(401);
    expect((await request(app).get(`/api/documents/${response.body.id}/admin-download`).set('Authorization', 'Bearer test-admin')).status).toBe(200);
  });
});
