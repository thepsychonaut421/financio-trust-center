const mockResendSend = jest.fn();
const mockSendGridSend = jest.fn();
const mockSmtpSend = jest.fn();

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: mockResendSend } })),
}));
jest.mock('@sendgrid/mail', () => ({
  __esModule: true,
  default: { setApiKey: jest.fn(), send: mockSendGridSend },
}));
jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: jest.fn(() => ({ sendMail: mockSmtpSend })) },
}));

describe('Email reply routing', () => {
  const names = ['EMAIL_PROVIDER', 'EMAIL_REPLY_TO', 'RESEND_API_KEY',
    'SENDGRID_API_KEY', 'SMTP_USER', 'SMTP_PASSWORD', 'NODE_ENV', 'DEMO_MODE'];
  const message = Object.freeze({
    to: 'reviewer@example.test', from: 'sender@notify.example.test',
    subject: 'Requested document', html: '<p>Approved document link</p>',
  });
  let previous: Record<string, string | undefined>;
  let sendEmail: typeof import('../emailService').sendEmail;

  beforeEach(() => {
    previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
    jest.resetModules();
    jest.clearAllMocks();
    Object.assign(process.env, {
      EMAIL_PROVIDER: 'resend', EMAIL_REPLY_TO: 'catchall@financioflow.com',
      RESEND_API_KEY: 'test-only', SENDGRID_API_KEY: 'test-only',
      SMTP_USER: 'test-only', SMTP_PASSWORD: 'test-only',
      NODE_ENV: 'production', DEMO_MODE: 'false',
    });
    mockResendSend.mockResolvedValue({ data: { id: 'test-message' }, error: null });
    mockSendGridSend.mockResolvedValue([{ statusCode: 202 }]);
    mockSmtpSend.mockResolvedValue({});
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    sendEmail = require('../emailService').sendEmail;
  });

  afterEach(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    jest.restoreAllMocks();
  });

  test.each(['resend', 'sendgrid', 'smtp', 'mailpit'])(
    'routes replies to the monitored mailbox through %s without changing the sender',
    async provider => {
      process.env.EMAIL_PROVIDER = provider;
      await sendEmail(message);
      const transport = provider === 'resend' ? mockResendSend
        : provider === 'sendgrid' ? mockSendGridSend : mockSmtpSend;
      expect(transport).toHaveBeenCalledTimes(1);
      expect(transport).toHaveBeenCalledWith(expect.objectContaining({
        ...message, replyTo: 'catchall@financioflow.com',
      }));
      expect(message).not.toHaveProperty('replyTo');
    },
  );

  test('allows an explicit message reply address to override the configured default', async () => {
    await sendEmail({ ...message, replyTo: 'support@example.test' });
    expect(mockResendSend).toHaveBeenCalledWith(expect.objectContaining({
      replyTo: 'support@example.test', from: message.from,
    }));
  });

  test('preserves delivery without a reply-to setting', async () => {
    delete process.env.EMAIL_REPLY_TO;
    await sendEmail(message);
    expect(mockResendSend).toHaveBeenCalledTimes(1);
    expect(mockResendSend.mock.calls[0][0].replyTo).toBeUndefined();
  });

  test.each(['not-an-email', 'catchall@financioflow.com\r\nBcc: other@example.test'])(
    'rejects an invalid configured reply address before contacting a provider: %j',
    async replyTo => {
      process.env.EMAIL_REPLY_TO = replyTo;
      await expect(sendEmail(message)).rejects.toThrow('Invalid reply-to email address format');
      expect(mockResendSend).not.toHaveBeenCalled();
      expect(mockSendGridSend).not.toHaveBeenCalled();
      expect(mockSmtpSend).not.toHaveBeenCalled();
    },
  );
});
