// Single choke point for "send nothing externally" (demo / rehearsal mode).
// On when:
//   - MARGYN_EXTERNAL_SENDS=off (everything, everywhere), or
//   - a caller passes { dryRun: true }, or
//   - the account being served has external sends off: profiles.preferences.external_sends = 'off'
//     (an investor demo tenant), or its id is in MARGYN_DEMO_ACCOUNTS (comma-separated). Such an account
//     still reaches its own owner's WhatsApp number (replies to the owner, Margyn Watch), so the person
//     trying Margyn gets the whole experience; customers, invitees and report recipients get nothing.
// The account comes from the async context: runAsAccount(userId, fn) around per-account work (crons,
// Watch), or inRequest(fn) + markAccount(userId) when a request learns its account part-way (the inbound
// WhatsApp webhook). Every send below that, however deep, sees it; no caller has to pass a flag.
// A blocked send is logged (channel + masked destination only, never the body) and reported as
// { ok: true, blocked: true, preview: true } so the UI can show "Preview: not sent".
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
const CACHE_MS = 60 * 1000;
const cache = new Map();   // userId -> { off, own: [phone digits], at }
const digits = (v) => String(v || '').replace(/\D/g, '').slice(-10);

function envDemoAccounts() {
  return String(process.env.MARGYN_DEMO_ACCOUNTS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** This account's setting: { off, own } (own = the owner's WhatsApp number, still allowed). A lookup error sends as normal. */
async function accountSetting(userId) {
  if (!userId) return { off: false, own: [] };
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  let off = envDemoAccounts().includes(String(userId)), own = [];
  try {
    const { selectRows } = require('./supabaseRest');
    const rows = await selectRows('profiles', `select=preferences,whatsapp_phone&id=eq.${encodeURIComponent(userId)}&limit=1`);
    const p = (rows[0] && rows[0].preferences) || {};
    off = off || String(p.external_sends || '').toLowerCase() === 'off' || p.demo === true;
    if (rows[0] && rows[0].whatsapp_phone) own = [digits(rows[0].whatsapp_phone)];
  } catch (e) { /* as normal, unless listed */ }
  const out = { off, own, at: Date.now() };
  cache.set(userId, out);
  return out;
}

/** Does this account have external sends off? */
async function accountSendsOff(userId) {
  return (await accountSetting(userId)).off;
}

/** Run per-account work; sends inside follow that account's setting. */
async function runAsAccount(userId, fn) {
  const { off, own } = await accountSetting(userId);
  return als.run({ userId: userId || null, off, own }, fn);
}

/** Open a context for a request whose account isn't known yet (see markAccount). */
function inRequest(fn) {
  return als.run({ userId: null, off: false, own: [] }, fn);
}

/** The request now knows its account: apply that account's setting to every later send in it. */
async function markAccount(userId) {
  const store = als.getStore();
  if (!store || !userId) return;
  const { off, own } = await accountSetting(userId);
  store.userId = userId; store.off = off; store.own = own;
}

/** opts: { dryRun, to }. With `to`, a demo account's own owner number is still reached. */
function sendsBlocked(opts) {
  if (opts && opts.dryRun) return true;
  if (String(process.env.MARGYN_EXTERNAL_SENDS || '').toLowerCase() === 'off') return true;
  const store = als.getStore();
  if (!store || !store.off) return false;
  return !(opts && opts.to && (store.own || []).includes(digits(opts.to)));
}
function maskDest(to) {
  const s = String(to || '');
  return s.includes('@') ? s.replace(/^(.).*(@.*)$/, '$1***$2') : s.replace(/.(?=.{3})/g, '*');
}
function blockedResult(channel, to) {
  const store = als.getStore();
  console.log(`[send-guard] blocked ${channel} to ${maskDest(to)}${store && store.userId ? ' (account with sends off)' : ''}`);
  return { ok: true, blocked: true, preview: true, messageId: 'preview-not-sent' };
}
function _clearCache() { cache.clear(); }
module.exports = { sendsBlocked, blockedResult, maskDest, runAsAccount, inRequest, markAccount, accountSendsOff, _clearCache };
