import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { log } from '../utils/logger.js';

let custom = null; // tests inject a capturing transport
let smtp = null;

export const setMailTransport = (t) => { custom = t; };
export const emailConfigured = () => !!custom || !!(env.smtp.host && env.smtp.user && env.smtp.pass);

export async function sendMail({ to, subject, text, html }) {
  if (!emailConfigured()) {
    throw new AppError(503, 'EMAIL_NOT_CONFIGURED', 'Email delivery is not configured on this server');
  }
  const transport = custom || (smtp ||= nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.port === 465,
    auth: { user: env.smtp.user, pass: env.smtp.pass },
  }));
  await transport.sendMail({ from: env.smtp.from, to, subject, text, html });
  if (env.devLogEmailLinks) log.info(`[dev-email] to=${to} subject="${subject}"\n${text}`);
}
