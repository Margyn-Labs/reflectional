#!/usr/bin/env node
/**
 * Margyn Tally Agent — PROTOTYPE
 *
 * Commands:
 *   node agent.js pair        Pair this machine with a Margyn account using a
 *                             one-time code generated in the Margyn app.
 *   node agent.js tally-check  Hit TallyPrime and print the ledger list. No cloud
 *                             call — use this to confirm Tally connectivity first.
 *   node agent.js sync         Run one sync (Phase 1: ledger closing balances).
 *                             Add --dry-run to print the payload instead of sending.
 *   node agent.js run          Sync now, then every SYNC_INTERVAL_MINUTES.
 *
 * Config + install key live in a per-user file — see config.js for the path.
 *
 * NOT DONE in this prototype: Windows service wrapping, installer, code signing,
 * auto-update, vouchers (Phase 2), bill-wise outstanding (Phase 3), UTF-16
 * response handling beyond basic UTF-8, retry/backoff queue for offline periods.
 */

const os = require('os');
const fs = require('fs');
const readline = require('readline');
const config = require('./config');
const tally = require('./tallyClient');
const cloud = require('./cloud');
const voucherSync = require('./voucherSync');

const AGENT_VERSION = require('./package.json').version;

// The desktop app routes these lines into its own activity log via setLogger.
let logSink = null;
function log(...a) {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  if (logSink) { try { logSink(line); } catch (e) { /* never let logging break a sync */ } }
  console.log(`[${new Date().toISOString()}]`, line);
}
function setLogger(fn) { logSink = typeof fn === 'function' ? fn : null; }

/** Semver-ish compare: -1 / 0 / 1. '0.1.0-prototype' counts as 0.1.0. */
function compareVersions(a, b) {
  const p = (v) => (String(v || '0').match(/\d+/g) || ['0']).slice(0, 3).map(Number).concat([0, 0, 0]).slice(0, 3);
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/**
 * Apply a one-off command Margyn sent for this PC. Returns true if the next sync should run now.
 *   resync       forget sync progress; re-read the whole financial year from Tally
 *   recalibrate  re-test how to read vouchers on this Tally (after an agent fix)
 * The per-PC crash guard (which requests upset this Tally) is always kept.
 */
function applyCommand(cmd) {
  const action = cmd && cmd.action;
  const st = config.load().syncState || {};
  const keep = { blockedRequests: st.blockedRequests || [], provenRequests: st.provenRequests || [] };
  if (action === 'resync') { config.save({ syncState: keep }); log('Margyn asked for a full re-sync from Tally. Starting now.'); return true; }
  if (action === 'recalibrate') { config.save({ syncState: Object.assign({}, st, { strategy: null, calibration: 0, fullRun: null, lastFullAt: null }) }); log('Margyn asked to re-test how to read this Tally. Starting now.'); return true; }
  if (action) log(`Ignoring unknown instruction from Margyn: ${action}`);
  return false;
}
function die(msg) { console.error('\n✖ ' + msg + '\n'); process.exit(1); }

function ask(question, { mask = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    if (mask) {
      const onData = (char) => {
        char = String(char);
        if (char === '\n' || char === '\r' || char === '') {
          process.stdin.removeListener('data', onData);
        } else {
          process.stdout.write('\x1B[2K\x1B[200D' + question + '*'.repeat(rl.line.length));
        }
      };
      process.stdin.on('data', onData);
    }
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

/* ------------------------------------------------------------------ */
/* pair                                                               */
/* ------------------------------------------------------------------ */
/**
 * performPair — the actual pairing logic (Tally version probe, cloud
 * exchange, config save), with no readline/prompt/console dependency so it
 * can be called from a non-CLI caller (e.g. the Electron GUI) as well as
 * from cmdPair below. Behavior/computation is unchanged from the original
 * inline cmdPair body — only the prompt-collection of `code`/`company` was
 * pulled out into the caller.
 *
 * @param {{code: string, company: string, cfg?: object, onLog?: (msg:string)=>void}} args
 * @returns {Promise<{install_id, install_key, company_name, info}>}
 */
async function performPair({ code, company, cfg, onLog }) {
  const emit = onLog || (() => {});
  cfg = cfg || config.load();
  if (!code) throw new Error('No code entered.');
  if (!company) throw new Error('Company name is required.');

  const machineHint = `${os.hostname()} / ${process.platform}`;

  // Detect what we're actually talking to (TallyPrime vs ERP 9) before pairing.
  let info = null;
  try {
    emit(`Checking Tally at ${cfg.tallyHost}:${cfg.tallyPort} …`);
    const xml = await tally.postXml({ host: cfg.tallyHost, port: cfg.tallyPort, xml: tally.buildInfoRequest() });
    info = tally.parseInfo(xml);
    emit(`Found ${info.product_name || 'Tally'} ${info.version || ''} (${info.edition}) — open company: ${info.company || 'none'}`);
    if (info.company && company && info.company.trim() !== company.trim()) {
      emit(`Warning: you entered "${company}" but Tally currently has "${info.company}" open. Using what you entered; make sure the right company is loaded before syncing.`);
    }
  } catch (e) {
    emit(`Warning: could not read Tally version (${e.message}). Continuing — you can still pair, but confirm Tally's HTTP server is on and a company is open.`);
  }

  emit(`Exchanging code with ${cfg.apiBase} …`);
  let out;
  try {
    out = await cloud.pairComplete(cfg.apiBase, {
      code,
      companyName: company,
      machineHint,
      agentVersion: AGENT_VERSION,
      tallyProduct: info ? info.product : null,
      tallyProductName: info ? info.product_name : null,
      tallyVersion: info ? info.version : null,
      tallyEdition: info ? info.edition : null,
      tallySerialLast4: info ? info.serial_last4 : null
    });
  } catch (e) {
    throw new Error(`Pairing failed: ${e.message}`);
  }

  config.save({
    installId: out.install_id,
    installKey: out.install_key,
    company: out.company_name || company,
    tallyProduct: info ? info.product : null,
    tallyVersion: info ? info.version : null
  });

  emit(`Paired. Company "${out.company_name || company}" is now linked to your Margyn account.`);
  emit(`Install key stored at ${config.CONFIG_PATH}`);

  return { ...out, info };
}

async function cmdPair() {
  const cfg = config.load();
  console.log('\nMargyn Tally Agent — pairing\n');
  console.log('In the Margyn app: Connectors → Connect Tally → Generate pairing code.\n');

  const code = await ask('Pairing code (e.g. AB12-CD34): ');
  if (!code) die('No code entered.');

  let company = cfg.company || process.env.TALLY_COMPANY || '';
  if (!company) {
    company = await ask('TallyPrime company name (exactly as shown in Tally): ');
  }
  if (!company) die('Company name is required.');

  try {
    const out = await performPair({ code, company, cfg, onLog: (m) => console.log(m.startsWith('Warning') ? `\n⚠ ${m}\n` : m) });
    console.log(`\nNext: run  node agent.js tally-check   then   node agent.js sync\n`);
  } catch (e) {
    die(e.message);
  }
}

/* ------------------------------------------------------------------ */
/* fetch ledgers (name/parent/opening/closing in one confirmed-safe call) */
/* ------------------------------------------------------------------ */
async function fetchLedgers(cfg) {
  const xml = tally.buildLedgerRequest({ company: cfg.company });
  const resp = await tally.postXml({ host: cfg.tallyHost, port: cfg.tallyPort, xml });
  return { rows: tally.parseLedgers(resp), raw: resp };
}

/**
 * Vouchers/bills — Phase 2/3. UNCONFIRMED against real Tally (see
 * tallyClient.js's buildVoucherRequest/buildBillsRequest comments). Kept as
 * separate fetch functions from fetchLedgers so a failure here never touches
 * the proven ledger path — runFullSync below treats each kind independently.
 */
async function fetchVouchers(cfg) {
  const xml = tally.buildVoucherRequest({ company: cfg.company, fromDate: cfg.fromDate, toDate: cfg.toDate });
  const resp = await tally.postXml({ host: cfg.tallyHost, port: cfg.tallyPort, xml, timeoutMs: 20000 });
  return { rows: tally.parseVouchers(resp), raw: resp };
}

/**
 * probe-inventory — fetch the Day Book and show whether stock lines came
 * back. Prints counts, the first parsed voucher with stock lines, and its raw
 * XML (trimmed) so we can confirm tag names on a real company file.
 */
async function cmdProbeInventory() {
  const cfg = require('./config').load();
  const { rows, raw } = await fetchVouchers(cfg);
  const withItems = rows.filter((r) => r.items && r.items.length);
  console.log(`Vouchers: ${rows.length}; with stock lines: ${withItems.length}`);
  const byType = {};
  withItems.forEach((r) => { byType[r.voucher_type] = (byType[r.voucher_type] || 0) + 1; });
  console.log('Stock lines by voucher type:', JSON.stringify(byType));
  if (!withItems.length) {
    const hasTag = /INVENTORYENTRIES\.LIST/i.test(raw);
    console.log(hasTag ? 'Tags present but nothing parsed — send the raw XML back.' : 'No inventory tags in the Day Book response. Either no item-invoice vouchers in range, or Tally needs a different report.');
    return;
  }
  console.log('First parsed voucher:\n' + JSON.stringify(withItems[0], null, 2));
  const i = raw.indexOf('INVENTORYENTRIES.LIST');
  console.log('\nRaw XML around the first stock line:\n' + raw.slice(Math.max(0, i - 200), i + 1500));
}

async function fetchBills(cfg, direction) {
  const xml = tally.buildBillsRequest({ company: cfg.company, toDate: cfg.toDate, direction, legacy: !!cfg.legacyBills });
  const resp = await tally.postXml({ host: cfg.tallyHost, port: cfg.tallyPort, xml, timeoutMs: 20000 });
  return { rows: tally.parseBills(resp, direction), raw: resp };
}

/* tally-check                                                        */
/* ------------------------------------------------------------------ */
async function cmdTallyCheck() {
  const cfg = config.load();
  if (!cfg.company) die('No company configured. Run `node agent.js pair` or set TALLY_COMPANY.');

  try {
    const infoXml = await tally.postXml({ host: cfg.tallyHost, port: cfg.tallyPort, xml: tally.buildInfoRequest() });
    const info = tally.parseInfo(infoXml);
    console.log(`\nTally: ${info.product_name || 'unknown'} ${info.version || ''} (${info.edition}) · open company: ${info.company || 'none'}`);
  } catch (e) {
    console.log(`\n⚠ version probe failed: ${e.message}`);
  }

  log(`Requesting ledgers from Tally at ${cfg.tallyHost}:${cfg.tallyPort} for "${cfg.company}" …`);
  const { rows, raw } = await fetchLedgers(cfg);

  if (!rows.length) {
    console.log('\n⚠ Tally responded but no ledgers were parsed. Raw response (first 800 chars):\n');
    console.log(raw.slice(0, 800));
    return;
  }

  console.log(`\n✔ ${rows.length} ledgers.\n`);
  const sample = rows.slice(0, 15);
  for (const r of sample) {
    const bal = r.closing_balance == null ? '—' : r.closing_balance.toLocaleString('en-IN');
    console.log(`  ${String(r.name).padEnd(38).slice(0, 38)}  ${String(r.parent || '').padEnd(22).slice(0, 22)}  ${bal}`);
  }
  if (rows.length > sample.length) console.log(`  … and ${rows.length - sample.length} more`);
  console.log('');
}

/* ------------------------------------------------------------------ */
/* sync (Phase 1: ledgers)                                            */
/* ------------------------------------------------------------------ */
async function runLedgerSync(cfg, { dryRun = false, company } = {}) {
  if (!cfg.installKey && !dryRun) {
    throw new Error('Not paired. Run `node agent.js pair` first.');
  }
  company = company || cfg.company;
  if (!company) throw new Error('No company configured.');

  const { rows } = await fetchLedgers(Object.assign({}, cfg, { company }));
  log(`Parsed ${rows.length} ledgers from Tally.`);

  const t = new Date();
  const asOf = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  const base = { kind: 'ledgers', company_name: company, company_guid: cfg.companyGuid || null, as_of_date: asOf };

  if (dryRun) {
    console.log(JSON.stringify(Object.assign({}, base, { rows }), null, 2));
    return { dryRun: true, rows: rows.length };
  }

  // Ledgers are a complete snapshot, so the cloud drops ledgers it no longer sees. Big books are
  // sent in batches (Vercel caps a request at 4.5MB); only the LAST batch triggers that sweep,
  // using the server's clock from the first batch as the cutoff.
  const BATCH = 1500;
  let upserted = 0, removed = 0, serverStart = null;
  for (let i = 0; i < Math.max(rows.length, 1); i += BATCH) {
    const last = i + BATCH >= rows.length;
    const payload = Object.assign({}, base, { rows: rows.slice(i, i + BATCH) });
    if (!last) payload.partial = true;
    else if (serverStart) payload.snapshot_started_at = serverStart;
    const r = await cloud.ingest(cfg.apiBase, cfg.installKey, payload);
    if (!serverStart && r.server_time) serverStart = r.server_time;
    upserted += r.upserted || 0;
    removed += r.removed || 0;
  }
  log(`Cloud: ${upserted}/${rows.length} ledgers stored${removed ? `, ${removed} removed (deleted in Tally)` : ''}.`);
  return { upserted, received: rows.length, removed };
}

function todayYmd() {
  const t = new Date();
  return `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}`;
}

/**
 * Full sync — company check, ledgers, vouchers (whole financial year, see voucherSync.js),
 * bills. Each kind is independent: a voucher or bill failure is logged and reported to Margyn,
 * never blocks the others. Afterwards the agent sends a health report (what it saw in Tally and
 * what it sent), so Margyn can diagnose a client's sync without access to their machine.
 */
async function runFullSync(cfg, { dryRun = false } = {}) {
  const results = { ledgers: null, vouchers: null, bills: null };
  const health = { agent_version: AGENT_VERSION, at: new Date().toISOString(), errors: {} };
  let company = cfg.company;
  try {
    const resolved = await voucherSync.resolveCompany(cfg, log);
    company = resolved.company;
    health.company = company;
    health.open_companies = resolved.open;
    if (resolved.switchedFrom) health.switched_from = resolved.switchedFrom;
    if (resolved.fact) health.company_facts = resolved.fact;
    // Product/version come from pairing (saved in config); no extra request to Tally every sync.
    health.tally = { product: cfg.tallyProduct || null, version: cfg.tallyVersion || null };
    health.request_guard = { proven: (config.load().syncState || {}).provenRequests || [], blocked: (config.load().syncState || {}).blockedRequests || [] };

    // Ledgers — hard fail: if this breaks, Tally/pairing/network is down, not a request shape.
    results.ledgers = await runLedgerSync(cfg, { dryRun, company });
    health.ledgers = { received: results.ledgers.received != null ? results.ledgers.received : results.ledgers.rows };

    try {
      const v = await voucherSync.syncVouchers(cfg, { company, fact: resolved.fact, dryRun, log });
      results.vouchers = { upserted: v.upserted, received: v.received, removed: v.removed || 0, mode: v.mode };
      health.vouchers = v.diag;
      health.vouchers.mode = v.mode;
    } catch (e) {
      log(`⚠ Voucher sync stopped — ${e.message}`);
      results.vouchers = { error: e.message };
      health.errors.vouchers = String(e.message).slice(0, 300);
      if (e.diag) health.vouchers = e.diag;
    }

    if (results.vouchers && /not running or not reachable|switched off on this PC so Tally/.test(results.vouchers.error || '')) {
      log('Stopping this sync: Tally closed or stopped answering. Open Tally again; the next sync carries on.');
    } else {
      results.bills = await syncBills(Object.assign({}, cfg, { company }), { dryRun, health });
    }
  } catch (e) {
    health.errors.sync = String(e.message).slice(0, 300);
    throw e;
  } finally {
    if (!dryRun && cfg.installKey) {
      cloud.health(cfg.apiBase, cfg.installKey, health).catch(() => { /* diagnostics are best-effort */ });
    }
  }
  return results;
}

/**
 * Bills as of TODAY. Tally's "Bills Receivable" report answers with bills of both directions on
 * some builds; the payable report is also asked. If the typed-date form returns nothing at all,
 * fall back once to the older request (FY-end compact date) that has worked in production, so a
 * change in request shape can never empty a client's receivables.
 */
async function syncBills(cfg, { dryRun, health }) {
  const out = {};
  health.bills = {};
  const got = {};
  for (const direction of ['receivable', 'payable']) {
    try {
      let { rows } = await fetchBills(Object.assign({}, cfg, { toDate: todayYmd() }), direction);
      if (!rows.length) rows = (await fetchBills(Object.assign({}, cfg, { legacyBills: true }), direction)).rows;
      got[direction] = rows;
      health.bills[direction] = rows.length;
    } catch (e) {
      log(`⚠ ${direction} bills not read — ${e.message}`);
      out[direction] = { error: e.message };
      health.errors[`bills_${direction}`] = String(e.message).slice(0, 300);
    }
  }
  // parseBills derives each bill's direction from its sign, so the two reports can overlap; group
  // by derived direction and send each group as its own complete snapshot.
  const byDir = { receivable: new Map(), payable: new Map() };
  for (const rows of Object.values(got)) {
    for (const b of rows) byDir[b.direction].set(`${b.party_name}|${b.bill_ref}`, b);
  }
  for (const direction of ['receivable', 'payable']) {
    const rows = [...byDir[direction].values()];
    if (!rows.length || out[direction]) continue;
    const payload = { kind: 'bills', company_name: cfg.company, company_guid: cfg.companyGuid || null, rows };
    if (dryRun) { console.log(JSON.stringify(payload, null, 2)); continue; }
    try {
      const r = await cloud.ingest(cfg.apiBase, cfg.installKey, payload);
      log(`Cloud (${direction} bills): ${r.upserted}/${r.received} stored.`);
      out[direction] = r;
    } catch (e) {
      out[direction] = { error: e.message };
      health.errors[`bills_${direction}`] = String(e.message).slice(0, 300);
    }
  }
  return out;
}

async function cmdSync({ dryRun, ledgersOnly }) {
  const cfg = config.load();
  try {
    if (ledgersOnly) {
      await runLedgerSync(cfg, { dryRun });
    } else {
      await runFullSync(cfg, { dryRun });
    }
    if (!dryRun) console.log('\n✔ Sync complete.\n');
  } catch (e) {
    if (e.code === 'unauthorized') {
      die(`Cloud rejected the install key (${e.message}). Re-pair this agent: node agent.js pair`);
    }
    die(e.message);
  }
}

/* ------------------------------------------------------------------ */
/* dump-request — write the exact XML to files, for curl'ing directly */
/* without going through any shell's quoting (which has been the        */
/* actual source of a couple of false test results, not Tally itself).  */
/* ------------------------------------------------------------------ */
function cmdDumpRequest() {
  const cfg = config.load();
  if (!cfg.company) die('No company configured. Run `node agent.js pair` or set TALLY_COMPANY.');

  const files = {
    'ledger-request.xml': tally.buildLedgerRequest({ company: cfg.company }),
    'info-request.xml': tally.buildInfoRequest()
  };
  for (const [name, xml] of Object.entries(files)) {
    fs.writeFileSync(name, xml, 'utf8');
    console.log(`wrote ${name}  (${xml.length} bytes)`);
  }
  console.log(`
Now test with curl directly — no quoting, no escaping, byte-exact:

  curl.exe -s http://localhost:9000 -H "Content-Type: text/xml" --data-binary "@ledger-request.xml" --max-time 20
`);
}

/* probe — write several candidate request SHAPES to isolate exactly    */
/* what real Tally rejects/hangs on. Confirmed 2026-09-05: a bare        */
/* TALLYREQUEST=Export/TYPE=Collection request (buildLedgerRequest) gets */
/* NO response at all (curl STATUS=000, 20s) from real TallyPrime        */
/* (Educational). These variants change one thing at a time.            */
/* ------------------------------------------------------------------ */
function cmdProbe() {
  const cfg = config.load();
  if (!cfg.company) die('No company configured. Run `node agent.js pair` or set TALLY_COMPANY.');
  const company = cfg.company;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const files = {
    // A: same as buildLedgerRequest but with the extra IS* attributes and
    //    SVFROMDATE/SVTODATE stripped — the plainest possible bare collection.
    'probe-a-minimal-collection.xml':
      '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>' +
      '<ID>MargynProbeA</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>' +
      `<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES><TDL><TDLMESSAGE>` +
      '<COLLECTION NAME="MargynProbeA"><TYPE>Ledger</TYPE><NATIVEMETHOD>Name</NATIVEMETHOD></COLLECTION>' +
      '</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>',

    // B: same as A but with SVFROMDATE/SVTODATE added back — isolates
    //    whether the date variables specifically are what triggers it.
    'probe-b-minimal-with-dates.xml':
      '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>' +
      '<ID>MargynProbeB</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>' +
      `<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY><SVFROMDATE>${esc(cfg.toDate)}</SVFROMDATE>` +
      `<SVTODATE>${esc(cfg.toDate)}</SVTODATE></STATICVARIABLES><TDL><TDLMESSAGE>` +
      '<COLLECTION NAME="MargynProbeB"><TYPE>Ledger</TYPE><NATIVEMETHOD>Name</NATIVEMETHOD></COLLECTION>' +
      '</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>',

    // C: the REPORT/FORM/PART/LINE/FIELD pattern (walks a collection
    //    instead of exporting it directly) — the shape shown in Tally's
    //    own "Simple Trial Balance" example. Structurally different from
    //    A/B; if THIS one answers and A/B don't, the fix is to rebuild
    //    every request on this pattern instead.
    'probe-c-report-wrapped.xml':
      '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE>' +
      '<ID>MargynProbeReport</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>' +
      `<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES><TDL><TDLMESSAGE>` +
      '<REPORT NAME="MargynProbeReport"><FORMS>MargynProbeForm</FORMS></REPORT>' +
      '<FORM NAME="MargynProbeForm"><TOPPARTS>MargynProbePart</TOPPARTS></FORM>' +
      '<PART NAME="MargynProbePart"><LINES>MargynProbeLine</LINES>' +
      '<REPEAT>MargynProbeLine : MargynProbeCollection</REPEAT><SCROLLED>Vertical</SCROLLED></PART>' +
      '<LINE NAME="MargynProbeLine"><FIELDS>FldName</FIELDS></LINE>' +
      '<FIELD NAME="FldName"><SET>$Name</SET></FIELD>' +
      '<COLLECTION NAME="MargynProbeCollection"><TYPE>Ledger</TYPE></COLLECTION>' +
      '</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>',

    // D: PRIORITY — copied verbatim (structure) from a real, currently-used
    //    integration script found in the wild. Asks for Tally's own BUILT-IN
    //    collection named "List of Ledgers" directly — no custom TDLMESSAGE
    //    at all. This is structurally different from A/B/C: those all define
    //    a brand-new custom collection/report; this asks for one Tally
    //    already ships. If this works and A/B/C don't, the fix is simple:
    //    stop defining custom collections, use Tally's built-in ones.
    'probe-d-builtin-list-of-ledgers.xml':
      '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>EXPORT</TALLYREQUEST><TYPE>COLLECTION</TYPE>' +
      '<ID>List of Ledgers</ID></HEADER><BODY><DESC><STATICVARIABLES>' +
      '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>',

    // E: same as D, but scoped to our company (D omits SVCURRENTCOMPANY
    //    entirely, which only works if exactly one company is open — adding
    //    it back is the safe production version IF D itself works).
    'probe-e-builtin-with-company.xml':
      '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>EXPORT</TALLYREQUEST><TYPE>COLLECTION</TYPE>' +
      '<ID>List of Ledgers</ID></HEADER><BODY><DESC><STATICVARIABLES>' +
      '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>' +
      `<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></DESC></BODY></ENVELOPE>`,

    // F — CONFIRMED 2026-09-05: D (built-in "List of Ledgers") answers fine
    //     and fast, but only returns names — no Parent/OpeningBalance/GUID.
    //     Defining a brand-new custom collection (<TYPE>Ledger</TYPE> from
    //     scratch, as A/B/the real request do) is what hangs. This variant
    //     builds ON TOP of the already-working built-in collection instead
    //     of defining a new one: SOURCECOLLECTION references "List of
    //     Ledgers" directly, and just adds COMPUTE fields for the data we
    //     actually need. If this answers, it's the fix.
    'probe-f-source-collection.xml':
      '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>' +
      '<ID>MargynProbeF</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>' +
      '</STATICVARIABLES><TDL><TDLMESSAGE>' +
      '<COLLECTION NAME="MargynProbeF"><SOURCECOLLECTION>List of Ledgers</SOURCECOLLECTION>' +
      '<COMPUTE>MARGYNPARENT:$Parent</COMPUTE><COMPUTE>MARGYNOPENING:$OpeningBalance</COMPUTE>' +
      '<COMPUTE>MARGYNCLOSING:$ClosingBalance</COMPUTE></COLLECTION>' +
      '</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>',

    // G — CONFIRMED 2026-09-05: F answers with real Parent/Opening/Closing
    //     data (no hang!) but the NAME came back empty — we only asked for
    //     the extra fields, not the name itself. Add it the same way, plus
    //     GUID/MasterId for stable dedupe keys. If this is right, this IS
    //     the real request — wire it into tallyClient.js next.
    'probe-g-source-collection-with-name.xml':
      '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>' +
      '<ID>MargynProbeG</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>' +
      '</STATICVARIABLES><TDL><TDLMESSAGE>' +
      '<COLLECTION NAME="MargynProbeG"><SOURCECOLLECTION>List of Ledgers</SOURCECOLLECTION>' +
      '<COMPUTE>MARGYNNAME:$Name</COMPUTE><COMPUTE>MARGYNPARENT:$Parent</COMPUTE>' +
      '<COMPUTE>MARGYNOPENING:$OpeningBalance</COMPUTE><COMPUTE>MARGYNCLOSING:$ClosingBalance</COMPUTE>' +
      '<COMPUTE>MARGYNGUID:$Guid</COMPUTE><COMPUTE>MARGYNMASTERID:$MasterId</COMPUTE></COLLECTION>' +
      '</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>'
  };

  for (const [name, xml] of Object.entries(files)) {
    fs.writeFileSync(name, xml, 'utf8');
    console.log(`wrote ${name}`);
  }

  console.log(`
F confirmed working 2026-09-05 (Parent/Opening/Closing came back, no hang!) but
NAME was empty. Test G next — same idea, name added:

  curl.exe -s http://localhost:9000 -H "Content-Type: text/xml" --data-binary "@probe-g-source-collection-with-name.xml" --max-time 20 -o g.response.xml
  dir g.response.xml
  type g.response.xml

If G comes back with real ledger names attached to Parent/Opening/Closing — done,
that's the real request. If G is 0 bytes / hangs, fall back to C:

  curl.exe -s http://localhost:9000 -H "Content-Type: text/xml" --data-binary "@probe-c-report-wrapped.xml" --max-time 20 -o c.response.xml
  dir c.response.xml

Or A/B (each waits up to 20s):

  curl.exe -s http://localhost:9000 -H "Content-Type: text/xml" --data-binary "@probe-a-minimal-collection.xml" --max-time 20 -o a.response.xml
  curl.exe -s http://localhost:9000 -H "Content-Type: text/xml" --data-binary "@probe-b-minimal-with-dates.xml" --max-time 20 -o b.response.xml
  curl.exe -s http://localhost:9000 -H "Content-Type: text/xml" --data-binary "@probe-c-report-wrapped.xml" --max-time 20 -o c.response.xml

Then run this ONE command and screenshot just this — it lists all three files with
their byte sizes side by side, no ambiguity about which one got real bytes back:

  dir a.response.xml b.response.xml c.response.xml

Whichever file is NOT 0 bytes, also run:  type <that file>.response.xml
`);
}

/* probe-vouchers / probe-bills — same methodology as `probe`, for the       */
/* next real-machine session on Phase 2/3. Untested candidates, not claims.  */
/* ------------------------------------------------------------------ */
function cmdProbeVouchers() {
  const cfg = config.load();
  if (!cfg.company) die('No company configured. Run `node agent.js pair` or set TALLY_COMPANY.');
  const company = cfg.company;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const files = {
    // A: the current buildVoucherRequest — SOURCECOLLECTION="Vouchers".
    'probe-voucher-a-source-vouchers.xml':
      '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>' +
      '<ID>MargynVchA</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>' +
      `<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY><SVFROMDATE>${esc(cfg.fromDate)}</SVFROMDATE>` +
      `<SVTODATE>${esc(cfg.toDate)}</SVTODATE></STATICVARIABLES><TDL><TDLMESSAGE>` +
      '<COLLECTION NAME="MargynVchA"><SOURCECOLLECTION>Vouchers</SOURCECOLLECTION>' +
      '<COMPUTE>MARGYNVCHTYPE:$VoucherTypeName</COMPUTE><COMPUTE>MARGYNVCHNUM:$VoucherNumber</COMPUTE>' +
      '<COMPUTE>MARGYNDATE:$Date</COMPUTE><COMPUTE>MARGYNPARTY:$PartyName</COMPUTE>' +
      '<COMPUTE>MARGYNAMOUNT:$Amount</COMPUTE></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>',

    // B: Day Book as a plain report export (TYPE=Data, no custom TDL at all) —
    //    the "ask for something built-in and plain" fallback, same principle
    //    as ledger probe D. Response format unknown; worth seeing raw output.
    'probe-voucher-b-daybook-report.xml':
      '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE>' +
      '<ID>Day Book</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>' +
      `<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY><SVFROMDATE>${esc(cfg.fromDate)}</SVFROMDATE>` +
      `<SVTODATE>${esc(cfg.toDate)}</SVTODATE></STATICVARIABLES></DESC></BODY></ENVELOPE>`,

    // C: same as B but the ID as one word "DayBook" (some report IDs are
    //    space-free internal names vs. space-separated display names —
    //    ledger debugging showed this kind of naming mismatch matters).
    'probe-voucher-c-daybook-noSpace.xml':
      '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE>' +
      '<ID>DayBook</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>' +
      `<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY><SVFROMDATE>${esc(cfg.fromDate)}</SVFROMDATE>` +
      `<SVTODATE>${esc(cfg.toDate)}</SVTODATE></STATICVARIABLES></DESC></BODY></ENVELOPE>`
  };

  for (const [name, xml] of Object.entries(files)) {
    fs.writeFileSync(name, xml, 'utf8');
    console.log(`wrote ${name}`);
  }
  console.log(`
Test each with curl (same pattern as the ledger probes) — 20s timeout each:

  curl.exe -s http://localhost:9000 -H "Content-Type: text/xml" --data-binary "@probe-voucher-a-source-vouchers.xml" --max-time 20 -o va.response.xml
  curl.exe -s http://localhost:9000 -H "Content-Type: text/xml" --data-binary "@probe-voucher-b-daybook-report.xml" --max-time 20 -o vb.response.xml
  curl.exe -s http://localhost:9000 -H "Content-Type: text/xml" --data-binary "@probe-voucher-c-daybook-noSpace.xml" --max-time 20 -o vc.response.xml
  dir va.response.xml vb.response.xml vc.response.xml

If any one of these hangs, STOP that one (Task Manager, not waiting) before
trying the next — don't repeat the multi-hang night. Whichever comes back
with real voucher data, send me the "type <file>" output and I'll wire the
real parser to match, same as we did for ledgers.
`);
}

function cmdProbeBills() {
  const cfg = config.load();
  if (!cfg.company) die('No company configured. Run `node agent.js pair` or set TALLY_COMPANY.');
  const company = cfg.company;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const files = {
    // A: the current buildBillsRequest — "Bills Receivable" as a plain report.
    'probe-bills-a-receivable-report.xml':
      '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE>' +
      '<ID>Bills Receivable</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>' +
      `<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY><SVFROMDATE>${esc(cfg.toDate)}</SVFROMDATE>` +
      `<SVTODATE>${esc(cfg.toDate)}</SVTODATE></STATICVARIABLES></DESC></BODY></ENVELOPE>`,

    // B: same, payable side.
    'probe-bills-b-payable-report.xml':
      '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE>' +
      '<ID>Bills Payable</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>' +
      `<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY><SVFROMDATE>${esc(cfg.toDate)}</SVFROMDATE>` +
      `<SVTODATE>${esc(cfg.toDate)}</SVTODATE></STATICVARIABLES></DESC></BODY></ENVELOPE>`,

    // C: bills as bill-wise allocations layered on top of "List of Ledgers"
    //    (the collection we KNOW works) — same lesson as the ledger fix:
    //    build on a working collection instead of a new report/collection.
    'probe-bills-c-source-ledgers.xml':
      '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>' +
      '<ID>MargynBillsC</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>' +
      '</STATICVARIABLES><TDL><TDLMESSAGE>' +
      '<COLLECTION NAME="MargynBillsC"><SOURCECOLLECTION>List of Ledgers</SOURCECOLLECTION>' +
      '<COMPUTE>MARGYNNAME:$Name</COMPUTE><COMPUTE>MARGYNBILLCOUNT:$$NumBillMarkedItems</COMPUTE>' +
      '</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>'
  };

  for (const [name, xml] of Object.entries(files)) {
    fs.writeFileSync(name, xml, 'utf8');
    console.log(`wrote ${name}`);
  }
  console.log(`
Test each — 20s timeout, one at a time:

  curl.exe -s http://localhost:9000 -H "Content-Type: text/xml" --data-binary "@probe-bills-a-receivable-report.xml" --max-time 20 -o ba.response.xml
  curl.exe -s http://localhost:9000 -H "Content-Type: text/xml" --data-binary "@probe-bills-b-payable-report.xml" --max-time 20 -o bb.response.xml
  curl.exe -s http://localhost:9000 -H "Content-Type: text/xml" --data-binary "@probe-bills-c-source-ledgers.xml" --max-time 20 -o bc.response.xml
  dir ba.response.xml bb.response.xml bc.response.xml

Note: for bills testing to mean anything, the test company needs at least one
bill-wise voucher entered (a sale/purchase with a bill reference) — an empty
company will just return an empty result either way, which won't tell us if
the request shape is right.
`);
}

/* run (loop)                                                         */
/* ------------------------------------------------------------------ */
async function cmdRun() {
  const cfg = config.load();
  if (!cfg.installKey) die('Not paired. Run `node agent.js pair` first.');
  const everyMs = Math.max(1, cfg.intervalMinutes) * 60 * 1000;
  log(`Agent running. Company "${cfg.company}". Sync every ${cfg.intervalMinutes} min. Ctrl+C to stop.`);

  const tick = async () => {
    try {
      await runFullSync(config.load());
    } catch (e) {
      log('Sync error (will retry next interval):', e.message);
    }
  };

  await tick();
  setInterval(tick, everyMs);
}

/* ------------------------------------------------------------------ */
/* entry                                                              */
/*                                                                     */
/* Guarded so that `require('./agent.js')` (e.g. from the Electron GUI */
/* in tally-agent-gui/, which reuses the exports below) does NOT also  */
/* run the CLI arg-parsing / process.exit() below. Behavior of running */
/* `node agent.js <cmd>` directly is completely unchanged.             */
/* ------------------------------------------------------------------ */
if (require.main === module) {
  (async () => {
    const [, , cmd, ...rest] = process.argv;
    const flags = new Set(rest);

    switch (cmd) {
      case 'pair':            return cmdPair();
      case 'tally-check':     return cmdTallyCheck();
      case 'dump-request':    return cmdDumpRequest();
      case 'probe':           return cmdProbe();
      case 'probe-vouchers':  return cmdProbeVouchers();
      case 'probe-bills':     return cmdProbeBills();
      case 'probe-inventory': return cmdProbeInventory();
      case 'sync':            return cmdSync({ dryRun: flags.has('--dry-run'), ledgersOnly: flags.has('--ledgers-only') });
      case 'run':             return cmdRun();
      default:
        console.log(`Margyn Tally Agent v${AGENT_VERSION} (prototype)

Usage:
  node agent.js pair             Pair this machine with a Margyn account
  node agent.js tally-check      Print the ledger list straight from Tally (no cloud)
  node agent.js sync             Run one sync: ledgers (proven) + vouchers + bills
                                  (Phase 2/3, unconfirmed — soft-fails without
                                  blocking the ledger sync if their shape is wrong)
  node agent.js sync --ledgers-only   Old narrow behavior, ledgers only
  node agent.js sync --dry-run   Print the payload(s) instead of sending them
  node agent.js dump-request     Write the exact ledger+info XML requests to
                                  files, to curl directly (bypasses shell-quoting)
  node agent.js probe            Ledger request-shape probes (historical — already solved)
  node agent.js probe-vouchers   Voucher request-shape candidates for next real-machine test
  node agent.js probe-bills      Bill-wise request-shape candidates for next real-machine test
  node agent.js run              Sync now, then on a timer

Config file: ${config.CONFIG_PATH}
`);
        process.exit(cmd ? 1 : 0);
    }
  })().catch((e) => die(e.message));
}

/* ------------------------------------------------------------------ */
/* exports — for tally-agent-gui/ (Electron main process) to reuse     */
/* this file's logic directly instead of reimplementing it. Nothing    */
/* below changes what these functions compute; it only exposes them.   */
/* ------------------------------------------------------------------ */
module.exports = {
  AGENT_VERSION,
  setLogger,
  compareVersions,
  applyCommand,
  syncBills,
  performPair,
  fetchLedgers,
  runLedgerSync,
  fetchVouchers,
  fetchBills,
  runFullSync
};
