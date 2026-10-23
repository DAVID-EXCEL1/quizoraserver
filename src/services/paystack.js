import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';

export const paystackConfigured = () => !!env.paystack.secretKey;
export const paystackMode = () => (env.paystack.secretKey.startsWith('sk_live_') ? 'live' : env.paystack.secretKey.startsWith('sk_test_') ? 'test' : 'unknown');

async function call(method, path, body) {
  if (!paystackConfigured()) throw new AppError(503, 'PAYSTACK_NOT_CONFIGURED', 'Payments are not configured on this server');
  let res;
  try {
    res = await fetch(`${env.paystack.baseUrl}${path}`, {
      method, headers: { Authorization: `Bearer ${env.paystack.secretKey}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
    });
  } catch { throw new AppError(502, 'PAYSTACK_UNREACHABLE', 'Could not reach Paystack. Please try again.'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.status === false) throw new AppError(502, 'PAYSTACK_ERROR', json.message || 'Paystack rejected the request');
  return json.data;
}

const intervalFor = (i) => (i === 'yearly' ? 'annually' : 'monthly');

export const initTransaction = ({ email, amountMinor, currency, planCode, reference, callbackUrl, metadata }) =>
  call('POST', '/transaction/initialize', { email, amount: amountMinor, currency, plan: planCode, reference, callback_url: callbackUrl, metadata });
export const verifyTransaction = (reference) => call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
export const createPlan = ({ name, amountMinor, currency, interval }) => call('POST', '/plan', { name, amount: amountMinor, currency, interval: intervalFor(interval) });
export const updatePlan = (code, { name, amountMinor, interval }) => call('PUT', `/plan/${encodeURIComponent(code)}`, { name, amount: amountMinor, interval: intervalFor(interval), update_existing_subscriptions: false });
export const disableSubscription = ({ code, token }) => call('POST', '/subscription/disable', { code, token });

/** Paystack signs the raw body with HMAC-SHA512 using your secret key. */
export function validSignature(rawBody, signature) {
  if (!paystackConfigured() || !signature) return false;
  const expected = crypto.createHmac('sha512', env.paystack.secretKey).update(rawBody).digest('hex');
  const a = Buffer.from(expected); const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
