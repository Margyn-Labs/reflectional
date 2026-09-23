/**
 * api/_lib/cfoPack.js — monthly CFO pack delivery (HANDOFF-NEXT-THREE §3b).
 *
 * What is sent: an HTML email with the month's key numbers and Margyn's
 * commentary, plus a link to the full pack in the app (login required). No
 * attachment: a server-rendered PDF needs a rendering dependency, and the app
 * already saves a clean A4 PDF from the pack page.
 *
 * Schedule and recipients live on the account, in
 *   profiles.preferences.cfo_pack = { enabled, day_of_month (1-28), recipients:[{name,email}], sections:[...] }
 * set from the CFO pack page. The pack covers the previous calendar month (IST).
 *
 * The daily cron (/api/ops?action=cron-cfo-pack) sends to every account whose
 * day has come this month and that hasn't been sent yet for that month and
 * recipient. "Day has come" (not "is today") means a skipped cron run or a
 * failed send is picked up the next day. Every send is logged to
 * report_deliveries; a partial unique index there makes a second 'sent' row
 * for the same account / month / recipient impossible.
 *
 * Fails closed: if report_deliveries can't be read, nothing is sent (we
 * couldn't tell what was already sent).
 *
 * Provider: Resend (REST, plain fetch). Env: RESEND_API_KEY, CFO_PACK_FROM
 * (e.g. "Margyn <reports@margynlabs.com>", a verified domain), APP_URL
 * (defaults to https://www.margynlabs.com/app.html).
 *
 * Pure builders are exported for the zero-dep test in __tests__/cfoPack.test.js.
 */

const IST_MS = 5.5 * 3600000;
const MAX_RECIPIENTS = 10;
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/* ---------- dates (IST) ---------- */
function istParts(now) {
  const d = new Date(now.getTime() + IST_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
function periodKey(y, m) { return y + '-' + String(m).padStart(2, '0'); }
/** The month the pack covers: the calendar month before `now`, in IST. */
function previousPeriod(now) {
  const { y, m } = istParts(now);
  return m === 1 ? periodKey(y - 1, 12) : periodKey(y, m - 1);
}
function shiftPeriod(period, by) {
  const [y, m] = period.split('-').map(Number);
  const t = (y * 12 + (m - 1)) + by;
  return periodKey(Math.floor(t / 12), (t % 12) + 1);
}
/** UTC ISO bounds of an IST calendar month: [start, end). */
function periodBounds(period) {
  const [y, m] = period.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1) - IST_MS).toISOString();
  const [ny, nm] = shiftPeriod(period, 1).split('-').map(Number);
  const end = new Date(Date.UTC(ny, nm - 1, 1) - IST_MS).toISOString();
  return { start, end };
}
function periodLabel(period) { const [y, m] = period.split('-').map(Number); return MONTHS[m - 1] + ' ' + y; }
function isPeriod(p) { return typeof p === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(p); }
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + IST_MS);
  return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()].slice(0, 3) + ' ' + d.getUTCFullYear();
}

/* ---------- money ---------- */
function inr(n) {
  const v = Math.round(Number(n) || 0);
  return (v < 0 ? '−' : '') + '₹' + Math.abs(v).toLocaleString('en-IN');
}
function inrShort(n) {
  const v = Number(n) || 0, a = Math.abs(v), s = v < 0 ? '−' : '';
  if (a >= 1e7) return s + '₹' + (a / 1e7).toFixed(2).replace(/\.?0+$/, '') + ' Cr';
  if (a >= 1e5) return s + '₹' + (a / 1e5).toFixed(1).replace(/\.0$/, '') + ' L';
  return inr(v);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- config ---------- */
/** Normalise profiles.preferences.cfo_pack; invalid recipients are dropped. */
function packConfig(prefs) {
  const c = (prefs && prefs.cfo_pack) || {};
  const seen = new Set();
  const recipients = (Array.isArray(c.recipients) ? c.recipients : [])
    .map((r) => ({ name: String((r && r.name) || '').trim().slice(0, 80), email: String((r && r.email) || '').trim().toLowerCase() }))
    .filter((r) => EMAIL_RE.test(r.email) && !seen.has(r.email) && seen.add(r.email))
    .slice(0, MAX_RECIPIENTS);
  const day = Math.min(28, Math.max(1, parseInt(c.day_of_month, 10) || 1));
  return { enabled: c.enabled === true, day, recipients };
}
function isDue(cfg, now) { return cfg.enabled && cfg.recipients.length > 0 && istParts(now).day >= cfg.day; }

/* ---------- the email ---------- */
function pct(now, prev) { return prev ? ((now - prev) / Math.abs(prev)) * 100 : null; }
function buildEmail({ company, period, snap, prev, link, recipientName }) {
  const label = periodLabel(period);
  const margin = snap.revenue ? (Number(snap.net_profit) / Number(snap.revenue)) * 100 : null;
  const rows = [
    ['Cash at month end', snap.cash, prev && prev.cash, true],
    ['Revenue', snap.revenue, prev && prev.revenue, true],
    ['Net profit', snap.net_profit, prev && prev.net_profit, true],
    ['Receivables outstanding', snap.recv_total, prev && prev.recv_total, false],
    ['Of which 90+ days', snap.recv_90, prev && prev.recv_90, false],
    ['Payables due in 30 days', snap.pay_soon, prev && prev.pay_soon, false],
    ['GST payable', snap.gst_payable, prev && prev.gst_payable, false]
  ];
  const chg = (a, b, goodUp) => {
    const p = pct(Number(a), Number(b));
    if (p === null || !isFinite(p)) return '<span style="color:#8B93A0">—</span>';
    const good = Math.abs(p) < 0.05 ? null : (p > 0) === goodUp;
    const col = good === null ? '#5B6472' : good ? '#0E8F5C' : '#B3432E';
    return '<span style="color:' + col + '">' + (p > 0 ? '▲ ' : p < 0 ? '▼ ' : '') + Math.abs(p).toFixed(1) + '%</span>';
  };
  const scope = esc(company) + ' · Reconciled · ' + esc(label) + ' · closing reading ' + esc(fmtDate(snap.created_at));
  const td = 'padding:8px 10px;border-bottom:1px solid #ECEAE4;font-size:13px;';
  const num = td + "text-align:right;font-family:'IBM Plex Mono',Menlo,monospace;white-space:nowrap;";
  const html =
    '<!doctype html><html><body style="margin:0;background:#FAFAF8;font-family:Manrope,Segoe UI,Arial,sans-serif;color:#14181F">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAF8;padding:24px 12px"><tr><td align="center">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border:1px solid #E4E1DA;border-radius:8px">' +
    '<tr><td style="padding:24px 24px 8px"><div style="font-weight:800;color:#0E8F5C;font-size:16px">margyn</div>' +
      '<div style="font-size:22px;font-weight:800;margin-top:14px">' + esc(label) + ' CFO pack</div>' +
      '<div style="font-size:13px;color:#5B6472;margin-top:4px">' + (recipientName ? 'Hi ' + esc(recipientName) + ', here' : 'Here') + ' is the monthly summary for ' + esc(company) + '.</div>' +
      "<div style=\"font-size:12px;color:#8B93A0;margin-top:10px;font-family:'IBM Plex Mono',Menlo,monospace\">" + scope + '</div></td></tr>' +
    '<tr><td style="padding:8px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">' +
      '<tr><th align="left" style="' + td + 'font-size:12px;color:#5B6472">Figure</th><th align="right" style="' + td + 'font-size:12px;color:#5B6472">' + esc(label.split(' ')[0]) + ' (₹)</th><th align="right" style="' + td + 'font-size:12px;color:#5B6472">vs prior month</th></tr>' +
      rows.map(([k, a, b, goodUp]) => '<tr><td style="' + td + '">' + esc(k) + '</td><td style="' + num + '">' + esc(inr(a).replace('₹', '')) + '</td><td style="' + num + '">' + chg(a, b, goodUp) + '</td></tr>').join('') +
      '<tr><td style="' + td + '">Net margin</td><td style="' + num + '">' + (margin === null ? '—' : margin.toFixed(1) + '%') + '</td><td style="' + num + '"></td></tr>' +
      '<tr><td style="' + td + '">Pulse Score <span style="color:#8B93A0">(operating health, not a credit score)</span></td><td style="' + num + '">' + esc(snap.pulse_score == null ? '—' : snap.pulse_score) + '</td><td style="' + num + '">' +
        (prev && prev.pulse_score != null && snap.pulse_score != null ? esc((snap.pulse_score - prev.pulse_score > 0 ? '+' : '') + (snap.pulse_score - prev.pulse_score) + ' pts') : '') + '</td></tr>' +
    '</table></td></tr>' +
    (snap.briefing ? '<tr><td style="padding:16px 24px 0"><div style="border:1px solid #F3D9CE;background:#FBEFEA;border-radius:8px;padding:14px 16px">' +
      '<div style="font-size:12px;font-weight:700;color:#CC5B34">Written by Margyn</div><div style="font-size:13px;line-height:1.55;margin-top:6px">' + esc(snap.briefing) + '</div></div></td></tr>' : '') +
    '<tr><td style="padding:20px 24px"><a href="' + esc(link) + '" style="display:inline-block;background:#0E8F5C;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 16px;border-radius:6px">Open the full pack</a>' +
      '<div style="font-size:12px;color:#8B93A0;margin-top:8px">Cash by source, receivables ageing, payables, GST and the 13-week forecast. You’ll be asked to log in.</div></td></tr>' +
    '<tr><td style="padding:16px 24px 24px;border-top:1px solid #ECEAE4;font-size:12px;color:#8B93A0;line-height:1.5">' +
      'Figures are from ' + esc(company) + '’s closing Margyn reading for ' + esc(label) + ', each taken from its most trusted connected source. Figures from different sources are never added together.<br>' +
      'You get this because ' + esc(company) + ' added you to its monthly CFO pack in Margyn. To stop it, ask them to remove you under CFO pack → Delivery.</td></tr>' +
    '</table></td></tr></table></body></html>';
  const text = label + ' CFO pack: ' + company + '\n' + scope.replace(/&amp;/g, '&') + '\n\n' +
    rows.map(([k, a]) => k + ': ' + inr(a)).join('\n') + '\nNet margin: ' + (margin === null ? '—' : margin.toFixed(1) + '%') +
    '\nPulse Score (operating health, not a credit score): ' + (snap.pulse_score == null ? '—' : snap.pulse_score) +
    (snap.briefing ? '\n\nWritten by Margyn:\n' + snap.briefing : '') + '\n\nOpen the full pack (login required): ' + link + '\n';
  return { subject: label + ' CFO pack · ' + company, html, text };
}
function packLink(period) {
  const base = process.env.APP_URL || 'https://www.margynlabs.com/app.html';
  return base + '#/cfo-pack?period=' + period;
}

/* ---------- data ---------- */
const SNAP_COLS = 'created_at,cash,revenue,net_profit,burn,gst_payable,gst_leak,recv_total,recv_90,pay_soon,pulse_score,confidence,briefing,briefing_generated_at';
async function closingSnapshot(selectRows, userId, period) {
  const { start, end } = periodBounds(period);
  const rows = await selectRows('snapshots', 'select=' + SNAP_COLS + '&user_id=eq.' + encodeURIComponent(userId) +
    '&created_at=gte.' + encodeURIComponent(start) + '&created_at=lt.' + encodeURIComponent(end) + '&order=created_at.desc&limit=1');
  return rows[0] || null;
}

/* ---------- sending ---------- */
async function sendViaResend(fetchImpl, { to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.CFO_PACK_FROM || 'Margyn <reports@margynlabs.com>';
  const r = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html, text })
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Resend ' + r.status + ': ' + (body.message || body.error || 'send failed'));
  return body.id || null;
}
async function logDelivery(insertRows, row) {
  try { await insertRows('report_deliveries', [row]); return true; }
  catch (e) { console.error('[cfo-pack] log failed:', e.message); return false; }
}

/**
 * Daily run. deps = { selectRows, insertRows, fetch, now }.
 * opts = { userId (only this account), force (ignore the day of month) }.
 */
async function runCron(deps, opts = {}) {
  const now = deps.now || new Date();
  if (!process.env.RESEND_API_KEY) return { ok: false, reason: 'RESEND_API_KEY not configured', sent: 0 };
  try { await deps.selectRows('report_deliveries', 'select=id&limit=1'); }
  catch (e) { return { ok: false, reason: 'report_deliveries table not readable; run 2026-09-24-report-deliveries.sql', sent: 0 }; }

  const period = previousPeriod(now);
  let profiles;
  try {
    profiles = await deps.selectRows('profiles', 'select=id,company_name,preferences&preferences->cfo_pack->>enabled=eq.true' +
      (opts.userId ? '&id=eq.' + encodeURIComponent(opts.userId) : ''));
  } catch (e) { return { ok: false, reason: 'profiles.preferences not readable; run 2026-09-24-profile-preferences.sql', sent: 0 }; }

  const out = { ok: true, period, accounts: 0, sent: 0, failed: 0, skipped: [] };
  for (const p of profiles) {
    const cfg = packConfig(p.preferences);
    if (!cfg.enabled || !cfg.recipients.length) continue;
    if (!opts.force && !isDue(cfg, now)) continue;
    out.accounts++;
    let done;
    try {
      const rows = await deps.selectRows('report_deliveries', 'select=recipient_email&user_id=eq.' + encodeURIComponent(p.id) +
        '&report=eq.cfo_pack&period=eq.' + period + '&kind=eq.scheduled&status=eq.sent');
      done = new Set(rows.map((r) => r.recipient_email));
    } catch (e) { out.skipped.push({ user_id: p.id, reason: 'could not read past deliveries' }); continue; }
    const todo = cfg.recipients.filter((r) => !done.has(r.email));
    if (!todo.length) continue;
    const snap = await closingSnapshot(deps.selectRows, p.id, period);
    if (!snap) { out.skipped.push({ user_id: p.id, reason: 'no reading in ' + period }); continue; }
    const prev = await closingSnapshot(deps.selectRows, p.id, shiftPeriod(period, -1));
    const company = p.company_name || 'Your business';
    for (const r of todo) {
      const mail = buildEmail({ company, period, snap, prev, link: packLink(period), recipientName: r.name });
      const row = { user_id: p.id, report: 'cfo_pack', period, kind: 'scheduled', recipient_email: r.email, recipient_name: r.name || null, provider: 'resend' };
      try {
        const id = await sendViaResend(deps.fetch, { to: r.email, ...mail });
        out.sent++;
        await logDelivery(deps.insertRows, { ...row, status: 'sent', provider_message_id: id });
      } catch (e) {
        out.failed++;
        await logDelivery(deps.insertRows, { ...row, status: 'failed', error: String(e.message).slice(0, 500) });
      }
    }
  }
  return out;
}

/** "Send a test to me": the signed-in user's own email only, at most 5 a day. */
async function sendTest(deps, { user, period }) {
  const now = deps.now || new Date();
  if (!process.env.RESEND_API_KEY) return { status: 503, body: { error: 'Email delivery is not set up yet.' } };
  if (!user || !user.email) return { status: 401, body: { error: 'Unauthorized' } };
  const per = isPeriod(period) ? period : previousPeriod(now);
  let recent;
  try {
    recent = await deps.selectRows('report_deliveries', 'select=id&user_id=eq.' + encodeURIComponent(user.id) + '&kind=eq.test&created_at=gte.' +
      encodeURIComponent(new Date(now.getTime() - 86400000).toISOString()));
  } catch (e) { return { status: 503, body: { error: 'Delivery log is not set up yet.' } }; }
  if (recent.length >= 5) return { status: 429, body: { error: 'That’s five test emails today. Try again tomorrow.' } };
  const [prof] = await deps.selectRows('profiles', 'select=company_name&id=eq.' + encodeURIComponent(user.id));
  const snap = await closingSnapshot(deps.selectRows, user.id, per);
  if (!snap) return { status: 404, body: { error: 'There’s no reading for ' + periodLabel(per) + ' yet.' } };
  const prev = await closingSnapshot(deps.selectRows, user.id, shiftPeriod(per, -1));
  const mail = buildEmail({ company: (prof && prof.company_name) || 'Your business', period: per, snap, prev, link: packLink(per) });
  mail.subject = '[Test] ' + mail.subject;
  const row = { user_id: user.id, report: 'cfo_pack', period: per, kind: 'test', recipient_email: String(user.email).toLowerCase(), provider: 'resend' };
  try {
    const id = await sendViaResend(deps.fetch, { to: user.email, ...mail });
    await logDelivery(deps.insertRows, { ...row, status: 'sent', provider_message_id: id });
    return { status: 200, body: { ok: true, to: user.email, period: per } };
  } catch (e) {
    await logDelivery(deps.insertRows, { ...row, status: 'failed', error: String(e.message).slice(0, 500) });
    return { status: 502, body: { error: 'The email provider refused the send. Check the sending domain and key.' } };
  }
}

module.exports = {
  runCron, sendTest, buildEmail, packConfig, isDue, previousPeriod, shiftPeriod, periodBounds, periodLabel, inr, inrShort, isPeriod
};
