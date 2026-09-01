/**
 * BSP-agnostic WhatsApp Business Cloud API send/receive helpers.
 *
 * Built against Gupshup first (India-origin BSP, REST API closely mirrors
 * the Meta WhatsApp Cloud API shape, well-documented template + webhook
 * behavior). No BSP is locked yet, so every call goes through `sendTemplate`
 * / `parseInboundEvent` below rather than hitting a BSP endpoint directly
 * from api/whatsapp.js — swapping BSPs later means adding a branch to the
 * two adapter objects at the bottom of this file, not rewriting callers.
 *
 * Zero-npm: plain fetch() + Node's built-in `crypto` module only.
 *
 * Required env vars (set in Vercel dashboard):
 *   WHATSAPP_BSP                 which adapter to use, default "gupshup"
 *   GUPSHUP_API_KEY              Gupshup app API key
 *   GUPSHUP_APP_NAME             Gupshup app name (src.name)
 *   GUPSHUP_SOURCE_NUMBER        WABA number sending from, e.g. 91XXXXXXXXXX
 *   WHATSAPP_TEMPLATE_OPENING    approved Utility template id, Opening Bell
 *   WHATSAPP_TEMPLATE_CLOSING    approved Utility template id, Closing Bell
 *   WHATSAPP_APP_SECRET          optional: enables Meta-style X-Hub-Signature-256
 *                                 verification on inbound webhooks (set this if
 *                                 the BSP passes through raw Cloud API webhooks)
 *   WHATSAPP_WEBHOOK_TOKEN       optional: shared-secret fallback checked against
 *                                 a `token` query param or X-Webhook-Token header
 *                                 (set this if the BSP has no HMAC signing, which
 *                                 is common — Gupshup's own dashboard webhooks don't)
 *   WHATSAPP_WEBHOOK_VERIFY_TOKEN  value expected in the GET hub.verify_token
 *                                   handshake some BSPs use to register the webhook
 */

const crypto = require('crypto');

function bspName() {
  return (process.env.WHATSAPP_BSP || 'gupshup').toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Outbound: send a pre-approved Utility template message              */
/* ------------------------------------------------------------------ */
/**
 * Utility-template constraint: any interactive buttons (Closing Bell's
 * Done / Not yet / Remind-me) must already be baked into the approved
 * template at submission time — you cannot attach free-form interactive
 * buttons to an outbound template send. `params` only fills the template's
 * body variables; button text/ids come back on reply exactly as approved.
 *
 * @param {{to: string, templateId: string, params: string[]}} opts
 * @returns {Promise<{ok: boolean, messageId?: string, error?: string, raw?: any}>}
 */
async function sendTemplate({ to, templateId, params }) {
  const adapter = SEND_ADAPTERS[bspName()];
  if (!adapter) {
    return { ok: false, error: `No send adapter configured for WHATSAPP_BSP=${bspName()}` };
  }
  return adapter({ to, templateId, params: params || [] });
}

async function gupshupSendTemplate({ to, templateId, params }) {
  const apiKey = process.env.GUPSHUP_API_KEY;
  const source = process.env.GUPSHUP_SOURCE_NUMBER;
  const appName = process.env.GUPSHUP_APP_NAME;

  if (!apiKey || !source || !appName) {
    return { ok: false, error: 'Gupshup credentials not configured (GUPSHUP_API_KEY / GUPSHUP_SOURCE_NUMBER / GUPSHUP_APP_NAME)' };
  }
  if (!templateId) {
    return { ok: false, error: 'Missing templateId' };
  }

  const body = new URLSearchParams({
    channel: 'whatsapp',
    source,
    destination: to,
    'src.name': appName,
    template: JSON.stringify({ id: templateId, params })
  });

  let res;
  try {
    res = await fetch('https://api.gupshup.io/wa/api/v1/template/msg', {
      method: 'POST',
      headers: {
        apikey: apiKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    });
  } catch (err) {
    return { ok: false, error: `Network error calling Gupshup: ${err.message}` };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok || !data || data.status !== 'submitted') {
    return { ok: false, error: `Gupshup send failed: ${res.status} ${JSON.stringify(data)}`, raw: data };
  }

  return { ok: true, messageId: data.messageId, raw: data };
}

function notImplementedSend(bsp) {
  return async () => ({ ok: false, error: `${bsp} send adapter not implemented yet — add it here when the BSP is picked` });
}

const SEND_ADAPTERS = {
  gupshup: gupshupSendTemplate,
  interakt: notImplementedSend('interakt'),
  wati: notImplementedSend('wati'),
  aisensy: notImplementedSend('aisensy')
};

/* ------------------------------------------------------------------ */
/* Outbound: send a free-form text message (session / 24h window only) */
/* ------------------------------------------------------------------ */
/**
 * For conversational replies inside an open 24h customer-care window — the
 * inbound conversational handler in api/whatsapp.js uses this to reply to a
 * sender who just messaged us, and to forward a routed message on. This is
 * NOT for Bell sends (those must stay pre-approved Utility templates via
 * sendTemplate) and will be rejected by WhatsApp outside a session window.
 *
 * @param {{to: string, text: string}} opts
 * @returns {Promise<{ok: boolean, messageId?: string, error?: string}>}
 */
async function sendText({ to, text }) {
  const adapter = SEND_TEXT_ADAPTERS[bspName()];
  if (!adapter) {
    return { ok: false, error: `No text-send adapter configured for WHATSAPP_BSP=${bspName()}` };
  }
  return adapter({ to, text });
}

async function gupshupSendText({ to, text }) {
  const apiKey = process.env.GUPSHUP_API_KEY;
  const source = process.env.GUPSHUP_SOURCE_NUMBER;
  const appName = process.env.GUPSHUP_APP_NAME;

  if (!apiKey || !source || !appName) {
    return { ok: false, error: 'Gupshup credentials not configured (GUPSHUP_API_KEY / GUPSHUP_SOURCE_NUMBER / GUPSHUP_APP_NAME)' };
  }
  const destination = String(to || '').replace(/[^\d]/g, '');
  if (!destination) {
    return { ok: false, error: 'Missing destination number' };
  }

  const body = new URLSearchParams({
    channel: 'whatsapp',
    source,
    destination,
    'src.name': appName,
    message: JSON.stringify({ type: 'text', text: String(text || '').slice(0, 4096) })
  });

  let res;
  try {
    res = await fetch('https://api.gupshup.io/wa/api/v1/msg', {
      method: 'POST',
      headers: {
        apikey: apiKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    });
  } catch (err) {
    return { ok: false, error: `Network error calling Gupshup: ${err.message}` };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok || !data || data.status !== 'submitted') {
    return { ok: false, error: `Gupshup text send failed: ${res.status} ${JSON.stringify(data)}` };
  }

  return { ok: true, messageId: data.messageId };
}

const SEND_TEXT_ADAPTERS = {
  gupshup: gupshupSendText,
  interakt: notImplementedSend('interakt'),
  wati: notImplementedSend('wati'),
  aisensy: notImplementedSend('aisensy')
};

/* ------------------------------------------------------------------ */
/* Inbound: normalize a webhook payload into a common shape            */
/* ------------------------------------------------------------------ */
/**
 * Returns null if the payload isn't a recognizable button-reply event
 * (e.g. it's a delivery-status callback, not a user reply).
 *
 * @returns {null | {from: string, buttonId: string, buttonText: string,
 *   wamid: string, contextMessageId: string|null, timestampMs: number}}
 */
function parseInboundEvent(payload) {
  const parser = PARSE_ADAPTERS[bspName()];
  if (!parser) return null;
  try {
    return parser(payload);
  } catch {
    return null;
  }
}

function gupshupParseInboundEvent(payload) {
  // Gupshup's "Advanced" webhook wraps the actual WhatsApp event:
  //   { app, timestamp, type: "message", payload: {
  //       id, type: "button_reply", source, sender: {phone, name},
  //       payload: { id, title }, context: { id, gsId } } }
  // Verify exact field names against Gupshup's current webhook docs once
  // the app is live — this shape has been consistent historically but
  // hasn't been tested against a real Gupshup account in this build.
  if (!payload || payload.type !== 'message') return null;
  const p = payload.payload;
  if (!p || p.type !== 'button_reply') return null;

  const btn = p.payload || {};
  return {
    from: p.sender && p.sender.phone || p.source,
    buttonId: btn.id || '',
    buttonText: btn.title || '',
    wamid: p.id,
    contextMessageId: (p.context && p.context.id) || null,
    timestampMs: payload.timestamp || Date.now()
  };
}

function notImplementedParse(bsp) {
  return () => { throw new Error(`${bsp} inbound parser not implemented yet`); };
}

const PARSE_ADAPTERS = {
  gupshup: gupshupParseInboundEvent,
  interakt: notImplementedParse('interakt'),
  wati: notImplementedParse('wati'),
  aisensy: notImplementedParse('aisensy')
};

/* ------------------------------------------------------------------ */
/* Inbound: free-text message (feeds the conversational routing layer) */
/* ------------------------------------------------------------------ */
/**
 * Returns null unless the payload is a plain inbound text message. Button
 * replies still go through parseInboundEvent above — this only catches the
 * "user typed something" case that parseInboundEvent deliberately ignores.
 *
 * @returns {null | {from: string, text: string, wamid: string,
 *   contextMessageId: string|null, timestampMs: number}}
 */
function parseInboundText(payload) {
  const parser = TEXT_PARSE_ADAPTERS[bspName()];
  if (!parser) return null;
  try {
    return parser(payload);
  } catch {
    return null;
  }
}

function gupshupParseInboundText(payload) {
  if (!payload || payload.type !== 'message') return null;
  const p = payload.payload;
  if (!p || p.type !== 'text') return null;

  const body = p.payload || {};
  return {
    from: (p.sender && p.sender.phone) || p.source,
    text: body.text || '',
    wamid: p.id,
    contextMessageId: (p.context && p.context.id) || null,
    timestampMs: payload.timestamp || Date.now()
  };
}

const TEXT_PARSE_ADAPTERS = {
  gupshup: gupshupParseInboundText,
  interakt: notImplementedParse('interakt'),
  wati: notImplementedParse('wati'),
  aisensy: notImplementedParse('aisensy')
};

/**
 * Map a normalized button id/text (as approved in the Closing Bell
 * template) to the whatsapp_replies.reply_type enum.
 */
function classifyReply({ buttonId, buttonText }) {
  const key = `${buttonId || ''} ${buttonText || ''}`.toLowerCase();
  if (key.includes('not_yet') || key.includes('not yet')) return 'not_yet';
  if (key.includes('remind')) return 'remind_me';
  if (key.includes('done')) return 'done';
  return 'unrecognized';
}

/* ------------------------------------------------------------------ */
/* Webhook verification                                                */
/* ------------------------------------------------------------------ */
/** GET handshake some BSPs use when you register a webhook URL. */
function checkVerifyToken(query) {
  const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  return !!expected && query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === expected;
}

/**
 * Validates an inbound POST. Prefers Meta-style HMAC signature checking
 * (X-Hub-Signature-256) when WHATSAPP_APP_SECRET is set — this is the
 * standard WhatsApp Business Cloud API verification pattern and holds if
 * the BSP passes through raw Cloud API webhooks. Falls back to a shared
 * secret token (WHATSAPP_WEBHOOK_TOKEN) checked against a query param or
 * header, since several BSPs (Gupshup's own dashboard webhooks included)
 * don't sign payloads at all and rely on the webhook URL/token staying
 * secret instead.
 */
function verifyInboundRequest(req, rawBody) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (appSecret) {
    const signatureHeader = req.headers['x-hub-signature-256'];
    if (!signatureHeader) return false;
    const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  const sharedToken = process.env.WHATSAPP_WEBHOOK_TOKEN;
  if (sharedToken) {
    const provided = (req.headers['x-webhook-token']) || (req.query && req.query.token);
    return provided === sharedToken;
  }

  // Neither configured: fail closed. Set one of the two above before going live.
  return false;
}

module.exports = {
  sendTemplate,
  sendText,
  parseInboundEvent,
  parseInboundText,
  classifyReply,
  checkVerifyToken,
  verifyInboundRequest
};
