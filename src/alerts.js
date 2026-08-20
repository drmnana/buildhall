// Error alerting — know when production breaks without watching the logs.
//
// captureError(context, err) logs every error and emails the first few per
// hour to ALERT_EMAIL (falls back to STORAGE_ALERT_EMAIL). The throttle is
// deliberately crude: an error storm sends at most MAX_EMAILS_PER_HOUR mails,
// each carrying a count of how many errors were swallowed since the last one.
//
// INERT-ish by default: with no alert email configured it still logs (the
// Render log stream keeps everything) and simply skips email — same
// graceful-degradation pattern as backups/classifier/storage.
import { sendEmail } from './email.js';

const ALERT_EMAIL = process.env.ALERT_EMAIL || process.env.STORAGE_ALERT_EMAIL || '';
const MAX_EMAILS_PER_HOUR = 3;

let windowStart = 0;
let emailsThisWindow = 0;
let suppressedSinceLastEmail = 0;

export function captureError(context, err) {
  const message = err?.stack || err?.message || String(err);
  console.error(`[error] ${context}:`, message);
  if (!ALERT_EMAIL) return;

  const now = Date.now();
  if (now - windowStart > 60 * 60 * 1000) {
    windowStart = now;
    emailsThisWindow = 0;
  }
  if (emailsThisWindow >= MAX_EMAILS_PER_HOUR) {
    suppressedSinceLastEmail += 1;
    return;
  }
  emailsThisWindow += 1;
  const suppressedNote = suppressedSinceLastEmail
    ? `\n\n(${suppressedSinceLastEmail} earlier errors were suppressed by the hourly email throttle — see the Render logs.)`
    : '';
  suppressedSinceLastEmail = 0;
  // fire-and-forget: alerting must never take the app down with it
  sendEmail({
    to: ALERT_EMAIL,
    subject: `BuildHall error: ${context}`,
    text: `${message}${suppressedNote}\n\nTime: ${new Date().toISOString()}`,
  }).catch((e) => console.error('[error] alert email failed:', e.message));
}

// Last-resort handlers. Express errors go through the route error handler;
// these catch everything that escapes it. After an uncaughtException the
// process state is suspect — log, alert, and let Render restart us.
export function installProcessHandlers() {
  process.on('unhandledRejection', (reason) => {
    captureError('unhandledRejection', reason);
  });
  process.on('uncaughtException', (err) => {
    captureError('uncaughtException', err);
    setTimeout(() => process.exit(1), 2000).unref();
  });
}
