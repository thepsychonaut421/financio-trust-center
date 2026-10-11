import { sendMagicLinkEmail } from '../email';
import { sendEmail } from '../../services/emailService';

jest.mock('../../services/emailService', () => ({ sendEmail: jest.fn().mockResolvedValue(undefined) }));

describe('Approval email public download URL', () => {
  it('uses the configured public API origin for encoded token/document paths, with no mail sent', async () => {
    const previousPublicUrl = process.env.BACKEND_PUBLIC_URL;
    const previousInternalUrl = process.env.API_URL;
    const previousFrontendUrl = process.env.FRONTEND_URL;
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    process.env.BACKEND_PUBLIC_URL = 'https://trust.financioflow.com';
    process.env.FRONTEND_URL = 'https://trust.financioflow.com';
    process.env.API_URL = 'http://backend:4000';
    const token = 'a1'.repeat(32);
    const documentId = '00000000-0000-4000-8000-000000000001';
    try {
      await sendMagicLinkEmail({
        requesterName: 'Test reviewer',
        requesterEmail: 'reviewer@example.test',
        documents: [{ id: documentId, title: 'Approved security document' }],
        magicLinkToken: token,
        magicLinkUrl: `https://trust.financioflow.com/access/${encodeURIComponent(token)}`,
        expirationDate: '2030-01-01',
      });

      expect(sendEmail).toHaveBeenCalledTimes(1);
      const message = (sendEmail as jest.Mock).mock.calls[0][0] as { html: string; attachments?: unknown };
      const links = Array.from(message.html.matchAll(/href="([^"]+)"/g), match => new URL(match[1]));
      const download = links.find(link => link.pathname.endsWith(`/download/${documentId}`));
      expect(download?.origin).toBe('https://trust.financioflow.com');
      expect(download?.pathname).toBe(`/api/access/${encodeURIComponent(token)}/download/${encodeURIComponent(documentId)}`);
      expect(links.every(link => link.origin === 'https://trust.financioflow.com')).toBe(true);
      expect(message.html).not.toMatch(/localhost|http:\/\/backend/);
      expect(message.attachments).toBeUndefined();
    } finally {
      for (const [name, value] of [['BACKEND_PUBLIC_URL', previousPublicUrl], ['API_URL', previousInternalUrl], ['FRONTEND_URL', previousFrontendUrl]]) {
        if (value === undefined) delete process.env[name!];
        else process.env[name!] = value;
      }
      log.mockRestore();
      jest.clearAllMocks();
    }
  });
});
