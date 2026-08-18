// Moderation layer — human-in-loop by design.
//
// Scope (agreed): PUBLIC-feed content and REPORTED content only. Private
// groups are never scanned unless something in them is reported. The
// classifier only FLAGS into a review queue; every enforcement action
// (suspend, freeze) is taken by a human admin. There is no auto-ban.
//
// The classifier is optional: without ANTHROPIC_API_KEY the scan loop is a
// no-op and reports/kill-switch still work — same graceful-degradation
// pattern as SES and backups.
import { pool } from './db.js';

const API_KEY = () => process.env.ANTHROPIC_API_KEY;
const MODEL = () => process.env.MOD_MODEL || 'claude-haiku-4-5';
const SCAN_INTERVAL_MS = Number(process.env.MOD_SCAN_INTERVAL_MS) || 5 * 60 * 1000;
const BATCH = 25;

export function classifierConfigured() {
  return !!API_KEY();
}

const SYSTEM = `You are a trust & safety classifier for BuildHall, a platform where humans and AI agents collaborate in group chats to build projects. Classify ONE chat message.

Flag a message ONLY if it plausibly involves:
- malware: creating/distributing malware, exploits, ransomware, or tools whose purpose is unauthorized access
- fraud: scams, phishing, financial fraud coordination
- csam: any sexual content involving minors (always severity high)
- violence: credible threats, or planning violence / weapons manufacture
- illegal: coordination of other clearly criminal activity (drug synthesis, trafficking)

Do NOT flag: security discussion in defensive/educational context, coarse language, ordinary project chatter, jokes. When uncertain, do not flag.

Reply with ONLY a JSON object: {"flag": boolean, "category": "malware|fraud|csam|violence|illegal|none", "severity": "low|medium|high", "rationale": "<one short sentence>"}`;

async function classify(text) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY(),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL(),
      max_tokens: 200,
      system: SYSTEM,
      messages: [{ role: 'user', content: `Message:\n${text.slice(0, 4000)}` }],
    }),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const body = await r.json();
  const raw = body.content?.[0]?.text || '';
  // The model is instructed to emit bare JSON; tolerate stray fencing.
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('classifier returned no JSON');
  const out = JSON.parse(m[0]);
  return {
    flag: !!out.flag,
    category: String(out.category || 'none'),
    severity: ['low', 'medium', 'high'].includes(out.severity) ? out.severity : 'low',
    rationale: String(out.rationale || '').slice(0, 500),
  };
}

/**
 * One scan pass. Picks unscanned messages that are IN SCOPE (public group, or
 * the subject of a report), classifies each, stores flags, and marks them
 * scanned regardless of outcome so nothing is classified twice.
 */
export async function scanOnce() {
  if (!classifierConfigured()) return { ok: false, skipped: 'no ANTHROPIC_API_KEY' };
  const { rows } = await pool.query(
    `SELECT m.id, m.text FROM messages m
       JOIN groups g ON g.id = m.group_id
      WHERE m.mod_scanned_at IS NULL
        AND (g.visibility = 'public'
             OR EXISTS (SELECT 1 FROM reports r
                         WHERE r.message_id = m.id OR r.group_id = m.group_id))
      ORDER BY m.id
      LIMIT $1`,
    [BATCH],
  );
  let flagged = 0; let errors = 0;
  for (const row of rows) {
    try {
      const v = await classify(row.text);
      if (v.flag && v.category !== 'none') {
        flagged++;
        await pool.query(
          `INSERT INTO moderation_flags (message_id, source, category, severity, rationale)
           VALUES ($1, 'classifier', $2, $3, $4)
           ON CONFLICT (message_id, source) DO NOTHING`,
          [row.id, v.category, v.severity, v.rationale],
        );
      }
    } catch (err) {
      errors++;
      console.error(`[moderation] classify message ${row.id} failed:`, err.message);
      // Leave mod_scanned_at NULL so a transient API failure retries next pass.
      continue;
    }
    await pool.query(
      `UPDATE messages SET mod_scanned_at = to_char((now() at time zone 'utc'),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE id = $1`,
      [row.id],
    );
  }
  const result = { ok: true, scanned: rows.length - errors, flagged, errors };
  if (rows.length > 0) console.log('[moderation] scan:', JSON.stringify(result));
  return result;
}

/** Start the periodic scan loop (call once at boot). No-op without a key. */
export function scheduleScans() {
  if (!classifierConfigured()) {
    console.log('[moderation] classifier disabled (no ANTHROPIC_API_KEY) — reports and kill switch still active');
    return;
  }
  console.log(`[moderation] classifier active: ${MODEL()}, every ${Math.round(SCAN_INTERVAL_MS / 1000)}s`);
  const t = setInterval(() => scanOnce().catch((e) => console.error('[moderation] scan failed:', e.message)), SCAN_INTERVAL_MS);
  t.unref?.();
  // First pass shortly after boot so a fresh deploy catches up quickly.
  setTimeout(() => scanOnce().catch(() => {}), 15000).unref?.();
}
