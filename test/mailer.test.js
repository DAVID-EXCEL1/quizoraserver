import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let emailConfigured;
let sendMail;

beforeAll(async () => {
  vi.stubEnv('RESEND_API_KEY', 're_test_key');
  vi.stubEnv('RESEND_FROM_EMAIL', 'DextQuiz <no-reply@example.com>');
  ({ emailConfigured, sendMail } = await import('../src/services/mailer.js'));
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Resend mail transport', () => {
  it('sends messages through the Resend API', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    expect(emailConfigured()).toBe(true);
    await sendMail({ to: 'host@example.com', subject: 'Verify', text: 'Text', html: '<p>Text</p>' });

    expect(fetchMock).toHaveBeenCalledWith('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer re_test_key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'DextQuiz <no-reply@example.com>',
        to: 'host@example.com',
        subject: 'Verify',
        text: 'Text',
        html: '<p>Text</p>',
      }),
    });
  });

  it('surfaces provider delivery failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    await expect(sendMail({ to: 'host@example.com', subject: 'Verify', text: 'Text', html: '<p>Text</p>' }))
      .rejects.toMatchObject({ status: 502, code: 'EMAIL_DELIVERY_FAILED' });
  });
});
