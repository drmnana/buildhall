// Transactional email (verification + password reset).
//
// Driver is chosen by EMAIL_PROVIDER:
//   - 'ses'     : AWS SES v2 (production). Needs SES_REGION + SES_ACCESS_KEY_ID
//                 + SES_SECRET_ACCESS_KEY, and a verified sending domain.
//   - 'console' : logs the message instead of sending (local dev / tests).
//                 The default, so nothing breaks before SES is wired up.
//
// EMAIL_FROM is the From address (e.g. "BuildHall <noreply@buildhall.ai>").
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

const PROVIDER = process.env.EMAIL_PROVIDER || 'console';
const FROM = process.env.EMAIL_FROM || 'BuildHall <noreply@buildhall.ai>';

let sesClient = null;
function ses() {
  if (!sesClient) {
    sesClient = new SESv2Client({
      region: process.env.SES_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.SES_ACCESS_KEY_ID,
        secretAccessKey: process.env.SES_SECRET_ACCESS_KEY,
      },
    });
  }
  return sesClient;
}

/**
 * Send one email. Returns { ok, id?, error? }; never throws, so a mail failure
 * degrades gracefully (the caller decides whether that's fatal).
 */
export async function sendEmail({ to, subject, html, text }) {
  if (PROVIDER === 'console') {
    console.log(`\n[email:console] To: ${to}\nSubject: ${subject}\n${text || html}\n`);
    return { ok: true, id: 'console' };
  }
  try {
    const out = await ses().send(new SendEmailCommand({
      FromEmailAddress: FROM,
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: {
            Html: html ? { Data: html, Charset: 'UTF-8' } : undefined,
            Text: text ? { Data: text, Charset: 'UTF-8' } : undefined,
          },
        },
      },
    }));
    return { ok: true, id: out.MessageId };
  } catch (err) {
    console.error('[email] send failed:', err.message);
    return { ok: false, error: err.message };
  }
}

const BASE = (process.env.APP_BASE_URL || 'https://buildhall.ai').replace(/\/$/, '');

// A plain, deliverable HTML shell (inline styles; no external assets, which hurt
// deliverability and render). Kept minimal on purpose.
function shell(heading, body, cta) {
  return `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:480px;margin:0 auto;padding:32px 24px">
    <div style="background:#fff;border-radius:12px;padding:32px 28px">
      <h1 style="margin:0 0 8px;font-size:20px;color:#0f1e3d">${heading}</h1>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.5;color:#374151">${body}</p>
      ${cta}
      <p style="margin:20px 0 0;font-size:12px;color:#9ca3af">If you didn't request this, you can ignore this email.</p>
    </div>
    <p style="text-align:center;margin:16px 0 0;font-size:12px;color:#9ca3af">BuildHall</p>
  </div></body></html>`;
}

function button(href, label) {
  return `<a href="${href}" style="display:inline-block;background:#0f1e3d;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:15px;font-weight:600">${label}</a>`;
}

export function sendVerificationEmail(to, token) {
  const link = `${BASE}/verify?token=${encodeURIComponent(token)}`;
  return sendEmail({
    to,
    subject: 'Verify your BuildHall email',
    text: `Verify your email to finish setting up BuildHall:\n${link}\n\nThis link expires in 24 hours.`,
    html: shell('Verify your email', 'Confirm this address to finish setting up your BuildHall account. This link expires in 24 hours.', button(link, 'Verify email')),
  });
}

export function sendPasswordResetEmail(to, token) {
  const link = `${BASE}/reset?token=${encodeURIComponent(token)}`;
  return sendEmail({
    to,
    subject: 'Reset your BuildHall password',
    text: `Reset your BuildHall password:\n${link}\n\nThis link expires in 1 hour. If you didn't request it, ignore this email.`,
    html: shell('Reset your password', 'Click below to choose a new password. This link expires in 1 hour.', button(link, 'Reset password')),
  });
}
