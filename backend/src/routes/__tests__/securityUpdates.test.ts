import express from 'express';
import request from 'supertest';
import { supabase } from '../../server';
import securityUpdates from '../securityUpdates';

jest.mock('../../server', () => ({ supabase: { from: jest.fn() } }));
jest.mock('../../utils/activityLogger', () => ({ logActivity: jest.fn() }));
const app = express();
app.use('/api/security-updates', securityUpdates);

describe('Public changelog output', () => {
  test('preserves approved text and legacy HTML formats without leaking private evidence', async () => {
    const approvedText = 'Keep <approved wording> literal.\n\nSecond paragraph.';
    const query = {
      select: jest.fn().mockReturnThis(), not: jest.fn().mockReturnThis(), lte: jest.fn().mockReturnThis(),
      order: jest.fn().mockResolvedValue({ error: null, data: [
        { id: 'assisted', title: 'Reviewed update', content: approvedText, source_draft_id: 'private-id', evidence: { internal: 'private' } },
        { id: 'legacy', title: 'Manual update', content: '<p>Legacy paragraph</p>', source_draft_id: null },
      ] }),
    };
    (supabase.from as jest.Mock).mockReturnValue(query);
    const result = await request(app).get('/api/security-updates');
    expect(result.status).toBe(200);
    expect(result.body).toEqual([
      { id: 'assisted', title: 'Reviewed update', content: approvedText, content_format: 'plain_text' },
      { id: 'legacy', title: 'Manual update', content: '<p>Legacy paragraph</p>', content_format: 'html' },
    ]);
    expect(query.not).toHaveBeenCalledWith('published_at', 'is', null);
    expect(query.lte).toHaveBeenCalledWith('published_at', expect.any(String));
  });
});
