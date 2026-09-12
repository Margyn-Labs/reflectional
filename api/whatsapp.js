/**
 * api/whatsapp.js
 * Single router for Opening Bell / Closing Bell WhatsApp delivery, merged
 * into one Vercel serverless function to stay under the Hobby plan's
 * 12-function cap — same reasoning as api/shopify.js. Splitting the inbound
 * webhook and the two outbound crons into three files would spend three
 * slots for logic that shares the same BSP adapter and Supabase access.
 *
 * Dispatch is by ?action= query param:
 *   GET  /api/whatsapp?action=webhook       BSP webhook-registration handshake
 *   POST /api/whatsapp?action=webhook       inbound Closing Bell button replies
 *   GET  /api/whatsapp?action=cron-opening  Vercel Cron target, sends Opening Bell
 *   GET  /api/whatsapp?action=cron-closing  Vercel Cron target, sends Closing Bell
 *
 * BSP adapter, template send, and webhook verification all live in
 * ./_lib/whatsappBsp.js — this file owns routing, auth, and the Supabase
 * reads/writes, not BSP-specific payload shapes.
 *
 * Body parsing is disabled (see module.exports.config below) so the inbound
 * webhook handler can HMAC-verify the raw bytes before trusting the JSON.
 */

const { getUserFromRequest, selectRows, insertRows, updateRows, logConnectorEvent } = require('./_lib/supabaseRest');
const bsp = require('./_lib/whatsappBsp');
const { runConversation } = require('./_lib/whatsappAgent');
const { track } = require('./_lib/track');
const chase = require('./_lib/chaseEngine');
const { runImportMapper } = require('./_lib/importMapper');

module.exports = async function handler(req, res) {
  const action = (req.query && req.query.action) || '';

  if (action === 'webhook' && req.method === 'GET') return handleWebhookVerify(req, res);
  if (action === 'webhook' && req.method === 'POST') return handleWebhookEvent(req, res);
  if (action === 'cron-opening' && req.method === 'GET') return handleCron(req, res, 'opening');
  if (action === 'cron-closing' && req.method === 'GET') return handleCron(req, res, 'closing');
  if (action === 'cron-chase' && req.method === 'GET') return handleChaseCron(req, res);

  res.status(400).json({ error: 'unknown_action', message: 'Expected ?action= one of webhook, cron-opening, cron-closing, cron-chase.' });
};

// Raw body needed for webhook signature verification — see verifyInboundRequest.
module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* webhook — GET ?action=webhook (registration handshake)             */
/* ------------------------------------------------------------------ */
function handleWebhookVerify(req, res) {
  if (bsp.checkVerifyToken(req.query || {})) {
    res.status(200).send(String(req.query['hub.challenge'] || ''));
    return;
  }
  res.status(403).json({ error: 'verification_failed' });
}

/* ------------------------------------------------------------------ */
/* webhook — POST ?action=webhook (inbound Closing Bell button reply) */
/* ------------------------------------------------------------------ */
async function handleWebhookEvent(req, res) {
  const rawBody = await readRawBody(req);

  if (!bsp.verifyInboundRequest(req, rawBody)) {
    res.status(401).json({ error: 'invalid_signature' });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8') || '{}');
  } catch {
    // Always 200 an unparseable body — WhatsApp/BSP retries and can
    // eventually disable the webhook if it sees repeated non-2xx.
    res.status(200).json({ received: true });
    return;
  }

  const event = bsp.parseInboundEvent(payload);
  if (!event) {
    // Not a button reply. Try a forwarded image/document next (the
    // WhatsApp import-suggestion path, 2026-09-12) — a media message
    // won't parse as either of the other two shapes, so this must run
    // before the free-text fallback below.
    const mediaEvent = bsp.parseInboundMedia(payload);
    if (mediaEvent) {
      await handleMediaInbound(res, mediaEvent);
      return;
    }
    // Not media either. If it's a free-text message, it's either a Margyn
    // user talking to the conversational agent, or a customer replying to a
    // payment chase. Chase targets are checked FIRST — a customer's number is
    // never in `profiles`, and the conversational agent must never run for a
    // non-user sender (it would answer with the business's financials).
    const textEvent = bsp.parseInboundText(payload);
    if (textEvent && textEvent.text && textEvent.text.trim()) {
      const chaseTarget = await matchChaseTarget(textEvent.from);
      if (chaseTarget) {
        await handleChaseReply(res, chaseTarget, textEvent, payload);
      } else {
        await handleConversationalInbound(res, textEvent);
      }
    } else {
      res.status(200).json({ received: true, ignored: true });
    }
    return;
  }

  try {
    const matches = await selectRows(
      'profiles',
      `select=id&whatsapp_phone=eq.${encodeURIComponent(normalizePhone(event.from))}`
    );

    if (!matches.length) {
      // No Margyn user on this number — it may be a customer tapping the
      // "Reply" quick-reply button on a chase template (which just opens the
      // 24h session window). Treat the button text as their reply.
      const chaseTarget = await matchChaseTarget(event.from);
      if (chaseTarget) {
        await handleChaseReply(res, chaseTarget, {
          from: event.from,
          text: event.buttonText || '',
          wamid: event.wamid,
          contextMessageId: event.contextMessageId
        }, payload);
        return;
      }
      console.error('whatsapp webhook: no profile matches phone', event.from);
      res.status(200).json({ received: true, matched: false });
      return;
    }

    const replyType = bsp.classifyReply(event);

    await insertRows('whatsapp_replies', [{
      user_id: matches[0].id,
      // Only Closing Bell carries interactive buttons — Opening Bell is a
      // one-way morning digest — so any button-reply event is a Closing
      // Bell reply by construction.
      briefing_type: 'closing',
      wa_message_id: event.wamid,
      context_message_id: event.contextMessageId,
      from_phone: event.from,
      reply_type: replyType,
      reply_text: event.buttonText,
      replied_at: new Date(event.timestampMs).toISOString(),
      raw_payload: payload
    }]);

    track(matches[0].id, 'whatsapp_inbound', { kind: 'button', reply_type: replyType }); // ops console

    // An unrecognized button reply is treated as free text — hand it to the
    // conversational routing layer instead of just logging it.
    if (replyType === 'unrecognized' && event.buttonText && event.buttonText.trim()) {
      try {
        await runConversation({
          profileId: matches[0].id,
          fromPhone: event.from,
          text: event.buttonText,
          wamid: event.wamid,
          contextMessageId: event.contextMessageId
        });
      } catch (err) {
        console.error('whatsapp webhook: conversational handoff failed', err.message);
      }
    }
  } catch (err) {
    console.error('whatsapp webhook: failed to persist reply', err.message);
    // Still 200 — the failure is ours to chase in logs, not WhatsApp's to retry forever.
  }

  if (!res.headersSent) res.status(200).json({ received: true });
}

/* ------------------------------------------------------------------ */
/* WhatsApp import path — a registered number forwards an invoice/bill/ */
/* receipt (image or PDF). Added 2026-09-12.                            */
/* ------------------------------------------------------------------ */
// Bounds both abuse (a compromised/looping number) and Claude spend — same
// spirit as the 2 MB client-side cap on the browser upload path.
const WA_MAX_SUGGESTIONS_PER_DAY = 20;
const WA_MAX_MEDIA_BYTES = 2 * 1024 * 1024;
const WA_SUPPORTED_MEDIA_MIME = {
  'image/jpeg': 'image/jpeg', 'image/png': 'image/png',
  'image/webp': 'image/webp', 'image/gif': 'image/gif',
  'application/pdf': 'application/pdf'
};
const WA_IMPORT_TARGET_LABEL = {
  cash: 'Cash in bank', revenue: 'Revenue', net_profit: 'Net profit', burn: 'Operating expenses',
  gst_payable: 'GST payable', gst_leak: 'Unclaimed GST ITC', receivable: 'Receivable',
  payable: 'Payable', payments: 'Gross payments'
};

/**
 * A forwarded image/PDF never writes straight to the ledger — it always
 * lands in import_suggestions as status:'pending' and waits for the human
 * to approve it in the app's Suggestions tab. This mirrors the "AI
 * proposes, human decides" rule the browser upload path already follows;
 * it matters MORE here since there's no live confirm-click moment on
 * WhatsApp itself.
 *
 * NOTE (flagged, not fully verifiable pre-launch): the Gupshup media
 * webhook shape (bsp.parseInboundMedia) and whether its media URLs are
 * fetchable without extra auth have never been exercised against a real
 * Gupshup account — same caveat the existing button/text parsers carry.
 * Expect one field-name fix once a real forwarded photo hits this path.
 */
async function handleMediaInbound(res, mediaEvent) {
  try {
    // Dedupe FIRST, before any other work — the BSP can (and, per the first
    // live test, does) redeliver the same webhook event if it doesn't get a
    // fast enough 200 back, and this handler's own chain (phone lookup +
    // media download + a Claude vision call) easily runs long enough to
    // trigger that. Without this check, every redelivery re-ran the whole
    // pipeline: a duplicate suggestion row AND a duplicate WhatsApp reply
    // per retry. Checked before the phone lookup specifically so a retry
    // costs one cheap indexed SELECT, not a repeat Claude call.
    if (mediaEvent.wamid) {
      const already = await selectRows(
        'import_suggestions',
        `select=id&wa_message_id=eq.${encodeURIComponent(mediaEvent.wamid)}&limit=1`
      ).catch(() => []);
      if (already.length) {
        res.status(200).json({ received: true, duplicate: true });
        return;
      }
    }

    const phone = normalizePhone(mediaEvent.from);
    const matches = await selectRows(
      'profiles',
      `select=id,company_name,gst_number&whatsapp_phone=eq.${encodeURIComponent(phone)}`
    );
    if (!matches.length) {
      // Not a registered number. Say nothing back — replying would confirm
      // to a stranger which numbers ARE registered Margyn accounts.
      res.status(200).json({ received: true, matched: false });
      return;
    }
    const profile = matches[0];

    const mime = WA_SUPPORTED_MEDIA_MIME[String(mediaEvent.contentType || '').split(';')[0].trim().toLowerCase()];
    if (!mime) {
      await bsp.sendText({ to: mediaEvent.from, text: 'Margyn can read JPG, PNG or PDF files right now — could you resend it as one of those?' });
      res.status(200).json({ received: true, unsupported: true });
      return;
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const todaysSuggestions = await selectRows(
      'import_suggestions',
      `select=id&user_id=eq.${profile.id}&received_at=gte.${encodeURIComponent(since)}`
    ).catch(() => []);
    if (todaysSuggestions.length >= WA_MAX_SUGGESTIONS_PER_DAY) {
      await bsp.sendText({ to: mediaEvent.from, text: `You've hit today's limit of ${WA_MAX_SUGGESTIONS_PER_DAY} WhatsApp imports — try again tomorrow, or use the app.` });
      res.status(200).json({ received: true, rate_limited: true });
      return;
    }

    let base64;
    try {
      const fileRes = await fetch(mediaEvent.url);
      if (!fileRes.ok) throw new Error('media fetch failed: ' + fileRes.status);
      const arrayBuf = await fileRes.arrayBuffer();
      if (arrayBuf.byteLength > WA_MAX_MEDIA_BYTES) {
        await bsp.sendText({ to: mediaEvent.from, text: 'That file is over 2 MB — could you send a smaller version?' });
        res.status(200).json({ received: true, too_large: true });
        return;
      }
      base64 = Buffer.from(arrayBuf).toString('base64');
    } catch (err) {
      console.error('whatsapp media: download failed', err.message);
      await bsp.sendText({ to: mediaEvent.from, text: "Couldn't download that file just now — mind resending it?" });
      res.status(200).json({ received: true, download_failed: true });
      return;
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('whatsapp media: ANTHROPIC_API_KEY not set');
      res.status(200).json({ received: true });
      return;
    }

    let proposal;
    try {
      const result = await runImportMapper({ kind: 'document', mime, base64, business: profile.company_name, gstin: profile.gst_number }, apiKey);
      proposal = result.proposal;
    } catch (err) {
      console.error('whatsapp media: mapper failed', err.message);
      await bsp.sendText({ to: mediaEvent.from, text: "Couldn't read that file just now — try again in a bit, or upload it in the app instead." });
      res.status(200).json({ received: true, mapper_failed: true });
      return;
    }

    // onConflict + ignore-duplicates is a second, DB-level dedupe layer for
    // the rare case where two redeliveries of the same wamid both pass the
    // early SELECT check above before either has inserted (a genuine race,
    // not just a slow-response retry). Requires the unique constraint on
    // wa_message_id added in 2026-09-12b-import-suggestions-dedupe.sql.
    const inserted = mediaEvent.wamid
      ? await insertRows('import_suggestions', [{
          user_id: profile.id, status: 'pending', source: 'whatsapp', proposal,
          from_phone: mediaEvent.from, wa_message_id: mediaEvent.wamid,
          mime_type: mime, received_at: new Date().toISOString()
        }], { onConflict: 'wa_message_id' })
      : await insertRows('import_suggestions', [{
          user_id: profile.id, status: 'pending', source: 'whatsapp', proposal,
          from_phone: mediaEvent.from, wa_message_id: null,
          mime_type: mime, received_at: new Date().toISOString()
        }]);

    if (!inserted.length) {
      // Lost the race — another concurrent delivery of this same wamid won
      // and already sent the WhatsApp reply. Don't send a second one.
      res.status(200).json({ received: true, duplicate: true });
      return;
    }

    track(profile.id, 'whatsapp_import_suggestion', {
      entries: (proposal.entries || []).length,
      anomalies: (proposal.anomalies || []).length
    });

    await bsp.sendText({ to: mediaEvent.from, text: summarizeForWhatsapp(proposal) });
    res.status(200).json({ received: true, suggestion: true });
  } catch (err) {
    console.error('whatsapp media inbound failed:', err.message);
    if (!res.headersSent) res.status(200).json({ received: true });
  }
}

function summarizeForWhatsapp(proposal) {
  const entries = proposal.entries || [];
  const anomalies = proposal.anomalies || [];
  if (!entries.length && !anomalies.length) {
    return "Margyn couldn't find anything it recognised in that file.";
  }
  let msg;
  if (entries.length) {
    const lines = entries.slice(0, 5).map(e => {
      const label = WA_IMPORT_TARGET_LABEL[e.target] || e.target;
      const amount = '₹' + Math.round(e.amount).toLocaleString('en-IN');
      return `• ${label}${e.party ? ' — ' + e.party : ''} — ${amount}`;
    });
    msg = 'Got it — found:\n' + lines.join('\n');
    if (entries.length > 5) msg += `\n…and ${entries.length - 5} more`;
  } else {
    msg = 'Got it — nothing clear enough to import,';
  }
  if (anomalies.length) msg += `\n${anomalies.length} item(s) flagged for review.`;
  msg += '\n\nOpen Margyn → Suggestions to approve or reject.';
  return msg;
}

/* ------------------------------------------------------------------ */
/* Conversational routing layer — inbound free-text messages           */
/* ------------------------------------------------------------------ */
async function handleConversationalInbound(res, textEvent) {
  // We must finish the Claude loop BEFORE responding — Vercel terminates a
  // Node function once its response is sent, so "ack early, work later" drops
  // the reply. That means the response can take ~8s, and the BSP may retry
  // the delivery in the meantime. Retries are made harmless by the wamid
  // dedupe in runConversation (persistent — checks whatsapp_conversations).
  let matches;
  try {
    matches = await selectRows(
      'profiles',
      `select=id&whatsapp_phone=eq.${encodeURIComponent(normalizePhone(textEvent.from))}`
    );
  } catch (err) {
    console.error('whatsapp webhook: profile lookup failed', err.message);
    return;
  }

  if (!matches.length) {
    console.error('whatsapp webhook: no profile matches phone', textEvent.from);
    return;
  }

  try {
    await runConversation({
      profileId: matches[0].id,
      fromPhone: textEvent.from,
      text: textEvent.text,
      wamid: textEvent.wamid,
      contextMessageId: textEvent.contextMessageId
    });
    // ops console — inbound question + the agent's outbound reply
    track(matches[0].id, 'whatsapp_inbound', { kind: 'conversational', msg_len: String(textEvent.text || '').length });
    track(matches[0].id, 'whatsapp_outbound', { kind: 'agent_reply' });
  } catch (err) {
    console.error('whatsapp webhook: conversational inbound failed', err.message);
  }

  if (!res.headersSent) res.status(200).json({ received: true, conversational: true });
}

function normalizePhone(phone) {
  return String(phone || '').replace(/[^\d]/g, '');
}

/* ------------------------------------------------------------------ */
/* cron-opening / cron-closing — GET (Vercel Cron target)             */
/* ------------------------------------------------------------------ */
async function handleCron(req, res, kind) {
  const authHeader = req.headers['authorization'];
  const querySecret = req.query.cron_secret;
  const expected = process.env.CRON_SECRET;

  if (!expected) {
    res.status(500).json({ error: 'CRON_SECRET not configured' });
    return;
  }
  const authValid = authHeader === `Bearer ${expected}` || querySecret === expected;
  if (!authValid) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const templateId = kind === 'opening'
    ? process.env.WHATSAPP_TEMPLATE_OPENING
    : process.env.WHATSAPP_TEMPLATE_CLOSING;

  if (!templateId) {
    res.status(500).json({ error: `WHATSAPP_TEMPLATE_${kind.toUpperCase()} not configured` });
    return;
  }

  const startedAt = Date.now();

  // The Agents tab (agent_deployments) is the control surface for the Bell:
  // deploying sets status='active', pausing sets status='paused' (and leaves
  // whatsapp_opt_in alone). Only 'active' deployments get a Bell — a paused
  // agent must go quiet. A user with no agent_deployments row is treated as
  // NOT deployed; backfill active rows for any pre-Agents-tab pilot (see the
  // deploy runbook) rather than loosening this.
  let recipients;
  try {
    const deployments = await selectRows(
      'agent_deployments',
      "select=user_id,config&agent_id=eq.whatsapp_bell&status=eq.active"
    );
    if (!deployments.length) {
      res.status(200).json({ kind, sent: 0, failed: 0, total_recipients: 0, note: 'no active whatsapp_bell deployments' });
      return;
    }

    // config.frequency lets a user opt one Bell out ('opening' | 'closing' |
    // 'both' | 'none'). Absent/unknown value = both, so existing rows are safe.
    const wantsThisBell = (cfg) => {
      const f = (cfg && cfg.frequency) || 'both';
      return f === 'both' || f === kind;
    };
    const activeById = new Map(
      deployments.filter(d => wantsThisBell(d.config)).map(d => [d.user_id, d.config || {}])
    );
    if (!activeById.size) {
      res.status(200).json({ kind, sent: 0, failed: 0, total_recipients: 0, note: `no active deployments want the ${kind} bell` });
      return;
    }

    const ids = Array.from(activeById.keys());
    const profiles = await selectRows(
      'profiles',
      `select=id,whatsapp_phone,company_name&whatsapp_opt_in=eq.true&whatsapp_phone=not.is.null&id=in.(${ids.join(',')})`
    );
    recipients = profiles.map(p => ({ ...p, config: activeById.get(p.id) || {} }));
  } catch (err) {
    res.status(500).json({ error: 'Could not list opted-in recipients' });
    return;
  }

  let sent = 0;
  const failed = [];

  for (const profile of recipients) {
    try {
      // Content selection (what goes in the template params — Pulse Score
      // delta, top urgent findings, % vitals movement) belongs to
      // margyn-fin-guy; this is a placeholder query against `findings` so
      // the delivery pipeline is end-to-end testable today. Swap the body
      // of getBriefingParams() for the finalized query/params without
      // touching anything above it.
      const params = await getBriefingParams(profile.id, kind);
      const result = await bsp.sendTemplate({ to: profile.whatsapp_phone, templateId, params });

      if (!result.ok) {
        failed.push({ userId: profile.id, reason: result.error });
        await logConnectorEvent({ userId: profile.id, connectorType: 'whatsapp', operation: `send_${kind}`, status: 'error', errorMessage: result.error });
        continue;
      }

      sent++;
      await logConnectorEvent({ userId: profile.id, connectorType: 'whatsapp', operation: `send_${kind}`, status: 'success', recordsSynced: 1 });
      track(profile.id, 'whatsapp_outbound', { kind }); // ops console — opening/closing bell
    } catch (err) {
      failed.push({ userId: profile.id, reason: err.message });
    }
  }

  res.status(200).json({
    kind,
    sent,
    failed: failed.length,
    failed_users: failed,
    total_recipients: recipients.length,
    duration_ms: Date.now() - startedAt,
    timestamp: new Date().toISOString()
  });
}

/* ================================================================== */
/* WhatsApp Chase Agent                                                */
/* ================================================================== */

function normPartyName(s) {
  return String(s || '').toLowerCase()
    .replace(/\b(pvt|private|ltd|limited|llp|inc|co|corp|corporation|company|the|and)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Find a non-terminal chase target for an inbound sender phone. A customer's
 * number is never in `profiles`, so this is how a chase reply is recognised.
 */
async function matchChaseTarget(fromPhone) {
  const phone = normalizePhone(fromPhone);
  if (!phone) return null;
  try {
    const rows = await selectRows(
      'whatsapp_chase_targets',
      `select=*&contact_phone=eq.${encodeURIComponent(phone)}` +
        `&state=not.in.(opted_out,resolved_paid)&order=updated_at.desc&limit=1`
    );
    return rows[0] || null;
  } catch (err) {
    console.error('chase: matchChaseTarget failed', err.message);
    return null;
  }
}

/**
 * A customer replied to a payment chase. Classify the reply, log it, advance
 * the target's state machine, and acknowledge inside the open session window.
 * Always 200s — a failure here is ours to chase in logs, not the BSP's to retry.
 */
async function handleChaseReply(res, target, textEvent, rawPayload) {
  const wamid = textEvent.wamid;

  // Dedupe BSP webhook retries.
  if (wamid) {
    try {
      const seen = await selectRows(
        'whatsapp_chase_replies',
        `select=id&wa_message_id=eq.${encodeURIComponent(wamid)}&limit=1`
      );
      if (seen.length) {
        if (!res.headersSent) res.status(200).json({ received: true, duplicate: true });
        return;
      }
    } catch (e) { /* fall through — never block a real reply on a dedupe failure */ }
  }

  const text = String(textEvent.text || '').trim();
  let classified;
  try {
    classified = await chase.classifyReply(text, target.invoice_ref
      ? `Chasing invoice ${target.invoice_ref} for ${chase.inr(target.amount)}.` : null);
  } catch (e) {
    classified = { intent: 'unclear', promise_date: null, promise_amount: null, classified_by: 'rule' };
  }

  let config = {};
  try {
    const dep = await selectRows(
      'agent_deployments',
      `select=config&user_id=eq.${target.user_id}&agent_id=eq.chase_agent&limit=1`
    );
    config = (dep[0] && dep[0].config) || {};
  } catch (e) { /* defaults */ }

  try {
    await insertRows('whatsapp_chase_replies', [{
      user_id: target.user_id,
      chase_target_id: target.id,
      in_reply_to_chase: textEvent.contextMessageId || null,
      from_phone: textEvent.from,
      reply_text: text || null,
      intent: classified.intent,
      promise_date: classified.promise_date || null,
      promise_amount: classified.promise_amount || null,
      classified_by: classified.classified_by || 'rule',
      wa_message_id: wamid || null,
      raw_payload: rawPayload || {}
    }]);
  } catch (err) {
    console.error('chase: failed to persist reply', err.message);
  }

  const { patch, ack } = chase.applyReplyToTarget(target, classified, config);

  // opt-out also lands the number on the per-business opt-out list so the cron
  // never re-queues it from a fresh receivable.
  if (classified.intent === 'opt_out') {
    try {
      const optOut = Array.isArray(config.opt_out) ? config.opt_out.slice() : [];
      const digits = normalizePhone(textEvent.from);
      if (digits && !optOut.includes(digits)) {
        optOut.push(digits);
        await updateRows(
          'agent_deployments',
          `user_id=eq.${target.user_id}&agent_id=eq.chase_agent`,
          { config: Object.assign({}, config, { opt_out: optOut }) }
        );
      }
    } catch (e) { console.error('chase: opt-out list update failed', e.message); }
  }

  try {
    await updateRows('whatsapp_chase_targets', `id=eq.${target.id}`, patch);
  } catch (err) {
    console.error('chase: failed to update target', err.message);
  }

  if (ack) {
    try { await bsp.sendText({ to: textEvent.from, text: ack }); }
    catch (e) { console.error('chase: ack send failed', e.message); }
  }

  if (!res.headersSent) res.status(200).json({ received: true, chase_reply: true, intent: classified.intent });
}

/* ------------------------------------------------------------------ */
/* cron-chase — GET ?action=cron-chase (Vercel Cron target)           */
/* ------------------------------------------------------------------ */
async function handleChaseCron(req, res) {
  const authHeader = req.headers['authorization'];
  const querySecret = req.query.cron_secret;
  const expected = process.env.CRON_SECRET;
  if (!expected) { res.status(500).json({ error: 'CRON_SECRET not configured' }); return; }
  if (authHeader !== `Bearer ${expected}` && querySecret !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const startedAt = Date.now();
  const SEND_BUDGET = Number(process.env.CHASE_MAX_SENDS_PER_RUN || 200);

  let deployments;
  try {
    deployments = await selectRows(
      'agent_deployments',
      "select=user_id,config&agent_id=eq.chase_agent&status=eq.active"
    );
  } catch (err) {
    res.status(500).json({ error: 'Could not list chase_agent deployments' });
    return;
  }
  if (!deployments.length) {
    res.status(200).json({ sent: 0, note: 'no active chase_agent deployments' });
    return;
  }

  let sent = 0, failed = 0, queued = 0, skipped_no_phone = 0, escalated = 0;
  let budget = SEND_BUDGET;

  for (const dep of deployments) {
    const config = chase.mergeConfig(dep.config);
    if (config.enabled === false) continue;

    try {
      const q = await syncChaseQueue(dep.user_id, config);
      queued += q.created;
      skipped_no_phone += q.skipped_no_phone;
    } catch (err) {
      console.error('chase: syncChaseQueue failed for', dep.user_id, err.message);
    }

    if (budget <= 0) continue;

    let due;
    try {
      due = await selectRows(
        'whatsapp_chase_targets',
        `select=*&user_id=eq.${dep.user_id}&state=in.(active,paused_promise)` +
          `&next_chase_at=not.is.null&next_chase_at=lte.${new Date().toISOString()}` +
          `&order=next_chase_at.asc&limit=${Math.min(budget, 500)}`
      );
    } catch (err) {
      console.error('chase: could not load due targets for', dep.user_id, err.message);
      continue;
    }

    for (const target of due) {
      if (budget <= 0) break;
      if (!target.contact_phone) { skipped_no_phone++; continue; }
      if (Array.isArray(config.opt_out) && config.opt_out.includes(normalizePhone(target.contact_phone))) {
        await updateRows('whatsapp_chase_targets', `id=eq.${target.id}`,
          { state: 'opted_out', resolution: 'On the business opt-out list.', next_chase_at: null }).catch(() => {});
        continue;
      }

      // A promise-to-pay window has elapsed and the receivable is still open
      // (syncChaseQueue would have flipped it to resolved_paid otherwise).
      // Treat it as a broken promise: resume, one tier firmer.
      let brokenBumps = target.broken_promise_count || 0;
      if (target.state === 'paused_promise') {
        brokenBumps += 1;
        await updateRows('whatsapp_chase_targets', `id=eq.${target.id}`, {
          state: 'active', broken_promise_count: brokenBumps
        }).catch(() => {});
      }

      const chaseNumber = (target.chases_sent || 0) + 1;

      // Hard stop -> hand to the founder.
      if (chaseNumber > config.max_chases) {
        await updateRows('whatsapp_chase_targets', `id=eq.${target.id}`, {
          state: 'escalated_human',
          resolution: `No resolution after ${target.chases_sent} chases.`,
          next_chase_at: null
        }).catch(() => {});
        escalated++;
        continue;
      }

      const tier = chase.resolveTier(chaseNumber - 1, target.due_date, config, brokenBumps);
      const businessName = await businessNameFor(dep.user_id);
      const msg = chase.buildChaseMessage({
        tier, tonePreset: config.tone_preset, businessName,
        invoiceRef: target.invoice_ref, amount: target.amount, dueDate: target.due_date
      });

      const nowIso = new Date().toISOString();
      let status = 'sent', error = null, waMessageId = null;

      if (!msg.templateId) {
        status = 'skipped';
        error = `Template ${msg.templateName} has no configured id (WHATSAPP_TEMPLATE_${msg.templateName.toUpperCase()})`;
      } else {
        const result = await bsp.sendTemplate({ to: target.contact_phone, templateId: msg.templateId, params: msg.params });
        if (!result.ok) { status = 'failed'; error = result.error; failed++; }
        else { waMessageId = result.messageId || null; sent++; budget--; }
      }

      try {
        await insertRows('whatsapp_chases', [{
          user_id: dep.user_id,
          chase_target_id: target.id,
          receivable_id: target.receivable_id || null,
          party_id: target.party_id || null,
          invoice_ref: target.invoice_ref || null,
          contact_phone: target.contact_phone,
          chase_number: chaseNumber,
          escalation_tier: tier,
          channel: 'whatsapp_template',
          tone_preset: config.tone_preset || 'friendly',
          template_name: msg.templateName,
          template_params: msg.params,
          message_body: msg.body,
          wa_message_id: waMessageId,
          status,
          error,
          scheduled_for: target.next_chase_at,
          sent_at: status === 'sent' ? nowIso : null
        }]);
      } catch (err) {
        console.error('chase: failed to log chase attempt', err.message);
      }

      // Advance the target regardless of a send failure — a failed template
      // (e.g. wallet, rate limit) shouldn't wedge the whole sequence; the next
      // run retries at the next scheduled slot.
      const nextIdx = chaseNumber; // 0-based index of the *next* chase
      const nextAt = chase.nextChaseAt(target.due_date, nextIdx, config, new Date());
      const patch = {
        chases_sent: status === 'sent' ? chaseNumber : (target.chases_sent || 0),
        current_tier: tier
      };
      if (status === 'sent') {
        patch.last_chase_at = nowIso;
        if (nextIdx >= config.max_chases || !nextAt) {
          patch.state = 'escalated_human';
          patch.resolution = `No resolution after ${chaseNumber} chases.`;
          patch.next_chase_at = null;
          escalated++;
        } else {
          patch.next_chase_at = nextAt.toISOString();
        }
      } else if (status === 'skipped') {
        // No template configured — don't retry every run and pile up skipped
        // rows; check back tomorrow.
        patch.next_chase_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      }
      // status === 'failed' leaves next_chase_at untouched -> retried next run.
      await updateRows('whatsapp_chase_targets', `id=eq.${target.id}`, patch).catch((e) =>
        console.error('chase: target advance failed', e.message));

      await logConnectorEvent({
        userId: dep.user_id, connectorType: 'whatsapp',
        operation: `chase_${tier}`, status: status === 'sent' ? 'success' : 'error',
        errorMessage: error, recordsSynced: status === 'sent' ? 1 : 0
      });
    }
  }

  res.status(200).json({
    deployments: deployments.length,
    queued, sent, failed, escalated, skipped_no_phone,
    duration_ms: Date.now() - startedAt,
    timestamp: new Date().toISOString()
  });
}

const _bizNameCache = new Map();
async function businessNameFor(userId) {
  if (_bizNameCache.has(userId)) return _bizNameCache.get(userId);
  let name = 'your supplier';
  try {
    const p = await selectRows('profiles', `select=company_name&id=eq.${userId}&limit=1`);
    if (p[0] && p[0].company_name) name = p[0].company_name;
  } catch (e) { /* default */ }
  _bizNameCache.set(userId, name);
  return name;
}

/**
 * Reconcile whatsapp_chase_targets against the current open receivables:
 *   - create a target (with a resolved phone) for each newly-eligible receivable
 *   - mark a target resolved_paid when its receivable is no longer open
 * Returns { created, skipped_no_phone }.
 */
async function syncChaseQueue(userId, config) {
  const c = chase.mergeConfig(config);
  let created = 0, skipped_no_phone = 0;

  let receivables = [];
  try {
    receivables = await selectRows(
      'receivables',
      `select=id,party_name,amount,due_date,status&user_id=eq.${userId}&status=eq.open&limit=1000`
    );
  } catch (err) {
    console.error('chase: could not read receivables for', userId, err.message);
    return { created, skipped_no_phone };
  }

  let parties = [];
  try {
    parties = await selectRows('ledger_parties', `select=id,name,phone&user_id=eq.${userId}&limit=2000`);
  } catch (e) { /* no khata parties — nothing to resolve phones from */ }
  const phoneByName = new Map();
  const idByName = new Map();
  for (const p of parties) {
    const k = normPartyName(p.name);
    if (p.phone && !phoneByName.has(k)) phoneByName.set(k, normalizePhone(p.phone));
    if (!idByName.has(k)) idByName.set(k, p.id);
  }

  let existing = [];
  try {
    existing = await selectRows(
      'whatsapp_chase_targets',
      `select=id,receivable_id,state&user_id=eq.${userId}&limit=2000`
    );
  } catch (e) { /* treat as none */ }
  const targetByRecv = new Map(existing.filter((t) => t.receivable_id).map((t) => [t.receivable_id, t]));
  const openRecvIds = new Set(receivables.map((r) => r.id));

  const now = new Date();
  for (const r of receivables) {
    if (targetByRecv.has(r.id)) continue;
    if ((Number(r.amount) || 0) < c.min_amount) continue;

    const overdue = r.due_date ? chase.daysOverdue(r.due_date, now) > 0 : false;
    if (c.auto_include === 'overdue_only' && !overdue) {
      // still create it if a pre-due chase is configured and due soon
      const preDue = (c.days_before_due || []).some((d) => {
        const od = chase.daysOverdue(r.due_date, now);
        return od !== null && od >= -Math.abs(d) && od <= 0;
      });
      if (!preDue) continue;
    }

    const k = normPartyName(r.party_name);
    const phone = phoneByName.get(k) || '';
    if (!phone) { skipped_no_phone++; }

    const firstAt = chase.nextChaseAt(r.due_date, 0, c, null);
    try {
      await insertRows('whatsapp_chase_targets', [{
        user_id: userId,
        receivable_id: r.id,
        party_id: idByName.get(k) || null,
        party_name: r.party_name || 'Customer',
        contact_phone: phone,
        amount: Number(r.amount) || 0,
        due_date: r.due_date || null,
        invoice_ref: null,
        state: 'active',
        current_tier: 'pre_due',
        next_chase_at: phone && firstAt ? firstAt.toISOString() : null
      }], { onConflict: 'user_id,receivable_id', merge: false });
      created++;
    } catch (err) {
      console.error('chase: could not create target for receivable', r.id, err.message);
    }
  }

  // Receivable settled/removed out from under an active chase -> stop chasing.
  for (const t of existing) {
    if (!t.receivable_id || openRecvIds.has(t.receivable_id)) continue;
    if (['active', 'paused_promise'].includes(t.state)) {
      await updateRows('whatsapp_chase_targets', `id=eq.${t.id}`, {
        state: 'resolved_paid',
        resolution: 'Receivable was settled or removed in the app.',
        resolved_at: new Date().toISOString(),
        next_chase_at: null
      }).catch(() => {});
    }
  }

  return { created, skipped_no_phone };
}

/**
 * Placeholder content query — pending margyn-fin-guy's finalized vitals/
 * findings shape. Returns template body params as plain strings (WhatsApp
 * template params are always strings).
 */
async function getBriefingParams(userId, kind) {
  let findings = [];
  try {
    findings = await selectRows(
      'findings',
      `select=*&user_id=eq.${userId}&order=generated_at.desc&limit=3`
    );
  } catch {
    findings = [];
  }

  const topItem = findings[0] ? summarizeFinding(findings[0]) : 'No urgent items today';

  if (kind === 'opening') {
    return [topItem];
  }
  return [topItem, String(findings.length)];
}

function summarizeFinding(finding) {
  return finding.title || finding.summary || finding.headline || 'Review your latest activity';
}
