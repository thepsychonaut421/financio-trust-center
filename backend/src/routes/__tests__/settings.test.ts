import express from 'express';
import request from 'supertest';
import { supabase } from '../../server';
import settingsRoutes from '../settings';

jest.mock('../../server', () => ({ supabase: { from: jest.fn() } }));

const app = express();
app.use('/api/settings', settingsRoutes);

function mockSettings(data: Record<string, unknown> | null, error: unknown = null) {
  const select = jest.fn().mockReturnThis();
  (supabase.from as jest.Mock).mockReturnValue({
    select,
    limit: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data, error }),
  });
  return select;
}

describe('Public branding settings', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns branding but never administrator navigation or notification recipients', async () => {
    const select = mockSettings({
      company_name: 'Existing company',
      primary_color: '#012345',
      nda_url: '/approved-nda.pdf',
      notification_emails: ['private-admin@example.test'],
      admin_nav_order: ['users', 'settings'],
      updated_by: 'private-admin-id',
    });

    const response = await request(app).get('/api/settings');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      company_name: 'Existing company',
      primary_color: '#012345',
      nda_url: '/approved-nda.pdf',
    });
    expect(select.mock.calls[0][0]).not.toMatch(/notification_emails|admin_nav_order|updated_by/);
  });

  it('provides neutral Financio defaults only when there is no settings row', async () => {
    mockSettings(null);
    const response = await request(app).get('/api/settings');
    expect(response.status).toBe(200);
    expect(response.body.company_name).toBe('Financio Flow');
    expect(response.body.hero_subtitle).toBe('Security documents and approved updates for Financio Flow.');
    expect(response.body).not.toHaveProperty('certifications');
  });

  it('does not disguise a database failure as successful default settings', async () => {
    mockSettings(null, { message: 'Database unavailable' });
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await request(app).get('/api/settings');
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Internal server error' });
    } finally {
      errorLog.mockRestore();
    }
  });
});
