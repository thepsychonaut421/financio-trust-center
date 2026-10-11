import { sendMagicLinkEmail } from '../email';
import { sendEmail } from '../../services/emailService';
jest.mock('../../services/emailService', () => ({ sendEmail: jest.fn().mockResolvedValue(undefined) }));

it('delivers an escaped access-page link and never attaches restricted document bytes', async () => {
  await sendMagicLinkEmail({ requesterName: 'Owned <fixture>', requesterEmail: 'operator@example.test',
    documents: [{ id: 'document-id', title: 'Confidential <report>', filePath: '/must-not-read/secret.pdf', fileName: 'secret.pdf' }],
    magicLinkToken: 'test-link', magicLinkUrl: 'https://trust.example.test/access/test-link', expirationDate: '2026-10-12',
  });
  const sent = (sendEmail as jest.Mock).mock.calls[0][0];
  expect(sent).not.toHaveProperty('attachments');
  expect(sent.html).toContain('https://trust.example.test/access/test-link');
  expect(sent.html).toContain('Confidential &lt;report&gt;');
  expect(sent.html).not.toContain('/download/');
  expect(sent.html).not.toContain('/must-not-read/');
});
