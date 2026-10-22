import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { log } from '../utils/logger.js';

let custom = null; // tests inject a capturing transport

export const setMailTransport = (t) => { custom = t; };
export const emailConfigured = () => !!custom || !!(env.resend.apiKey && env.resend.from);

export async function sendMail({ to, subject, text, html }) {
  if (!emailConfigured()) {
    throw new AppError(503, 'EMAIL_NOT_CONFIGURED', 'Email delivery is not configured on this server');
  }
  if (custom) {
    await custom.sendMail({ from: env.resend.from, to, subject, text, html });
  } else {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.resend.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: env.resend.from, to, subject, text, html }),
    });
    if (!response.ok) {
      throw new AppError(502, 'EMAIL_DELIVERY_FAILED', 'The email provider could not deliver the message');
    }
  }
  if (env.devLogEmailLinks) log.info(`[dev-email] to=${to} subject="${subject}"\n${text}`);
}
