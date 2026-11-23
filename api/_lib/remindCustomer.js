/**
 * _lib/remindCustomer.js
 * One payment reminder to one customer, right now, after the owner's tap. Added 2026-11-23.
 *
 * Shared by two doors:
 *   - the app's "Remind <customer>" (api/whatsapp.js ?action=remind-now)
 *   - WhatsApp: "chase Centaur" -> propose_action send_one_off_chase -> owner taps Confirm
 *     (api/_lib/marginActions.js)
 *
 * The customer comes from the reconciled receivables (manual entries, Tally, Zoho Books, Odoo: the
 * same position the Receivables page shows), so a Tally customer can be reminded like any other.
 * The number comes from the party master (ledger_parties: typed in Margyn, or filled from Tally /
 * Zoho contacts). The message is always the approved chase template, sent through sendGuard (a demo
 * account logs "Preview: not sent") and logged as a chase, exactly like the 10:30 run.
 *
 * Before 2026-11-23 the WhatsApp door only knew rows already on the Chase list, so a Tally-only
 * account got "isn't on Margyn's reminder list"; and when a row did exist it sent free text, which
 * WhatsApp drops outside a 24-hour window, then said "Done". Both are gone.
 *
 * CommonJS, zero-npm.
 */

const { selectRows, insertRows, updateRows, logConnectorEvent } = require('./supabaseRest');
const chase = require('./chaseEngine');
const moneyModel = require('./moneyModel');
const sendGuard = require('./sendGuard');
const bsp = require('./whatsappBsp');
const deliveries = require('./waDeliveries');

/** Same normalised name as api/whatsapp.js (Chase matching). */
function normPartyName(s) {
  return String(s || '').toLowerCase()
    .replace(/\b(pvt|private|ltd|limited|llp|inc|co|corp|corporation|company|the|and)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}
const digits = (p) => String(p || '').replace(/[^\d]/g, '');

/**
 * A number WhatsApp can deliver to, as digits with the country code, or null.
 * "98200 12345" / "09820012345" / "+91 98200 12345" -> "919820012345". A landline ("022 2345 6789")
 * or anything too short is null: a chase template to it can never arrive.
 */
function waNumber(p) {
  const d = digits(p);
  if (/^[6-9]\d{9}$/.test(d)) return '91' + d;
  if (/^0[6-9]\d{9}$/.test(d)) return '91' + d.slice(1);
  if (/^91[6-9]\d{9}$/.test(d)) return d;
  if (/^91/.test(d) || /^0/.test(d) || d.length < 11 || d.length > 15) return null;   // Indian landline, or not a full number
  return d;                                                                            // another country's full number
}

async function businessNameFor(userId) {
  try {
    const p = await selectRows('profiles', `select=company_name&id=eq.${userId}&limit=1`);
    if (p[0] && p[0].company_name) return p[0].company_name;
  } catch (e) { /* default */ }
  return 'your supplier';
}

/** Payment reminders for the whole account: 'on' | 'paused' | 'not_set_up'. */
function remindersState(dep) {
  if (!dep) return 'not_set_up';
  return dep.status === 'active' && chase.mergeConfig(dep.config).enabled !== false ? 'on' : 'paused';
}

/**
 * Everything about reminding one customer now, without sending anything.
 * @returns {Promise<{found:false, party:string} | object>}
 */
async function prepare(userId, partyQuery) {
  const query = String(partyQuery || '').slice(0, 160);
  const pos = (await moneyModel.positionForAccount(userId, { dirs: ['recv'], withRows: true })).receivables;
  const item = chase.pickReminderItem(chase.chaseItemsFromPosition(pos.groups).items, query);
  if (!item) return { found: false, party: query };
  const k = normPartyName(item.party);
  const [parties, deps, targets, businessName, sendsOff] = await Promise.all([
    selectRows('ledger_parties', `select=id,name,phone,external_refs&user_id=eq.${userId}&limit=5000`).catch(() => []),
    selectRows('agent_deployments', `select=status,config&user_id=eq.${userId}&agent_id=eq.chase_agent&limit=1`).catch(() => []),
    selectRows('whatsapp_chase_targets', `select=*&user_id=eq.${userId}&receivable_id=eq.${encodeURIComponent(item.receivable_id)}&limit=1`).catch(() => []),
    businessNameFor(userId),
    sendGuard.accountSendsOff(userId).catch(() => false)
  ]);
  let same = parties.filter((p) => normPartyName(p.name) === k);
  // Renamed in Tally but the party still carries the name the owner typed: find it by the ledger's Tally id.
  if (!same.some((p) => waNumber(p.phone))) {
    const guids = new Set(((await selectRows('tally_ledgers', `select=tally_guid&user_id=eq.${userId}&name=eq.${encodeURIComponent(item.party)}&limit=5`).catch(() => [])) || [])
      .map((r) => String(r.tally_guid || '').split('~')[0]).filter(Boolean));
    const byId = guids.size ? parties.filter((p) => guids.has(String((p.external_refs || {}).tally_guid || ''))) : [];
    if (byId.length) same = same.concat(byId.filter((p) => !same.includes(p)));
  }
  const party = same.find((p) => waNumber(p.phone)) || same.find((p) => p.phone) || same[0] || null;
  const dep = deps[0] || null, config = chase.mergeConfig(dep && dep.config);
  const target = targets[0] || null;
  const savedPhone = (target && target.contact_phone) || (party && party.phone) || '';
  const phone = waNumber(savedPhone) || waNumber(party && party.phone) || '';
  const n = target ? Number(target.chases_sent) || 0 : 0;
  const tier = chase.resolveTier(n, item.due || null, config, target ? Number(target.broken_promise_count) || 0 : 0);
  const msg = chase.buildChaseMessage({ tier, tonePreset: config.tone_preset, businessName, invoiceRef: item.ref, amount: item.amount, dueDate: item.due });
  // The same refusals as the 10:30 run, plus one a day: a customer on the business opt-out list (replied STOP),
  // switched off, a wrong number, inside a promise to pay, or already reminded in the last 20 hours.
  const optedOut = !!phone && Array.isArray(config.opt_out) && config.opt_out.map(digits).includes(phone);
  const promiseUntil = target && target.state === 'paused_promise' && target.promise_to_pay_date && String(target.promise_to_pay_date).slice(0, 10) >= new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10) ? String(target.promise_to_pay_date).slice(0, 10) : null;
  const remindedAt = target && target.last_chase_at && Date.now() - Date.parse(target.last_chase_at) < 20 * 3600000 ? target.last_chase_at : null;
  const stopped = optedOut ? 'opted_out' : target && ['stopped', 'opted_out', 'wrong_contact'].includes(target.state) ? target.state
    : promiseUntil ? 'promised' : remindedAt ? 'reminded_recently' : null;
  const out = {
    party: item.party, amount: item.amount, invoice_ref: item.ref || null, due_date: item.due || null, party_id: party ? party.id : null,
    has_phone: !!phone, phone_end: phone ? phone.slice(-4) : null,
    // a number is saved but WhatsApp can't reach it (a landline, or cut short)
    phone_unusable: !phone && !!digits(savedPhone),
    text: msg.body, template_ready: !!msg.templateId, sends_off: sendsOff, chase_number: n + 1, stopped,
    promise_until: promiseUntil, reminded_at: remindedAt, reminders: remindersState(dep)
  };
  out.reminders_off = remindersOffSay({ out, item }, 'app');   // the words the app shows instead of a Send button
  return { found: true, item, party, dep, config, target, phone, n, tier, msg, stopped, promiseUntil, sendsOff, out };
}

/** Plain words for a customer the 10:30 run would also leave alone. null when nothing stops it. */
function stoppedWhy(prep) {
  const { stopped, item, promiseUntil } = prep;
  if (!stopped) return null;
  return stopped === 'stopped' ? 'You switched reminders off for ' + item.party + ' (Automations > Chasing).'
    : stopped === 'promised' ? item.party + ' promised to pay by ' + promiseUntil + ', so no reminder until then.'
    : stopped === 'reminded_recently' ? item.party + ' was already reminded in the last day, so nothing was sent again.'
    : item.party + ' asked not to be messaged, or the number is wrong.';
}

/**
 * Send the prepared reminder. Same refusals as prepare() reported; never throws on a refusal.
 * @returns {Promise<{code:number, body:object}>}  code/body as the remind-now endpoint answers
 */
async function send(userId, prep) {
  const { item, party, dep, config, phone, n, tier, msg, out } = prep;
  let target = prep.target;
  const why = stoppedWhy(prep);
  if (why) return { code: 409, body: Object.assign({}, out, { error: why }) };
  if (!phone) return { code: 400, body: Object.assign({}, out, { error: 'need_phone' }) };
  // Payment reminders switched off for the account: nothing goes, from the app or WhatsApp (2026-11-23).
  const off = remindersOffSay(prep, 'app');
  if (off) return { code: 409, body: Object.assign({}, out, { error: off, reminders_off: true }) };
  if (!msg.templateId) return { code: 409, body: Object.assign({}, out, { error: 'The WhatsApp reminder template isn\'t set up yet, so nothing was sent.' }) };
  if (!target) {
    const rows = await insertRows('whatsapp_chase_targets', [{
      user_id: userId, receivable_id: item.receivable_id, party_id: party ? party.id : null, party_name: item.party || 'Customer',
      contact_phone: phone, amount: Number(item.amount) || 0, due_date: item.due || null, invoice_ref: item.ref || null,
      state: 'active', current_tier: tier, next_chase_at: null
    }], { onConflict: 'user_id,receivable_id', merge: false }).catch(() => null);
    target = (Array.isArray(rows) && rows[0]) || (await selectRows('whatsapp_chase_targets', `select=*&user_id=eq.${userId}&receivable_id=eq.${encodeURIComponent(item.receivable_id)}&limit=1`).catch(() => []))[0] || null;
    if (!target) return { code: 500, body: { error: 'Could not record the reminder, so nothing was sent.' } };
  }
  const result = await sendGuard.runAsAccount(userId, () => bsp.sendTemplate({ to: phone, templateId: msg.templateId, params: msg.params }));
  const nowIso = new Date().toISOString();
  const preview = !!(result && result.ok && result.blocked);
  const ok = !!(result && result.ok);
  if (ok && !preview) await deliveries.record({ messageId: result.messageId || null, userId, kind: 'chase', to: phone, sentTo: 'customer', ref: target.id });
  try {
    await insertRows('whatsapp_chases', [{
      user_id: userId, chase_target_id: target.id, receivable_id: target.receivable_id || null, party_id: target.party_id || null,
      invoice_ref: item.ref || null, contact_phone: phone, chase_number: n + 1, escalation_tier: tier, channel: 'whatsapp_template',
      tone_preset: config.tone_preset || 'friendly', template_name: msg.templateName, template_params: msg.params, message_body: msg.body,
      wa_message_id: ok ? result.messageId || null : null, status: preview ? 'skipped' : ok ? 'sent' : 'failed',
      error: preview ? chase.PREVIEW_NOTE : ok ? null : (result && result.error) || 'send failed', scheduled_for: nowIso, sent_at: ok && !preview ? nowIso : null
    }]);
  } catch (err) { console.error('remind-now: could not log the chase', err.message); }
  if (ok) {
    // The next reminder follows the owner's Chase settings, only where Chase is switched on.
    // A books customer gets automatic follow-ups only where Chase covers books ("Customers from your books"):
    // otherwise the manual-only 10:30 run doesn't track them, and a one-off stays a one-off.
    const followUp = remindersState(dep) === 'on' && (item.src === 'manual' || config.include_connectors === true);
    const nextAt = followUp ? chase.nextChaseAt(item.due || null, n + 1, config, new Date()) : null;
    await updateRows('whatsapp_chase_targets', `id=eq.${target.id}`, { chases_sent: n + 1, current_tier: tier, last_chase_at: nowIso, contact_phone: phone,
      next_chase_at: nextAt && n + 1 < config.max_chases ? nextAt.toISOString() : null }).catch(() => {});
  }
  await logConnectorEvent({ userId, connectorType: 'whatsapp', operation: 'chase_now_' + tier, status: ok ? 'success' : 'error',
    errorMessage: preview ? chase.PREVIEW_NOTE : ok ? null : (result && result.error) || null, recordsSynced: ok && !preview ? 1 : 0 }).catch(() => {});
  return { code: ok ? 200 : 502, body: Object.assign({}, out, { sent: ok && !preview, preview, error: ok ? undefined : 'WhatsApp didn\'t take the message: ' + ((result && result.error) || 'unknown error') }) };
}

/* ------------------------------------------------------------------ */
/* WhatsApp: may Margyn offer this reminder, and what to say if not    */
/* ------------------------------------------------------------------ */
const inrL = (n) => chase.inr(n);

/**
 * Plain words when payment reminders are off for the whole account, the same on both doors. null when on.
 * channel 'whatsapp' (paused): the switch is offered as a card, so no instructions; 'app': the one step.
 */
function remindersOffSay(prep, channel) {
  const state = prep.out.reminders, who = prep.item.party;
  if (state === 'on') return null;
  if (state === 'not_set_up') return 'Payment reminders aren\'t switched on for your business, so I can\'t send ' + who + ' one. To switch them on: in the Margyn app open Automations > Roster > Payment Chase and tap Deploy. Then ask me again.';
  return 'Payment reminders are switched off for your business, so I can\'t remind ' + who + ' right now.' +
    (channel === 'whatsapp' ? '' : ' To switch them back on: in the Margyn app open Automations > Roster > Payment Chase and tap Resume. Then ask me again.');
}

/** How to add the missing number: one step, where the owner keeps it. */
function addNumberStep(prep) {
  const who = prep.item.party;
  const where = 'In the Margyn app open Customers > ' + who + ' > Edit and type their mobile number in Phone.';
  return prep.item.src === 'tally'
    ? where + ' (Or add it as Mobile on their ledger in Tally: it comes across on the next sync.)'
    : where;
}

/**
 * The WhatsApp door's decision for "remind <customer>", checked before any Confirm card goes out
 * and again when the button is tapped (things change in between).
 *
 * @returns {{ can:true } | { can:false, reason:string, say:string, offer?:'resume_chase_agent' }}
 *   reason: not_found | stopped | need_phone | not_set_up | paused | template
 */
function whatsappVerdict(prep) {
  if (!prep || !prep.found) {
    const who = (prep && prep.party) || 'that customer';
    return { can: false, reason: 'not_found', say: 'I couldn\'t find anything ' + who + ' owes you in your books right now, so there\'s nothing to remind them about. If they do owe you, check the name and ask me again.' };
  }
  const who = prep.item.party, out = prep.out;
  const why = stoppedWhy(prep);
  if (why) return { can: false, reason: 'stopped', say: why };
  if (!prep.phone) {
    const lead = out.phone_unusable
      ? 'I can\'t remind ' + who + ' yet: the number saved for them doesn\'t look like a mobile, and WhatsApp reminders need one.'
      : 'I can\'t remind ' + who + ' yet: Margyn has no WhatsApp number for them.';
    const off = out.reminders !== 'on' ? ' Payment reminders are also switched off for your business; once the number is in, ask me again and I\'ll offer to switch them on.' : ' Then ask me again.';
    return { can: false, reason: 'need_phone', say: lead + ' ' + addNumberStep(prep) + off };
  }
  if (out.reminders === 'not_set_up') return { can: false, reason: 'not_set_up', say: remindersOffSay(prep, 'whatsapp') };
  if (out.reminders === 'paused') return { can: false, reason: 'paused', offer: 'resume_chase_agent', say: remindersOffSay(prep, 'whatsapp') };
  if (!out.template_ready) return { can: false, reason: 'template', say: 'The WhatsApp reminder template isn\'t set up yet, so I can\'t send ' + who + ' a reminder. Nothing was sent.' };
  return { can: true };
}

/** The Confirm card's line: who, how much, which number, and the exact words. */
function confirmSummary(prep) {
  const { item, out } = prep;
  const od = chase.daysOverdue(item.due, new Date());
  const facts = [item.ref, od > 0 ? od + ' day' + (od === 1 ? '' : 's') + ' overdue' : null].filter(Boolean).join(', ');
  return 'send ' + item.party + ' one WhatsApp payment reminder for ' + inrL(item.amount) + (facts ? ' (' + facts + ')' : '') +
    ', to their number ending ' + out.phone_end + '. It says:\n"' + out.text + '"' +
    (out.sends_off ? '\n(Preview only: this account doesn\'t send to customers, so nothing will reach them.)' : '');
}

/** The switch-on card offered when reminders are paused. */
function resumeSummary(prep) {
  return 'switch payment reminders back on for your business. They\'re off right now, which is why I couldn\'t remind ' + prep.item.party +
    '. Once on, Margyn also sends the usual morning reminders to customers with overdue bills, as set under Automations > Chasing. Then ask me again to remind ' + prep.item.party + '.';
}

/** What to tell the owner after the tapped reminder went (or didn't). */
function replyAfterSend(prep, r) {
  const who = prep.item.party;
  if (r.code === 200 && r.body.preview) return 'Preview only: this account doesn\'t send to customers, so nothing reached ' + who + '. It\'s logged under Automations > Chasing.';
  if (r.code === 200) return 'Sent ✅ ' + who + ' got one payment reminder for ' + inrL(prep.item.amount) + ' on WhatsApp (number ending ' + prep.out.phone_end + '). Their reply shows under Automations > Chasing.';
  return null;
}

module.exports = {
  prepare, send, stoppedWhy, remindersOffSay, whatsappVerdict, confirmSummary, resumeSummary, replyAfterSend,
  remindersState, waNumber, normPartyName
};
