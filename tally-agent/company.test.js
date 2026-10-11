/** Run: node tally-agent/company.test.js — which Tally company file the agent reads (voucherSync.resolveCompany). Stubbed Tally, no network. */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'margyn-agent-co-'));
process.env.HOME = HOME; process.env.APPDATA = HOME; process.env.XDG_CONFIG_HOME = HOME;
const tally = require('./tallyClient');
const config = require('./config');
const { resolveCompany } = require('./voucherSync');

let open = [];
tally.testConnection = async () => ({ reachable: true });
tally.postXml = async () => '<ENVELOPE/>';
tally.parseCompanyFacts = () => open;
const OLD = { name: 'CARE HYGIENE PVT LTD (2025-26)', books_from: '2025-04-01', last_voucher_date: '2026-03-31', active: true };
const NEW = { name: 'CARE HYGIENE PVT LTD (2026-27)', books_from: '2026-04-01', last_voucher_date: '2027-03-10', active: true };
const OTHER = { name: 'SOMEONE ELSE LTD', books_from: '2026-04-01', last_voucher_date: '2026-10-01', active: true };
const run = async (company) => { config.save({ company, tallyHost: '127.0.0.1', tallyPort: 9000 }); return resolveCompany(config.load(), () => {}); };

(async () => {
  // 9 Oct 2026 at Care Hygiene: the agent had moved to the 2025-26 file; now both files are open.
  open = [OLD, NEW];
  let r = await run(OLD.name);
  assert.strictEqual(r.company, NEW.name, 'both files open: the current year\'s file is read, whatever was configured');
  assert.strictEqual(config.load().company, NEW.name);
  // Already on the current file with both open: stays.
  r = await run(NEW.name);
  assert.strictEqual(r.company, NEW.name);
  assert.ok(!r.switchedFrom);
  // Only last year's file open (the audit): it is read as history...
  open = [OLD];
  r = await run(NEW.name);
  assert.strictEqual(r.company, OLD.name);
  // ...and the moment this year's file is open again, the agent is back on it.
  open = [NEW, OLD];
  r = await resolveCompany(config.load(), () => {});
  assert.strictEqual(r.company, NEW.name, 'back to the current file by itself');
  // Another business open beside it is never picked.
  open = [OTHER, NEW];
  r = await run(NEW.name);
  assert.strictEqual(r.company, NEW.name);
  open = [OTHER];
  await assert.rejects(() => run(NEW.name), /not open in Tally/);
  // A business with one file and no year in its name: unchanged.
  open = [{ name: 'Margyn Labs', books_from: '2026-04-01', last_voucher_date: '2026-10-02', active: true }];
  r = await run('Margyn Labs');
  assert.strictEqual(r.company, 'Margyn Labs');
  console.log('company.test.js: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
