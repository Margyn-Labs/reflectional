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

const { getUserFromRequest, selectRows, insertRows, logConnectorEvent } = require('./_lib/supabaseRest');
const bsp = require('./_lib/whatsappBsp');
const { runConversation } = require('./_lib/whatsappAgent');

module.exports = async function handler(req, res) {
  const action = (req.query && req.query.action) || '';

  if (action === 'webhook' && req.method === 'GET') return handleWebhookVerify(req, res);
  if (action === 'webhook' && req.method === 'POST') return handleWebhookEvent(req, res);
  if (action === 'cron-opening' && req.method === 'GET') return handleCron(req, res, 'opening');
  if (action === 'cron-closing' && req.method === 'GET') return handleCron(req, res, 'closing');

  res.status(400).json({ error: 'unknown_action', message: 'Expected ?action= one of webhook, cron-opening, cron-closing.' });
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
    // Not a button reply. If it's a free-text message, hand it to the
    // conversational routing layer; otherwise (delivery-status callback etc.)
    // ack and ignore.
    const textEvent = bsp.parseInboundText(payload);
    if (textEvent && textEvent.text && textEvent.text.trim()) {
      await handleConversationalInbound(res, textEvent);
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

    // An unrecognized button reply is treated as free text — hand it to the
    // conversational routing layer instead of just logging it.
    if (replyType === 'unrecognized' && event.buttonText && event.buttonText.trim()) {
      // Ack before the slow Claude loop so the BSP doesn't retry (see the
      // note in handleConversationalInbound). wamid guard dedupes any retry.
      if (!res.headersSent) res.status(200).json({ received: true });
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
      return;
    }
  } catch (err) {
    console.error('whatsapp webhook: failed to persist reply', err.message);
    // Still 200 — the failure is ours to chase in logs, not WhatsApp's to retry forever.
  }

  if (!res.headersSent) res.status(200).json({ received: true });
}

/* ------------------------------------------------------------------ */
/* Conversational routing layer — inbound free-text messages           */
/* ------------------------------------------------------------------ */
async function handleConversationalInbound(res, textEvent) {
  // Acknowledge the webhook IMMEDIATELY. The Claude tool loop can take ~8s,
  // longer than the BSP's webhook timeout — if we hold the connection open
  // that long, Gupshup/Meta assume failure and re-deliver the same message,
  // and each re-delivery generates another reply (the "loop"). The function
  // stays alive to finish runConversation because we await it below; the
  // wamid guard inside runConversation catches any retry that still slips in.
  res.status(200).json({ received: true, conversational: true });

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
  } catch (err) {
    console.error('whatsapp webhook: conversational inbound failed', err.message);
  }
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
