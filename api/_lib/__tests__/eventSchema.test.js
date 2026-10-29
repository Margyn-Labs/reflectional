/**
 * Event allowlist (ops console) — zero-dep. Run: node api/_lib/__tests__/eventSchema.test.js
 *
 * FAILS if an event payload can carry a disallowed key (amount, name, gstin,
 * text, email, phone, and their variants), checked three ways:
 *   1. the schema itself lists no such key,
 *   2. track() strips them before insert (supabaseRest faked, no network),
 *   3. a source scan of every track()/mtrack()/syncEvent() call site with a
 *      literal payload in api/ and app/js finds none, and every key it does
 *      find is listed for that event.
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail !== undefined ? '  :: ' + JSON.stringify(detail).slice(0, 600) : '')); }
}

const inserted = [];
require.cache[require.resolve('../supabaseRest')] = {
  id: 's', filename: 's', loaded: true,
  exports: { insertRows: async (table, rows) => { inserted.push({ table, rows }); return rows; } }
};

const S = require('../eventSchema');
const { track, ALLOWED_NAMES } = require('../track');

const MUST_REFUSE = ['amount', 'name', 'gstin', 'text', 'email', 'phone',
  'amount_inr', 'total_amount', 'vendor_name', 'customer_name', 'org_name', 'organization_name',
  'vendor_gstin', 'gstin_list', 'reply_text', 'owner_email', 'from_phone', 'phone_number',
  'message', 'body', 'raw_payload'];

(async () => {
  console.log('schema');
  for (const [ev, props] of Object.entries(S.EVENT_SCHEMA)) {
    const bad = Object.keys(props).filter((k) => S.DISALLOWED_KEY.test(k));
    check(`schema ${ev}: no disallowed key`, bad.length === 0, bad);
    for (const [k, spec] of Object.entries(props)) {
      const okSpec = Array.isArray(spec) ? spec.every((v) => typeof v === 'string' && /^[a-z0-9_]+$/.test(v)) : ['bool', 'count', 'slug'].includes(spec);
      if (!okSpec) check(`schema ${ev}.${k}: typed spec`, false, spec);
    }
  }
  for (const k of MUST_REFUSE) check(`DISALLOWED_KEY catches "${k}"`, S.DISALLOWED_KEY.test(k));
  check('track allowlist == schema names', [...ALLOWED_NAMES].sort().join() === Object.keys(S.EVENT_SCHEMA).sort().join());

  console.log('checkEventProps / sanitizeEventProps');
  for (const ev of Object.keys(S.EVENT_SCHEMA)) {
    for (const k of ['amount', 'name', 'gstin', 'text', 'email', 'phone']) {
      const r = S.checkEventProps(ev, { [k]: 'x' });
      if (r.ok) check(`checkEventProps(${ev}, {${k}}) must fail`, false, r);
      const clean = S.sanitizeEventProps(ev, { [k]: 'x' });
      if (k in clean) check(`sanitize(${ev}) must drop ${k}`, false, clean);
    }
  }
  check('disallowed keys rejected for every event (checked above)', true);
  check('unlisted key rejected', !S.checkEventProps('zoho_sync', { foo: 1 }).ok);
  check('enum value outside the list rejected', !S.checkEventProps('zoho_sync', { status: 'whatever' }).ok);
  check('count must be a whole number', !S.checkEventProps('zoho_sync', { rows_synced: -1 }).ok && !S.checkEventProps('zoho_sync', { rows_synced: '12' }).ok);
  check('slug refuses free text', !S.checkEventProps('tally_agent_sync', { kind: 'Pay Ramesh 5000' }).ok);
  check('slug refuses a phone / amount digit run', !S.checkEventProps('tally_agent_sync', { kind: 'p919800000001' }).ok);
  check('slug refuses an uppercase GSTIN', !S.checkEventProps('question_asked', { topic: '27AAPFU0939F1ZV' }).ok);
  check('slug refuses a lowercased GSTIN', !S.checkEventProps('question_asked', { topic: '27aapfu0939f1zv' }).ok);
  check('a valid zoho_sync payload passes', S.checkEventProps('zoho_sync', { ok: true, status: 'success', error_code: 'none', mode: 'delta', rows_synced: 1200, modules_failed: 0, duration_s: 41 }).ok);
  const mixed = S.sanitizeEventProps('zoho_sync', { ok: true, rows_synced: 12.6, amount: 5000, org_name: 'Acme', gstin: '27AAPFU0939F1ZV', error_code: 'Request failed for Acme Pvt Ltd' });
  check('sanitize keeps listed+valid, rounds counts, drops the rest', JSON.stringify(mixed) === JSON.stringify({ ok: true, rows_synced: 13 }), mixed);
  check('zohoErrorCode never echoes raw text', S.ZOHO_ERROR_CODES.includes(S.zohoErrorCode('Vendor Acme Pvt Ltd 27AAPFU0939F1ZV failed')));
  check('zohoErrorCode maps reauth', S.zohoErrorCode('needs_reauth: invalid_code') === 'needs_reauth');

  console.log('track() strips before insert');
  inserted.length = 0;
  await track('u-1', 'zoho_callback', { ok: true, error_code: 'none', org_count: 2, name: 'Acme', email: 'a@b.in', phone: '919800000001', gstin: '27AAPFU0939F1ZV', amount: 99, text: 'hello' });
  await track('u-1', 'ask_message_sent', { msg_len: 42, text: 'what is my cash', surface: 'panel' });
  await track('u-1', 'not_an_event', { ok: true });
  check('unknown event not inserted', inserted.length === 2, inserted.map((x) => x.rows[0].name));
  for (const { rows } of inserted) {
    const keys = Object.keys(rows[0].props);
    const bad = keys.filter((k) => S.DISALLOWED_KEY.test(k));
    check(`stored ${rows[0].name} props have no disallowed key`, bad.length === 0, rows[0].props);
    check(`stored ${rows[0].name} props pass the strict check`, S.checkEventProps(rows[0].name, rows[0].props).ok, rows[0].props);
  }

  console.log('call-site scan');
  const root = path.join(__dirname, '../../..');
  const files = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) { if (f.name !== '__tests__' && f.name !== 'node_modules') walk(p); }
      else if (/\.(m?js)$/.test(f.name)) files.push(p);
    }
  };
  walk(path.join(root, 'api'));
  walk(path.join(root, 'app', 'js'));

  // top-level keys of an object literal body: "a: 1, b, c: x ? 'p' : 'q'" -> [a, b, c]
  function literalKeys(body) {
    const parts = []; let depth = 0, cur = '', q = null;
    for (const ch of body) {
      if (q) { cur += ch; if (ch === q) q = null; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { q = ch; cur += ch; continue; }
      if ('([{'.includes(ch)) depth++;
      if (')]}'.includes(ch)) depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    return parts.map((p) => { const m = /^\s*([A-Za-z_$][\w$]*)\s*(:|$)/.exec(p.trim()); return m ? m[1] : null; }).filter(Boolean);
  }

  const CALLS = [
    // track(user, 'event', { ... })  and  mtrack('event', { ... })
    /\btrack\(\s*[^,()]+(?:\([^)]*\))?[^,()]*,\s*'([a-z0-9_]+)'\s*(?:,\s*\{([^}]*)\})?/g,
    /\bmtrack\(\s*'([a-z0-9_]+)'\s*(?:,\s*\{([^}]*)\})?/g
  ];
  const HELPERS = [[/\bsyncEvent\(\s*[^,]+,\s*\{([^}]*)\}/g, 'zoho_sync'], [/\borgSelectedEvent\(\s*[^,]+,[^,]+,[^,]+,\s*\{([^}]*)\}/g, 'zoho_org_selected']];
  let sites = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(root, f);
    const seen = [];
    for (const re of CALLS) { re.lastIndex = 0; let m; while ((m = re.exec(src))) seen.push([m[1], m[2] || '']); }
    for (const [re, ev] of HELPERS) { re.lastIndex = 0; let m; while ((m = re.exec(src))) seen.push([ev, m[1]]); }
    for (const [ev, body] of seen) {
      sites++;
      const keys = literalKeys(body);
      const bad = keys.filter((k) => S.DISALLOWED_KEY.test(k));
      check(`${rel}: ${ev} payload has no disallowed key`, bad.length === 0, { keys, bad });
      if (S.EVENT_SCHEMA[ev]) {
        const unlisted = keys.filter((k) => !(k in S.EVENT_SCHEMA[ev]));
        if (unlisted.length) check(`${rel}: ${ev} keys are all listed in eventSchema`, false, unlisted);
      }
    }
  }
  check('scan found the server-side Zoho funnel events', sites > 15, sites);
  const allSrc = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  for (const ev of ['zoho_connect_started', 'zoho_callback', 'zoho_org_selected', 'zoho_sync', 'zoho_gstr2b_sync']) {
    check(`${ev} is emitted somewhere`, allSrc.indexOf("'" + ev + "'") !== -1 && new RegExp("track\\([^;]*'" + ev + "'").test(allSrc));
  }

  console.log('SQL allowlist matches the schema');
  const sqlFile = ['sql/2026-10-29-ops-investor-funnel.sql', '2026-10-29-ops-investor-funnel.sql'].map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
  const sql = fs.readFileSync(sqlFile, 'utf8');
  const block = /product_events_name_allowlist check \(name in \(([\s\S]*?)\)\);/.exec(sql);
  const sqlNames = block ? block[1].match(/'([a-z0-9_]+)'/g).map((x) => x.slice(1, -1)).sort() : [];
  check('CHECK names == eventSchema names', sqlNames.join() === Object.keys(S.EVENT_SCHEMA).sort().join(), { sqlNames });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
