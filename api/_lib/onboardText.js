/**
 * _lib/onboardText.js
 * "onboard" on WhatsApp (1 Nov 2026). The owner texts Margyn's number "onboard" (or "setup", "get started") and
 * Margyn answers with where their setup stands and the one link that starts the next step. A link opens the app
 * with ?setup=zoho|tally|odoo and Margyn (app/js/25-margyn.js) starts that connection on the page itself; the
 * owner's only click is Zoho's own Accept, which only they can give.
 * Rules, no AI call: the same text every time, nothing spent. A number that isn't on any Margyn account gets the
 * sign-up link and nothing about any business. CommonJS, zero-npm.
 */

const { selectRows } = require('./supabaseRest');
const { connectedBooks } = require('./booksSource');

const APP = 'https://www.margynlabs.com/app.html';
const ONBOARD = /^\s*(on[\s-]?board(ing)?|set[\s-]?up|set me up|get started|start setup|connect my books)\s*[.!]*\s*$/i;

/** Does this message ask to be onboarded? Only the whole message counts, so "how do I set up Chase?" still goes to the agent. */
function isOnboardText(text) {
  return ONBOARD.test(String(text || ''));
}

const n = (v) => Number(v || 0).toLocaleString('en-IN');

/** When the item details will be complete, in words (items.fillEta's shape). */
function etaWords(eta) {
  if (!eta || eta.when === 'done') return '';
  if (eta.when === 'today') return eta.minutes <= 60 ? `, done in about ${eta.minutes} minutes` : ', done later today';
  if (eta.when === 'tomorrow_morning') return ', done by tomorrow morning';
  if (eta.when === 'days') return `, done in about ${eta.days} days`;
  return '';
}

/**
 * The reply. Pure; exported for tests.
 *   known      the number is on a Margyn account
 *   books      ['zoho' | 'tally' | 'odoo', ...] connected now
 *   zoho       { name, items: { documents, read, pending, eta } | null } when Zoho is connected
 *   chaseOn    Chase is switched on
 */
function onboardReply({ known, books, zoho, chaseOn }) {
  if (!known) {
    return 'This number isn’t on a Margyn account yet. Sign up here: ' + APP + '?setup=start\n' +
      'Add this WhatsApp number in your company details, then text me "onboard" and I’ll take it from there.';
  }
  const b = books || [];
  if (!b.length) {
    return 'Let’s get your books into Margyn. Tap the one you use and I’ll start the connection for you. Margyn reads your books; it changes nothing in them.\n\n' +
      'Zoho Books: ' + APP + '?setup=zoho\n' +
      'Tally: ' + APP + '?setup=tally\n' +
      'Odoo: ' + APP + '?setup=odoo\n\n' +
      'For Zoho, your one step is pressing Accept on Zoho’s own page. Text me "onboard" any time to see how far it’s got.';
  }
  const lines = [];
  if (b.includes('zoho')) {
    const z = zoho || {};
    lines.push('✅ Zoho Books is connected' + (z.name ? ' (' + z.name + ')' : '') + '. Your sales, profit, cash and who owes what are in.');
    const it = z.items;
    if (it && it.documents) {
      lines.push(it.pending > 0
        ? '⏳ Item details (which products, how many): ' + n(it.read) + ' of ' + n(it.documents) + ' documents read' + etaWords(it.eta) + '. I keep reading on my own; nothing to do.'
        : '✅ Item details are all in: ' + n(it.documents) + ' documents.');
    }
  }
  if (b.includes('tally')) lines.push('✅ Tally is connected through the Margyn agent. Your figures update each time it syncs.');
  if (b.includes('odoo')) lines.push('✅ Odoo is connected.');
  lines.push(chaseOn
    ? '✅ Payment reminders (Chase) are on.'
    : 'Next: switch on payment reminders, so I can chase who owes you: ' + APP + '#/agents');
  lines.push('See your business: ' + APP + '#/home');
  return lines.join('\n');
}

/** What onboardReply needs, read for one account. Any read that fails just leaves that line out. */
async function onboardFacts(profileId) {
  const id = encodeURIComponent(profileId);
  const books = await connectedBooks(profileId).catch(() => []);
  let zoho = null;
  if (books.includes('zoho')) {
    const orgs = await selectRows('zoho_organizations',
      `select=id,organization_name,plan_type&user_id=eq.${id}&status=in.(active,needs_reauth)&order=connected_at.desc&limit=1`).catch(() => []);
    const org = orgs[0];
    zoho = { name: org ? org.organization_name : null, items: null };
    if (org) {
      try {
        const items = require('../_zoho/items');
        const state = await selectRows('zoho_line_state', `select=doc_type,doc_date,status,doc_last_modified,read_modified,lines_read_at&org_ref=eq.${org.id}&order=id.asc&limit=200000`);
        if (state.length) {
          const p = items.progressFrom(state);
          if (p.pending > 0) {
            const cap = await items.dailyCap(org);
            const usedToday = await items.callsUsedToday(org.id, Date.now());
            const lastAt = await items.lastCallsAt(org.id);
            p.eta = items.fillEta({ pending: p.pending, cap, usedToday, running: lastAt != null && Date.now() - lastAt < items.FILL_ACTIVE_MS });
          }
          zoho.items = p;
        }
      } catch (e) { /* item lines not switched on: the line is left out */ }
    }
  }
  const deps = await selectRows('agent_deployments', `select=status,config&user_id=eq.${id}&agent_id=eq.chase_agent&limit=1`).catch(() => []);
  const chaseOn = !!deps[0] && deps[0].status === 'active' && !(deps[0].config && deps[0].config.enabled === false);
  return { known: true, books, zoho, chaseOn };
}

module.exports = { isOnboardText, onboardReply, onboardFacts, etaWords, APP };
