/* ============================================================
   SHOPIFY CONNECTOR (NEW) — Custom App token, read-only.
   Third connector after Razorpay and Zoho Books. For a store
   running Shopify + Razorpay with no Zoho Books, this is the
   primary margin source, not a supplement.

   Same rule as the Zoho connector: all counting and flagging
   happens server-side in /api/shopify?action=status, this file only
   renders what comes back, so the app and the AI briefing can
   never disagree on a number.
   ============================================================ */
async function shopifyApi(path, opts){
  opts = opts || {};
  const { data:{ session } } = await sbClient.auth.getSession();
  const token = session ? session.access_token : null;
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type':'application/json', 'Authorization': 'Bearer ' + token },
    body: opts.body
  });
  const data = await res.json().catch(() => ({}));
  if(!res.ok) throw new Error(data.message || data.error || ('Request failed (' + res.status + ')'));
  return data;
}
function shopifyShowError(msg){
  const el = document.getElementById('shopifyError');
  if(!el) return;
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
}
function normalizeShopDomain(raw){
  const d = String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(d) ? d : null;
}
/* ---------- status row inside Connectors ---------- */
async function loadShopifyStatus(){
  try {
    const d = await shopifyApi('/api/shopify?action=status');
    shopifyStore = (d.stores && d.stores.length) ? d.stores[0] : null;
    shopifyConnected = !!(shopifyStore && shopifyStore.status !== 'disconnected');
  } catch(e){ shopifyStore = null; shopifyConnected = false; }
  renderShopifyStatus();
  manageShopifyBackfillPolling();
  renderShopifyChart();
}
function renderShopifyStatus(){
  const host = document.getElementById('shopifyStatus'); if(!host) return;
  if(shopifyConnected && shopifyStore){
    const s = shopifyStore;
    const c = s.counts || {};
    const needsReauth = s.status === 'needs_reauthentication';
    const backfilling = !needsReauth && !s.backfill_complete;
    let meta;
    if(needsReauth){
      meta = escapeHtml(s.shop_domain) + ', app uninstalled or token regenerated in Shopify, reconnect to resume';
    } else if(backfilling){
      meta = escapeHtml(s.shop_domain) + ', first 90-day backfill in progress, ' + (c.orders||0).toLocaleString('en-IN') + ' orders so far';
    } else {
      meta = escapeHtml(s.shop_domain) + ', ' + (c.orders||0).toLocaleString('en-IN') + ' orders synced' +
             (s.last_synced_at ? ', last synced ' + fmtDate(s.last_synced_at) : '');
      if((s.flags||[]).indexOf('cogs_data_incomplete') !== -1){
        meta += ' · cost per item missing on ' + s.cogs_missing_pct + '% of SKUs, margin shown as an estimate';
      }
    }
    const tagCls = needsReauth ? 'bad' : (backfilling ? 'warn' : 'ok');
    const tagTxt = needsReauth ? 'Reconnect' : (backfilling ? 'Backfilling' : 'Connected');
    host.innerHTML =
      '<div class="ledger-row"><div class="lr-main">' +
        '<div class="lr-party">Shopify</div>' +
        '<div class="lr-meta">' + meta + '</div>' +
      '</div><span class="lr-tag ' + tagCls + '">' + tagTxt + '</span>' +
      '<div class="lr-actions">' +
        (needsReauth ? '<button class="lr-btn" id="shopifyReconnectBtn">Reconnect</button>'
                     : '<button class="lr-btn" id="shopifySyncBtn">Sync now</button>') +
        '<button class="lr-btn danger" id="shopifyDisconnectBtn">Disconnect</button>' +
      '</div></div>';
    const sy = document.getElementById('shopifySyncBtn'); if(sy) sy.addEventListener('click', syncShopifyNow);
    const rc = document.getElementById('shopifyReconnectBtn'); if(rc) rc.addEventListener('click', openShopifyModal);
    document.getElementById('shopifyDisconnectBtn').addEventListener('click', disconnectShopify);
  } else {
    host.innerHTML =
      '<div class="ledger-row"><div class="lr-main">' +
        '<div class="lr-party">Shopify</div>' +
        '<div class="lr-meta">Not connected · unlocks SKU-level COGS, true net margin and COD receivables for D2C stores</div>' +
      '</div><div class="lr-actions"><button class="lr-btn connect" id="connectShopifyBtn">Connect</button></div></div>';
    const btn = document.getElementById('connectShopifyBtn');
    if(btn) btn.addEventListener('click', openShopifyModal);
  }
}
/* The 90-day backfill is resumable server-side. Keep nudging it until it
   finishes rather than making the owner wait on the nightly cron. */
function manageShopifyBackfillPolling(){
  const needs = shopifyConnected && shopifyStore && shopifyStore.status === 'active' && !shopifyStore.backfill_complete;
  if(needs && !shopifyPollTimer){
    shopifyPollTimer = setInterval(async () => {
      try { await shopifyApi('/api/shopify?action=sync', { method:'POST', body: JSON.stringify({}) }); } catch(e){}
      await loadShopifyStatus();
    }, 20000);
  } else if(!needs && shopifyPollTimer){
    clearInterval(shopifyPollTimer); shopifyPollTimer = null;
  }
}
/* ---------- connect modal ---------- */
function openShopifyModal(){
  const overlay = document.getElementById('shopifyOverlay');
  const host = document.getElementById('shopifyContent');
  host.innerHTML =
    '<div class="detail-eyebrow">Connect data</div>' +
    '<div class="detail-title">Connect Shopify</div>' +
    '<div class="zoho-scope-note">Read-only access</div>' +
    '<div class="detail-body" style="margin-bottom:16px;">Margyn never places orders, edits products or changes anything in your store. It only reads orders, refunds and product cost.</div>' +
    '<div class="ledger-form">' +
      '<div class="lf-title">Store domain</div>' +
      '<input type="text" id="shopDomainInput" placeholder="mystore.myshopify.com" autocomplete="off" spellcheck="false" style="margin-bottom:10px;">' +
      '<div class="lf-title">Admin API access token</div>' +
      '<input type="password" id="shopTokenInput" placeholder="shpat_…" autocomplete="off" spellcheck="false">' +
      '<div style="font-size:12px; color:var(--text-2); margin:10px 0 0; line-height:1.7;">' +
        'In your Shopify admin:<br>' +
        '1. Settings → Apps and sales channels → Develop apps<br>' +
        '2. Create an app, name it Margyn<br>' +
        '3. Under Admin API integration enable <span class="mono">read_orders</span>, <span class="mono">read_products</span>, <span class="mono">read_inventory</span><br>' +
        '4. Save, Install app, then reveal and copy the access token' +
      '</div>' +
      '<div class="note bad" id="shopifyError" style="display:none; margin:10px 0 8px;"></div>' +
      '<div class="note ok" id="shopifySuccess" style="display:none; margin:10px 0 8px;"></div>' +
      '<button id="shopifyConnectBtn" style="margin-top:10px;">Connect</button>' +
    '</div>';
  document.getElementById('shopifyConnectBtn').addEventListener('click', async () => {
    const btn = document.getElementById('shopifyConnectBtn');
    const successEl = document.getElementById('shopifySuccess');
    shopifyShowError(''); successEl.style.display = 'none';
    const domain = normalizeShopDomain(document.getElementById('shopDomainInput').value);
    const token = document.getElementById('shopTokenInput').value.trim();
    if(!domain){ shopifyShowError('Enter your store domain in the form mystore.myshopify.com'); return; }
    if(!token){ shopifyShowError('Paste the Admin API access token from your Custom App.'); return; }
    btn.disabled = true; btn.textContent = 'Connecting…';
    try {
      const out = await shopifyApi('/api/shopify?action=connect', {
        method: 'POST',
        body: JSON.stringify({ shopDomain: domain, accessToken: token })
      });
      document.getElementById('shopTokenInput').value = '';
      successEl.textContent = out.backfill_complete
        ? '✓ Connected, ' + (out.synced ? out.synced.orders : 0) + ' orders pulled.'
        : '✓ Connected, pulling your last 90 days now.';
      successEl.style.display = 'block';
      setTimeout(async () => {
        await loadShopifyStatus();
        document.getElementById('shopifyOverlay').classList.add('hidden');
      }, 1400);
    } catch(e){ shopifyShowError(e.message); }
    finally { btn.disabled = false; btn.textContent = 'Connect'; }
  });
  overlay.classList.remove('hidden');
}
document.getElementById('shopifyClose').addEventListener('click', () => document.getElementById('shopifyOverlay').classList.add('hidden'));
document.getElementById('shopifyOverlay').addEventListener('click', (e) => { if(e.target.id === 'shopifyOverlay') e.currentTarget.classList.add('hidden'); });
/* ---------- sync / disconnect ---------- */
async function syncShopifyNow(){
  const btn = document.getElementById('shopifySyncBtn');
  if(btn){ btn.disabled = true; btn.textContent = 'Syncing…'; }
  try {
    await shopifyApi('/api/shopify?action=sync', { method:'POST', body: JSON.stringify({}) });
    await loadShopifyStatus();
  } catch(e){
    if(btn){ btn.textContent = 'Sync failed'; setTimeout(() => { btn.disabled = false; btn.textContent = 'Sync now'; }, 2200); return; }
  }
  const b2 = document.getElementById('shopifySyncBtn');
  if(b2){ b2.disabled = false; b2.textContent = 'Sync now'; }
}
async function disconnectShopify(){
  if(!shopifyStore) return;
  if(!(await mgConfirm({ title:'Disconnect Shopify?', body:'Your historical order and margin data stays visible in Margyn, but nothing new will sync until you reconnect.', confirmLabel:'Disconnect', danger:true }))) return;
  const btn = document.getElementById('shopifyDisconnectBtn');
  if(btn){ btn.disabled = true; btn.textContent = 'Disconnecting…'; }
  try { await shopifyApi('/api/shopify?action=disconnect', { method:'POST', body: JSON.stringify({ storeId: shopifyStore.id }) }); }
  catch(e){ toast('Could not disconnect: ' + e.message, {kind:'bad'}); }
  await loadShopifyStatus();
}
/* ============================================================
   TALLY CONNECTOR — local Windows desktop agent -> TallyPrime
   HTTP/XML server (port 9000) -> Margyn cloud. Unlike
   Razorpay/Shopify/Zoho the credential exchange happens inside
   the desktop agent, not this browser: the app only mints a
   one-time pairing code and polls until the agent checks in.
   No token field here. Everything Tally sends lands
   provenance-tagged "Signal" and is never auto-trusted
   — see api/tally.js.
   ============================================================ */
const MARGYN_TALLY_AGENT_DOWNLOAD = 'https://pub-432244bb0d9047989ffc94163a2fea75.r2.dev/Margyn-Tally-Agent-Setup-0.1.0.exe';
async function tallyApi(path, opts){
  opts = opts || {};
  const { data:{ session } } = await sbClient.auth.getSession();
  const token = session ? session.access_token : null;
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type':'application/json', 'Authorization': 'Bearer ' + token },
    body: opts.body
  });
  const data = await res.json().catch(() => ({}));
  if(!res.ok) throw new Error(data.message || data.error || ('Request failed (' + res.status + ')'));
  return data;
}
function tallyFmtAgo(iso){
  if(!iso) return 'never';
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime())/1000);
  if(secs < 90) return 'just now';
  if(secs < 3600) return Math.round(secs/60) + ' min ago';
  if(secs < 86400) return Math.round(secs/3600) + ' h ago';
  return Math.round(secs/86400) + ' d ago';
}
/* ---------- status row inside Connectors ---------- */
async function loadTallyStatus(){
  try {
    const d = await tallyApi('/api/tally?action=status');
    tallyInstalls = Array.isArray(d.installs) ? d.installs : [];
    tallyConnected = tallyInstalls.some(i => i.status === 'active');
  } catch(e){ /* keep last known state on a flaky check */ }
  renderTallyStatus();
}
/* Pre-aggregated bills / vouchers / ledger balances for the Ledger view + AI context.
   Server does all the maths (api/tally.js?action=summary) so the app and the
   briefing can never quote different Tally numbers. Everything here is Signal. */
async function loadTallyData(){
  try {
    const d = await tallyApi('/api/tally?action=summary');
    return (d && d.connected) ? d : null;
  } catch(e){ return null; }
}
function renderTallyStatus(){
  const host = document.getElementById('tallyStatus'); if(!host) return;
  const active = tallyInstalls.filter(i => i.status === 'active');
  if(active.length){
    /* One .ledger-row per grid cell, same as every other connector card —
       each paired PC is an inner row, and the disconnect/pair actions live
       in the one shared .lr-actions strip at the bottom. Previously each PC
       got its own full .ledger-row (height:100% of the grid cell) with a
       "Pair another PC" button appended as a loose sibling after it — the
       two fought over height and the button spilled into the section below. */
    const rows = active.map(i => {
      const c = i.counts || {};
      const prod = i.tally_product === 'erp9' ? 'Tally.ERP 9'
        : (i.tally_product === 'tallyprime' ? 'TallyPrime' : (i.tally_product_name || 'Tally'));
      const parts = [
        escapeHtml(prod) + (i.tally_version ? ' ' + escapeHtml(i.tally_version) : ''),
        'company ' + escapeHtml(i.company_name || '—'),
        (c.ledgers||0) + ' ledgers · ' + (c.vouchers||0) + ' vouchers · ' + (c.bills||0) + ' bills',
        'agent checked in ' + tallyFmtAgo(i.last_seen_at),
        'last sync ' + tallyFmtAgo(i.last_sync_at)
      ];
      return '<div class="tally-pc-row"><div class="lr-party">' + escapeHtml(prod) +
        ' <span class="lr-meta" style="font-weight:400">(' + escapeHtml(i.machine_hint || 'desktop agent') + ')</span></div>' +
        '<div class="lr-meta">' + parts.join(' · ') + '</div>' +
        '<button class="lr-btn danger" data-tally-revoke="' + i.id + '" style="margin-top:8px;">Disconnect</button></div>';
    }).join('');
    host.innerHTML = '<div class="ledger-row"><div class="lr-main">' + rows + '</div>' +
      '<span class="lr-tag ok">Signal</span>' +
      '<div class="lr-actions"><button class="lr-btn connect" id="tallyAddBtn">Pair another PC</button></div>' +
    '</div>';
  } else {
    host.innerHTML =
      '<div class="ledger-row"><div class="lr-main">' +
        '<div class="lr-party">TallyPrime</div>' +
        '<div class="lr-meta">Not connected · a small agent on the Windows PC running Tally syncs ledgers, vouchers and bills. Lands as Signal, corroborated against bank &amp; GST before it moves any number.</div>' +
      '</div><div class="lr-actions"><button class="lr-btn connect" id="tallyConnectBtn">Connect</button></div></div>';
  }
  const b1 = document.getElementById('tallyConnectBtn'); if(b1) b1.addEventListener('click', openTallyModal);
  const b2 = document.getElementById('tallyAddBtn'); if(b2) b2.addEventListener('click', openTallyModal);
  host.querySelectorAll('[data-tally-revoke]').forEach(btn => {
    btn.addEventListener('click', () => revokeTallyInstall(btn.getAttribute('data-tally-revoke')));
  });
}
async function revokeTallyInstall(installId){
  if(!(await mgConfirm({ title:'Disconnect this Tally agent?', body:'Data already synced stays visible in Margyn. The agent on that PC stops syncing.', confirmLabel:'Disconnect', danger:true }))) return;
  try {
    await tallyApi('/api/tally?action=revoke', { method:'POST', body: JSON.stringify({ installId }) });
    await loadTallyStatus();
  } catch(e){ toast('Could not complete that', { kind:'bad', sub: e.message }); }
}
/* ---------- pairing modal ---------- */
function openTallyModal(){
  const overlay = document.getElementById('tallyOverlay');
  const host = document.getElementById('tallyContent');
  host.innerHTML =
    '<div class="detail-eyebrow">Connect data</div>' +
    '<div class="detail-title">Connect TallyPrime</div>' +
    '<div class="zoho-scope-note">Read-only · your data never leaves your network except the sync to Margyn</div>' +
    '<div class="detail-body" style="margin-bottom:16px;">Margyn reads Tally through a small agent you run on the Windows 10/11 PC where TallyPrime is installed. Works with <b>TallyPrime</b> and <b>Tally.ERP 9</b>. It only reads — it never posts vouchers or edits masters.</div>' +
    '<div class="ledger-form">' +
      '<div class="lf-title">Step 1 — download &amp; install the agent</div>' +
      '<div style="font-size:12px; color:var(--text-2); margin:4px 0 10px; line-height:1.7;">Install it on the PC where TallyPrime runs.</div>' +
      '<a class="lr-btn connect" style="display:inline-block; text-decoration:none; padding:8px 14px; font-size:12px;" href="' + MARGYN_TALLY_AGENT_DOWNLOAD + '">Download for Windows</a>' +
      '<div style="font-size:12px; color:var(--text-2); margin:8px 0 14px; line-height:1.7;">Windows may warn about an unrecognised publisher — click <span class="mono">More info</span> → <span class="mono">Run anyway</span>.</div>' +
      '<div class="lf-title">Step 2 — turn on Tally\'s connector</div>' +
      '<div style="font-size:12px; color:var(--text-2); margin:4px 0 14px; line-height:1.7;">' +
        '<b>TallyPrime:</b> F1 (Help) → Settings → Advanced Configuration → set <span class="mono">TallyPrime acts as</span> to <span class="mono">Both</span>, port <span class="mono">9000</span>.<br>' +
        '<b>Tally.ERP 9:</b> F12 (Configure) → Advanced Configuration → set the same option to <span class="mono">Both</span>, port <span class="mono">9000</span>.<br>' +
        'Keep the company open.' +
      '</div>' +
      '<div class="lf-title">Step 3 — pairing code</div>' +
      '<div style="font-size:12px; color:var(--text-2); margin:4px 0 8px; line-height:1.7;">In the agent, paste this code and your company name.</div>' +
      '<div id="tallyCodeBox" style="margin:8px 0 12px;">' +
        '<div class="mono" id="tallyCode" style="font-size:26px; letter-spacing:3px; padding:10px 0;">····-····</div>' +
        '<div style="font-size:12px; color:var(--text-2);" id="tallyCodeMeta">Generating…</div>' +
      '</div>' +
      '<div class="note bad" id="tallyError" style="display:none; margin:10px 0 8px;"></div>' +
      '<div class="note ok" id="tallySuccess" style="display:none; margin:10px 0 8px;"></div>' +
      '<button id="tallyRegenBtn" style="margin-top:6px;">Generate a new code</button>' +
    '</div>';
  document.getElementById('tallyRegenBtn').addEventListener('click', mintTallyCode);
  overlay.classList.remove('hidden');
  mintTallyCode();
}
async function mintTallyCode(){
  const codeEl = document.getElementById('tallyCode');
  const metaEl = document.getElementById('tallyCodeMeta');
  const errEl = document.getElementById('tallyError');
  if(errEl) errEl.style.display = 'none';
  const known = new Set(tallyInstalls.map(i => i.id));
  if(codeEl) codeEl.textContent = '····-····';
  if(metaEl) metaEl.textContent = 'Generating…';
  let out;
  try {
    out = await tallyApi('/api/tally?action=pair-init', { method:'POST', body: JSON.stringify({}) });
  } catch(e){
    if(metaEl) metaEl.textContent = '';
    if(errEl){ errEl.textContent = e.message; errEl.style.display = 'block'; }
    return;
  }
  if(codeEl) codeEl.textContent = out.code;
  const expires = new Date(out.expires_at).getTime();
  const tickMeta = () => {
    const left = Math.max(0, Math.round((expires - Date.now())/1000));
    if(metaEl) metaEl.textContent = left
      ? ('Expires in ' + Math.floor(left/60) + ':' + String(left%60).padStart(2,'0'))
      : 'Expired — generate a new code';
  };
  tickMeta();
  if(tallyPairPollTimer) clearInterval(tallyPairPollTimer);
  tallyPairPollTimer = setInterval(async () => {
    tickMeta();
    try {
      const d = await tallyApi('/api/tally?action=status');
      const installs = Array.isArray(d.installs) ? d.installs : [];
      const fresh = installs.find(i => i.status === 'active' && !known.has(i.id));
      if(fresh){
        clearInterval(tallyPairPollTimer); tallyPairPollTimer = null;
        const okEl = document.getElementById('tallySuccess');
        if(okEl){ okEl.textContent = '✔ Connected — ' + (fresh.company_name || 'your company') + '. First sync will land shortly.'; okEl.style.display = 'block'; }
        tallyInstalls = installs; tallyConnected = true; renderTallyStatus();
        setTimeout(() => document.getElementById('tallyOverlay').classList.add('hidden'), 1500);
      }
    } catch(e){ /* transient */ }
  }, 3000);
}
document.getElementById('tallyClose').addEventListener('click', () => {
  document.getElementById('tallyOverlay').classList.add('hidden');
  if(tallyPairPollTimer){ clearInterval(tallyPairPollTimer); tallyPairPollTimer = null; }
});
document.getElementById('tallyOverlay').addEventListener('click', (e) => {
  if(e.target.id === 'tallyOverlay'){ e.currentTarget.classList.add('hidden'); if(tallyPairPollTimer){ clearInterval(tallyPairPollTimer); tallyPairPollTimer = null; } }
});
/* ---------- Tally tab (mirrors the Books tab; data from api/tally.js?action=summary) ---------- */
/* The bottom fade on a .dscroll body is decorative: switch it off when the
   list already fits, or once the reader has reached the end, so the last row
   is never dimmed for no reason. */
function wireDscroll(root){
  (root || document).querySelectorAll('.dscroll').forEach(el => {
    const sync = () => {
      const fits = el.scrollHeight - el.clientHeight <= 1;
      el.classList.toggle('fits', fits);
      el.classList.toggle('at-end', !fits && (el.scrollHeight - el.scrollTop - el.clientHeight) <= 2);
    };
    if(!el.dataset.dscrollWired){ el.addEventListener('scroll', sync, { passive:true }); el.dataset.dscrollWired = '1'; }
    sync();
  });
}
function renderTallyTab(){
  const notConn = document.getElementById('tallyNotConnected');
  const content = document.getElementById('tallyTabContent');
  if(!notConn || !content) return;

  const d = tallyData;

  if(!d || !d.connected){
    notConn.classList.remove('hidden');
    content.classList.add('hidden');
    tallyOverdueCount = 0; renderBooksBadge();
    return;
  }
  notConn.classList.add('hidden');
  content.classList.remove('hidden');

  const b = d.bills || {}, v = d.vouchers || {}, led = d.ledgers || {};

  const tCash = tallyCashBalance();
  const tCashEl = document.getElementById('tvCashVal');
  const tCashSub = document.getElementById('tvCashSub');
  if(tCashEl) tCashEl.textContent = tCash ? inr(tCash.total) : 'Not available';
  if(tCashSub){
    tCashSub.textContent = tCash
      ? (tCash.count + (tCash.count === 1 ? ' ledger' : ' ledgers') + ', overdraft excluded. Feeds Cash Position and Working Capital Runway.')
      : 'No bank or cash-in-hand ledger carried a closing balance in this sync.';
  }
  document.getElementById('tvRecvVal').textContent = inr(b.receivable_total || 0);
  document.getElementById('tvPayVal').textContent = inr(b.payable_total || 0);
  document.getElementById('tvOverdueVal').textContent = inr(b.overdue_total || 0);
  document.getElementById('tvSalesVal').textContent = inr(v.sales_30d || 0);
  document.getElementById('tvReceiptsVal').textContent = inr(v.receipts_30d || 0);
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  document.getElementById('tvCountsVal').textContent = plural(v.count || 0, 'voucher', 'vouchers');
  document.getElementById('tvAsOf').textContent =
    plural(led.count || 0, 'ledger', 'ledgers') + ' · ' + plural(b.count || 0, 'bill', 'bills') +
    (d.as_of ? (' · as of ' + fmtDate(d.as_of)) : ' · sync pending');

  // transactions by type
  const byType = Object.entries(v.by_type || {}).sort((a, c) => c[1] - a[1]);
  const maxT = Math.max.apply(null, byType.map(x => x[1]).concat([1]));
  const chart = document.getElementById('tvByTypeChart');
  const btSub = document.getElementById('tvByTypeSub');
  if(btSub) btSub.textContent = (v.count || 0) + ' vouchers · ' + byType.length + ' types';
  chart.innerHTML = '';
  if(!byType.length){ chart.innerHTML = '<div class="ledger-empty">No transactions synced yet.</div>'; }
  byType.forEach(([t, n]) => {
    const row = document.createElement('div'); row.className = 'hbar-row';
    row.innerHTML = '<span class="hbar-label">' + escapeHtml(t) + '</span>' +
      '<div class="hbar-track"><div class="hbar-fill" style="width:0%;"></div></div>' +
      '<span class="hbar-val">' + n + '</span>';
    chart.appendChild(row);
    requestAnimationFrame(() => { row.querySelector('.hbar-fill').style.width = Math.round(100 * n / maxT) + '%'; });
  });

  // outstanding bills
  const bills = (b.items || []).slice().sort((a, c) => (c.overdue_days || 0) - (a.overdue_days || 0) || (c.amount || 0) - (a.amount || 0));
  const billsSub = document.getElementById('tvBillsSub');
  if(billsSub) billsSub.textContent = bills.length ? (bills.length + (bills.length === 1 ? ' bill' : ' bills') + ' · most overdue first') : 'most overdue first';
  document.getElementById('tvBillsList').innerHTML = bills.length ? (
    '<div class="dscroll"><table class="dtable"><colgroup><col><col style="width:88px"><col style="width:104px"></colgroup>' +
    '<thead><tr><th>Party</th><th>Type</th><th class="num">Amount</th></tr></thead><tbody>' +
    bills.map((x, i) => {
      const meta = (x.overdue_days != null && x.overdue_days > 0)
        ? (x.overdue_days + ' days overdue')
        : (x.due_date ? ('due ' + fmtDate(x.due_date)) : '');
      const late = (x.overdue_days != null && x.overdue_days > 0) ? ' late' : '';
      const tag = x.direction === 'payable' ? '<span class="lr-tag warn">Payable</span>' : '<span class="lr-tag ok">Receivable</span>';
      return '<tr data-row data-bill-idx="' + i + '">' +
        '<td><div class="dt-main">' + escapeHtml(x.party_name || 'Unknown') + '</div>' +
        '<div class="dt-sub' + late + '">' + (x.bill_ref ? ('Ref ' + escapeHtml(x.bill_ref) + ' · ') : '') + meta + '</div></td>' +
        '<td>' + tag + '</td>' +
        '<td class="num">' + inr(x.amount || 0) + '</td></tr>';
    }).join('') + '</tbody></table></div>'
  ) : '<div class="ledger-empty">No outstanding bills.</div>';
  document.querySelectorAll('#tvBillsList tr[data-bill-idx]').forEach(row => {
    const x = bills[Number(row.dataset.billIdx)];
    row.addEventListener('click', () => openTallyRowDetail('Bill', x.party_name || 'Unknown', x.amount, [
      x.bill_ref ? ['Reference', x.bill_ref] : null,
      x.direction ? ['Type', x.direction === 'payable' ? 'Payable' : 'Receivable'] : null,
      x.due_date ? ['Due', fmtDate(x.due_date)] : null,
      (x.overdue_days != null && x.overdue_days > 0) ? ['Overdue by', x.overdue_days + ' days'] : null
    ]));
  });

  // recent transactions
  const rec = v.recent || [];
  const vouchSub = document.getElementById('tvVouchersSub');
  if(vouchSub) vouchSub.textContent = rec.length ? (rec.length + ' shown · newest first') : 'newest first';
  document.getElementById('tvVouchersList').innerHTML = rec.length ? (
    '<div class="dscroll"><table class="dtable"><colgroup><col><col style="width:104px"></colgroup>' +
    '<thead><tr><th>Voucher</th><th class="num">Amount</th></tr></thead><tbody>' +
    rec.map((x, i) =>
      '<tr data-row data-voucher-idx="' + i + '">' +
        '<td><div class="dt-main">' + escapeHtml(x.voucher_type || 'Voucher') + (x.voucher_number ? (' #' + escapeHtml(x.voucher_number)) : '') + '</div>' +
        '<div class="dt-sub">' + (x.date ? fmtDate(x.date) : '') + (x.party_name ? (' · ' + escapeHtml(x.party_name)) : '') + '</div></td>' +
        '<td class="num">' + inr(x.amount || 0) + '</td></tr>'
    ).join('') + '</tbody></table></div>'
  ) : '<div class="ledger-empty">No transactions synced yet.</div>';
  document.querySelectorAll('#tvVouchersList tr[data-voucher-idx]').forEach(row => {
    const x = rec[Number(row.dataset.voucherIdx)];
    row.addEventListener('click', () => openTallyRowDetail(x.voucher_type || 'Voucher', x.party_name || (x.voucher_number ? '#' + x.voucher_number : 'Voucher'), x.amount, [
      x.voucher_number ? ['Voucher number', x.voucher_number] : null,
      x.date ? ['Date', fmtDate(x.date)] : null,
      x.narration ? ['Narration', x.narration] : null
    ]));
  });

  // ledger balances
  const ledItems = (led.items || []).filter(x => x.closing_balance != null)
    .slice().sort((a, c) => Math.abs(c.closing_balance) - Math.abs(a.closing_balance)).slice(0, 40);
  const ledSub = document.getElementById('tvLedgersSub');
  if(ledSub) ledSub.textContent = ledItems.length ? (ledItems.length + ' of ' + (led.count || ledItems.length) + ' · largest first') : 'largest first';
  document.getElementById('tvLedgersList').innerHTML = ledItems.length ? (
    '<div class="dscroll"><table class="dtable"><colgroup><col><col style="width:116px"></colgroup>' +
    '<thead><tr><th>Ledger</th><th class="num">Closing balance</th></tr></thead><tbody>' +
    ledItems.map((x, i) => {
      const bal = Number(x.closing_balance);
      return '<tr data-row data-led-idx="' + i + '">' +
        '<td><div class="dt-main">' + escapeHtml(x.name) + '</div>' +
        '<div class="dt-sub">' + escapeHtml(x.parent || '') + '</div></td>' +
        '<td class="num">' + inr(Math.abs(bal)) + (bal < 0 ? ' Cr' : ' Dr') + '</td></tr>';
    }).join('') + '</tbody></table></div>'
  ) : '<div class="ledger-empty">No closing balances yet — some Tally setups return these blank; the connector still records ledger names and groups.</div>';
  document.querySelectorAll('#tvLedgersList tr[data-led-idx]').forEach(row => {
    const x = ledItems[Number(row.dataset.ledIdx)];
    const bal = Number(x.closing_balance);
    row.addEventListener('click', () => openTallyRowDetail('Ledger', x.name, Math.abs(bal), [
      x.parent ? ['Group', x.parent] : null,
      ['Balance type', bal < 0 ? 'Credit' : 'Debit']
    ]));
  });

  wireDscroll(content);

  // nav badge: overdue bill count, folded into the single Books badge
  tallyOverdueCount = (b.items || []).filter(x => x.overdue_days != null && x.overdue_days > 0).length;
  renderBooksBadge();
}
/* ============================================================
   ZOHO BOOKS CONNECTOR (NEW) — OAuth 2.0, org-picker gated.
   The only connector that can unlock receivables aging, payables
   due, GST/ITC leakage and true net margin, because those live in
   the books and nowhere else.

   All arithmetic happens server-side in the zoho_vitals() SQL
   function; this file only renders what /api/zoho?action=vitals returns,
   so the app and the AI briefing always read identical numbers.
   ============================================================ */
async function zohoApi(path, opts){
  opts = opts || {};
  const { data:{ session } } = await sbClient.auth.getSession();
  const token = session ? session.access_token : null;
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type':'application/json', 'Authorization': 'Bearer ' + token },
    body: opts.body
  });
  const data = await res.json().catch(() => ({}));
  if(!res.ok) throw new Error(data.error || data.message || ('Request failed (' + res.status + ')'));
  return data;
}
function zohoShowError(msg){
  const el = document.getElementById('zohoError');
  if(!el) return;
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
}
/* ---------- status row inside Connectors ---------- */
async function loadZohoVitals(){
  try {
    const v = await zohoApi('/api/zoho?action=vitals');
    zohoConnected = v && v.connected === true;
    zohoVitals = zohoConnected ? v : null;
    zohoLedgerRows = zohoConnected
      ? { receivables: Array.isArray(v.receivables_list) ? v.receivables_list : [], payables: Array.isArray(v.payables_list) ? v.payables_list : [] }
      : { receivables: [], payables: [] };
  } catch(e){
    // A failed status *check* — cold start, transient 500, a network blip
    // right after a heavier Sync Now call — used to be treated identically
    // to "genuinely disconnected", collapsing straight to the Connect
    // button. That button kicks off a brand-new OAuth flow, so one flaky
    // request could funnel a still-connected user into reconnecting,
    // creating duplicate zoho_organizations rows and re-triggering the
    // org picker for no reason. Keep the last known good state instead —
    // an actual disconnect is reflected honestly (zohoConnected only ever
    // becomes true from a real `connected:true` response), this just
    // stops a fetch failure from masquerading as one.
    console.error('[margyn] Zoho status check failed, keeping last known state:', e.message);
  }
  renderZohoStatus();
  renderZohoBooksTab();
}
function renderZohoStatus(){
  const host = document.getElementById('zohoStatus'); if(!host) return;
  if(zohoConnected && zohoVitals){
    const needsReauth = zohoVitals.status === 'needs_reauth';
    const name = escapeHtml(zohoVitals.organization_name || zohoVitals.organization_id || 'your organization');
    const meta = needsReauth
      ? 'Needs re-authentication, reconnect to resume nightly syncing'
      : (zohoVitals.backfill_completed_at
          ? 'Connected to ' + name + ', syncing nightly at 2:30 AM IST'
          : 'Connected to ' + name + ', first 12-month backfill in progress');
    host.innerHTML =
      '<div class="ledger-row"><div class="lr-main">' +
        '<div class="lr-party">Zoho Books</div>' +
        '<div class="lr-meta">' + meta + '</div>' +
      '</div><span class="lr-tag ' + (needsReauth ? 'bad' : 'ok') + '">' + (needsReauth ? 'Reconnect' : 'Connected') + '</span>' +
      '<div class="lr-actions">' +
        (needsReauth ? '<button class="lr-btn" id="zohoReconnectBtn">Reconnect</button>'
                     : '<button class="lr-btn" id="zohoSyncBtn">Sync now</button>') +
        '<button class="lr-btn danger" id="zohoDisconnectBtn">Disconnect</button>' +
      '</div></div>';
    const s = document.getElementById('zohoSyncBtn'); if(s) s.addEventListener('click', syncZohoNow);
    const r = document.getElementById('zohoReconnectBtn'); if(r) r.addEventListener('click', openZohoModal);
    document.getElementById('zohoDisconnectBtn').addEventListener('click', disconnectZoho);
  } else {
    host.innerHTML =
      '<div class="ledger-row"><div class="lr-main">' +
        '<div class="lr-party">Zoho Books</div>' +
        '<div class="lr-meta">Not connected · unlocks receivables, payables, GST/ITC leakage and true margin</div>' +
      '</div><div class="lr-actions"><button class="lr-btn connect" id="connectZohoBtn">Connect</button></div></div>';
    const btn = document.getElementById('connectZohoBtn');
    if(btn) btn.addEventListener('click', openZohoModal);
  }
}
/* ---------- step 1: consent ---------- */
const ZOHO_REGIONS = [
  ['in','India (zoho.in)'], ['com','Global (zoho.com)'], ['eu','Europe (zoho.eu)'],
  ['au','Australia (zoho.com.au)'], ['uk','UK (zoho.uk)'], ['ca','Canada (zohocloud.ca)'],
  ['jp','Japan (zoho.jp)'], ['sa','Saudi Arabia (zoho.sa)']
];
function openZohoModal(){
  const overlay = document.getElementById('zohoOverlay');
  const host = document.getElementById('zohoContent');
  const opts = ZOHO_REGIONS.map(r => '<option value="'+r[0]+'"'+(r[0]==='in'?' selected':'')+'>'+r[1]+'</option>').join('');
  host.innerHTML =
    '<div class="detail-eyebrow">Connect data</div>' +
    '<div class="detail-title">Connect Zoho Books</div>' +
    '<div class="zoho-scope-note">Read-only access</div>' +
    '<div class="detail-body" style="margin-bottom:16px;">You will sign in on Zoho\'s own page. Margyn never sees your Zoho password. Margyn only ever reads your books and never creates, edits or deletes anything in them.</div>' +
    '<div class="ledger-form">' +
      '<div class="lf-title">Your Zoho data centre</div>' +
      '<select id="zohoRegion" style="margin-bottom:8px;">' + opts + '</select>' +
      '<div style="font-size:12px; color:var(--text-2); margin-bottom:10px;">Most Indian businesses are on zoho.in. If you sign in at a different Zoho domain, pick it here. Margyn will still auto-correct to the right one after you approve.</div>' +
      '<div class="note bad" id="zohoError" style="display:none; margin-bottom:8px;"></div>' +
      '<button id="zohoConnectBtn">Continue to Zoho</button>' +
    '</div>';
  document.getElementById('zohoConnectBtn').addEventListener('click', async () => {
    const btn = document.getElementById('zohoConnectBtn');
    zohoShowError('');
    btn.disabled = true; btn.textContent = 'Opening Zoho…';
    try {
      const region = document.getElementById('zohoRegion').value;
      const out = await zohoApi('/api/zoho?action=oauth-start', { method:'POST', body: JSON.stringify({ region: region }) });
      const w = window.open(out.authorize_url, 'zoho_oauth', 'width=560,height=720');
      if(!w) zohoShowError('Your browser blocked the popup. Allow popups for this site and try again.');
    } catch(e){ zohoShowError(e.message); }
    finally { btn.disabled = false; btn.textContent = 'Continue to Zoho'; }
  });
  overlay.classList.remove('hidden');
}
/* The callback page posts back here, then closes itself. */
window.addEventListener('message', (ev) => {
  if(!ev.data || ev.data.source !== 'margyn-zoho-oauth') return;
  const p = ev.data.payload || {};
  if(!p.ok){
    // The callback already tells us exactly which stage failed. Show it,
    // instead of collapsing six distinct failures into one useless sentence.
    console.error('[margyn] Zoho OAuth failed:', p);
    document.getElementById('zohoOverlay').classList.remove('hidden');
    const ZOHO_FAIL = {
      invalid_state: 'The connection link expired before Zoho sent you back. Try again and move through the Zoho screens without pausing.',
      missing_code: 'Zoho did not return an authorization code.',
      token_exchange_failed: 'Zoho rejected the token exchange, usually a data-centre mismatch or the client secret not being valid for that data centre.',
      db_write_failed: 'Could not record the connection, the zoho_organizations write failed. Check the SQL migration ran.',
      vault_write_failed: 'Could not store the Zoho token, the Supabase vault write failed. Check the supabase_vault extension is enabled.',
      org_list_failed: 'Signed in to Zoho, but could not list your Books organizations.',
      no_books_organization: 'That Zoho login has no Zoho Books organization. A Zoho Books plan (the free plan works) is required.'
    };
    zohoShowError((ZOHO_FAIL[p.reason] || 'Could not complete the Zoho connection.') + '  [' + (p.reason || 'unknown') + ']');
    return;
  }
  zohoPendingOrgRef = p.org_ref;
  renderZohoOrgPicker(p.organizations || []);
});
/* Popup blocked? The callback falls back to a redirect carrying the org ref. */
function handleZohoHashReturn(){
  if(location.hash.indexOf('zoho=select-org') === -1) return;
  const m = /org_ref=([^&]+)/.exec(location.hash);
  if(!m) return;
  zohoPendingOrgRef = decodeURIComponent(m[1]);
  history.replaceState(null, '', location.pathname + location.search);
  zohoApi('/api/zoho?action=select-org&org_ref=' + encodeURIComponent(zohoPendingOrgRef))
    .then(d => renderZohoOrgPicker(d.organizations || []))
    .catch(e => { document.getElementById('zohoOverlay').classList.remove('hidden'); zohoShowError(e.message); });
}
/* ---------- step 2: org picker — activation blocks until one is chosen ---------- */
function renderZohoOrgPicker(orgs){
  const overlay = document.getElementById('zohoOverlay');
  const host = document.getElementById('zohoContent');
  zohoChosenOrgId = null;
  host.innerHTML =
    '<div class="detail-eyebrow">Almost done</div>' +
    '<div class="detail-title">Choose your organization</div>' +
    '<div class="detail-body" style="margin-bottom:16px;">This is the entity Margyn calculates your vitals from. Choose carefully: connecting a second entity later is a separate connection, not a setting you can change afterwards.</div>' +
    '<div id="zohoOrgList"></div>' +
    '<div class="note bad" id="zohoError" style="display:none; margin:10px 0;"></div>' +
    '<button class="auth-submit" id="zohoOrgConfirm" disabled style="margin-top:8px;">Confirm organization</button>';
  const list = document.getElementById('zohoOrgList');
  orgs.forEach(o => {
    const row = document.createElement('label');
    row.className = 'org-option';
    row.innerHTML =
      '<input type="radio" name="zohoOrg">' +
      '<span class="org-name">' + escapeHtml(o.name || o.organization_id) + '</span>' +
      '<span class="org-meta">' + escapeHtml(o.plan_type || 'plan n/a') + ' · ' + escapeHtml(o.currency_code || 'INR') + '</span>';
    row.querySelector('input').addEventListener('change', () => {
      zohoChosenOrgId = o.organization_id;
      document.getElementById('zohoOrgConfirm').disabled = false;
    });
    list.appendChild(row);
  });
  document.getElementById('zohoOrgConfirm').addEventListener('click', confirmZohoOrg);
  overlay.classList.remove('hidden');
}
async function confirmZohoOrg(){
  if(!zohoChosenOrgId || !zohoPendingOrgRef) return;
  const btn = document.getElementById('zohoOrgConfirm');
  zohoShowError('');
  btn.disabled = true; btn.textContent = 'Connecting…';
  btn.textContent = 'Connecting… (first sync can take a minute)';
  try {
    // select-org now runs the one-time 12-month backfill in-process and
    // waits for it to finish before responding, so this call can take a
    // while on a data-heavy org — see api/_zoho/select-org.js.
    const out = await zohoApi('/api/zoho?action=select-org', {
      method: 'POST',
      body: JSON.stringify({ org_ref: zohoPendingOrgRef, organization_id: zohoChosenOrgId })
    });
    document.getElementById('zohoOverlay').classList.add('hidden');
    zohoPendingOrgRef = null; zohoChosenOrgId = null;
    await loadZohoVitals();
    if(out.multi_currency_detected){
      toast('Non-INR base currency', { kind:'info', ms:6000, sub:'Those records stay out of your vitals until currency conversion lands.' });
    }
  } catch(e){
    zohoShowError(e.message);
    btn.disabled = false;
  } finally { btn.textContent = 'Confirm organization'; }
}
document.getElementById('zohoClose').addEventListener('click', () => document.getElementById('zohoOverlay').classList.add('hidden'));
document.getElementById('zohoOverlay').addEventListener('click', (e) => { if(e.target.id === 'zohoOverlay') e.currentTarget.classList.add('hidden'); });
/* ---------- sync / disconnect ---------- */
async function syncZohoNow(){
  const btn = document.getElementById('zohoSyncBtn');
  if(btn){ btn.disabled = true; btn.textContent = 'Syncing…'; }
  try {
    await zohoApi('/api/zoho?action=sync', { method:'POST', body: JSON.stringify({ mode:'delta' }) });
    await loadZohoVitals();
  } catch(e){
    if(btn){ btn.textContent = 'Sync failed'; setTimeout(() => { btn.disabled = false; btn.textContent = 'Sync now'; }, 2200); return; }
  }
  if(btn){ btn.disabled = false; btn.textContent = 'Sync now'; }
}
async function disconnectZoho(){
  if(!(await mgConfirm({ title:'Disconnect Zoho Books?', body:'Your historical figures stay visible in Margyn, but nothing new will sync until you reconnect.', confirmLabel:'Disconnect', danger:true }))) return;
  const btn = document.getElementById('zohoDisconnectBtn');
  if(btn){ btn.disabled = true; btn.textContent = 'Disconnecting…'; }
  try { await zohoApi('/api/zoho?action=disconnect', { method:'POST', body: JSON.stringify({}) }); }
  catch(e){ toast('Could not disconnect: ' + e.message, {kind:'bad'}); }
  await loadZohoVitals();
}
/* ============================================================
   ODOO CONNECTOR — Odoo External API (JSON-RPC). Manual credential
   entry (base URL + database + login + API key), the Razorpay
   pattern, not OAuth. Everything synced is Signal-tier: one
   self-reported books source, moves no vital on its own. Routed
   through /api/zoho?action=odoo-* to stay under the function cap.
   ============================================================ */
async function loadOdooStatus(){
  try {
    const d = await zohoApi('/api/zoho?action=odoo-status');
    odooConnected = d && d.connected === true;
    odooStatus = odooConnected ? d : null;
  } catch(e){
    // A failed status check (cold start, transient 500) shouldn't masquerade
    // as a disconnect — keep the last known state, same as the Zoho card.
    console.error('[margyn] Odoo status check failed, keeping last known state:', e.message);
  }
  renderOdooStatus();
}
function renderOdooStatus(){
  const host = document.getElementById('odooStatus'); if(!host) return;
  if(odooConnected && odooStatus){
    const s = odooStatus;
    const needsReauth = !!s.needs_reauth;
    const rec = s.receivables || {}, pay = s.payables || {};
    let meta;
    if(needsReauth){
      meta = escapeHtml(s.instance || 'your Odoo instance') + ', API key rejected — reconnect to resume nightly syncing';
    } else {
      meta = escapeHtml(s.instance || 'Odoo') +
             ' · ' + (rec.open_count || 0) + ' open invoices, ' + (pay.open_count || 0) + ' open bills' +
             (s.last_success_at ? ', last synced ' + fmtDate(s.last_success_at) : '');
    }
    host.innerHTML =
      '<div class="ledger-row"><div class="lr-main">' +
        '<div class="lr-party">Odoo</div>' +
        '<div class="lr-meta">' + meta + '</div>' +
      '</div><span class="lr-tag ' + (needsReauth ? 'bad' : 'ok') + '">' + (needsReauth ? 'Reconnect' : 'Connected') + '</span>' +
      '<div class="lr-actions">' +
        (needsReauth ? '<button class="lr-btn" id="odooReconnectBtn">Reconnect</button>'
                     : '<button class="lr-btn" id="odooSyncBtn">Sync now</button>') +
        '<button class="lr-btn danger" id="odooDisconnectBtn">Disconnect</button>' +
      '</div></div>';
    const sy = document.getElementById('odooSyncBtn'); if(sy) sy.addEventListener('click', syncOdooNow);
    const rc = document.getElementById('odooReconnectBtn'); if(rc) rc.addEventListener('click', openOdooModal);
    document.getElementById('odooDisconnectBtn').addEventListener('click', disconnectOdoo);
  } else {
    host.innerHTML =
      '<div class="ledger-row"><div class="lr-main">' +
        '<div class="lr-party">Odoo</div>' +
        '<div class="lr-meta">Not connected · pulls open invoices and vendor bills from Odoo Accounting for receivables and payables aging</div>' +
      '</div><div class="lr-actions"><button class="lr-btn connect" id="connectOdooBtn">Connect</button></div></div>';
    const btn = document.getElementById('connectOdooBtn');
    if(btn) btn.addEventListener('click', openOdooModal);
  }
}
function openOdooModal(){
  const overlay = document.getElementById('odooOverlay');
  const host = document.getElementById('odooContent');
  host.innerHTML =
    '<div class="detail-eyebrow">Connect data</div>' +
    '<div class="detail-title">Connect Odoo</div>' +
    '<div class="detail-body" style="margin-bottom:16px;">Reads your Odoo Accounting invoices and vendor bills each night. Read-only, and your manual upload stays the primary source. Works with Odoo Online, Odoo.sh and any self-hosted Odoo reachable over HTTPS.</div>' +
    '<div class="ledger-form">' +
      '<div class="lf-title">Odoo External API</div>' +
      '<input type="text" id="odooUrl" placeholder="Odoo URL (acme.odoo.com)" style="margin-bottom:8px;">' +
      '<input type="text" id="odooDb" placeholder="Database name" style="margin-bottom:8px;">' +
      '<input type="text" id="odooLogin" placeholder="User login (email)" style="margin-bottom:8px;" autocomplete="off">' +
      '<input type="password" id="odooKey" placeholder="API key" autocomplete="off">' +
      '<div style="font-size:12px; color:var(--text-2); margin:8px 0;">Generate an API key in Odoo under your user avatar → Account Security → New API Key. On Odoo below v14, paste that user\'s password instead. Multi-company Odoo syncs the API user\'s default company.</div>' +
      '<div class="note bad" id="odooError" style="display:none; margin-bottom:8px;"></div>' +
      '<div class="note ok" id="odooSuccess" style="display:none; margin-bottom:8px;"></div>' +
      '<button id="odooConnectBtn">Connect</button>' +
    '</div>';
  document.getElementById('odooConnectBtn').addEventListener('click', async () => {
    const baseUrl = document.getElementById('odooUrl').value.trim();
    const db = document.getElementById('odooDb').value.trim();
    const login = document.getElementById('odooLogin').value.trim();
    const apiKey = document.getElementById('odooKey').value.trim();
    const errorEl = document.getElementById('odooError');
    const successEl = document.getElementById('odooSuccess');
    const btn = document.getElementById('odooConnectBtn');
    errorEl.style.display = 'none'; successEl.style.display = 'none';
    if(!baseUrl || !db || !login || !apiKey){ errorEl.textContent = 'All four fields are required'; errorEl.style.display = 'block'; return; }
    btn.disabled = true; btn.textContent = 'Connecting…';
    try {
      const data = await zohoApi('/api/zoho?action=odoo-connect', {
        method: 'POST',
        body: JSON.stringify({ baseUrl, db, login, apiKey })
      });
      successEl.textContent = '✓ Connected' + (data.company_name ? ' — ' + data.company_name : '') + '. Syncing now…';
      successEl.style.display = 'block';
      setTimeout(async () => { await refreshAll(); overlay.classList.add('hidden'); }, 1500);
    } catch(err){
      errorEl.textContent = err.message || 'Connection failed';
      errorEl.style.display = 'block';
    } finally { btn.disabled = false; btn.textContent = 'Connect'; }
  });
  overlay.classList.remove('hidden');
}
async function syncOdooNow(){
  const btn = document.getElementById('odooSyncBtn');
  if(btn){ btn.disabled = true; btn.textContent = 'Syncing…'; }
  try {
    await zohoApi('/api/zoho?action=odoo-sync', { method:'POST', body: JSON.stringify({}) });
    await loadOdooStatus();
  } catch(e){
    if(btn){ btn.textContent = 'Sync failed'; setTimeout(() => { btn.disabled = false; btn.textContent = 'Sync now'; }, 2200); return; }
  }
  if(btn){ btn.disabled = false; btn.textContent = 'Sync now'; }
}
async function disconnectOdoo(){
  if(!(await mgConfirm({ title:'Disconnect Odoo?', body:'Your historical invoice and bill data stays visible in Margyn, but nothing new will sync until you reconnect.', confirmLabel:'Disconnect', danger:true }))) return;
  const btn = document.getElementById('odooDisconnectBtn');
  if(btn){ btn.disabled = true; btn.textContent = 'Disconnecting…'; }
  try { await zohoApi('/api/zoho?action=odoo-disconnect', { method:'POST', body: JSON.stringify({}) }); }
  catch(e){ toast('Could not disconnect: ' + e.message, {kind:'bad'}); }
  await loadOdooStatus();
}
document.getElementById('odooClose').addEventListener('click', () => document.getElementById('odooOverlay').classList.add('hidden'));
document.getElementById('odooOverlay').addEventListener('click', (e) => { if(e.target.id === 'odooOverlay') e.currentTarget.classList.add('hidden'); });
/* ---------- books tab ---------- */
function zvSet(id, text){ const el = document.getElementById(id); if(el) el.textContent = text; }
function zvFlag(id, cls, text){ const el = document.getElementById(id); if(!el) return; el.textContent = text || ''; el.className = 'pc-flag ' + (cls || ''); }
let booksActiveSource = 'all'; // 'all', 'zoho', 'tally' or 'odoo'. Presentational source switch on the Books hub.
function renderBooksHub(){
  relocateTallyIntoBooks();
  relocateLedgerIntoBooks();
  const manual = document.getElementById('booksManualBlocks');
  const zoho = document.getElementById('booksZohoBlocks');
  const tally = document.getElementById('booksTallyBlocks');
  const odoo = document.getElementById('booksOdooBlocks');
  const recon = document.getElementById('zvReconCard');
  const allNote = document.getElementById('booksAllNote');
  const s = booksActiveSource;
  if(manual) manual.classList.toggle('hidden', !(s === 'all' || s === 'manual'));
  if(zoho) zoho.classList.toggle('hidden', !(s === 'all' || s === 'zoho'));
  if(tally) tally.classList.toggle('hidden', !(s === 'all' || s === 'tally'));
  if(odoo) odoo.classList.toggle('hidden', !(s === 'all' || s === 'odoo'));
  if(allNote) allNote.classList.toggle('hidden', s !== 'all');
  document.querySelectorAll('#booksSourceTabs button').forEach(b => b.classList.toggle('active', b.dataset.src === s));
  // The entries table inside the quick ledger has its own source filter that
  // does the same job as these tabs — keep them in step so picking "Tally"
  // up here doesn't leave a table below showing everything.
  const lsf = document.getElementById('ledgerSourceFilter');
  if(lsf){
    const want = s === 'manual' ? 'self' : (s === 'all' ? 'all' : s);
    if(lsf.value !== want && [...lsf.options].some(o => o.value === want)){
      lsf.value = want;
      ledgerSourceFilter = want;
    }
  }
  renderSourceConflicts();
  if(s === 'all' || s === 'manual'){ if(typeof renderLedgerView === 'function') renderLedgerView(); }
  renderZohoBooksTab();
  renderTallyTab();
  renderBooksOdooPanel();
  if(recon && (s === 'tally' || s === 'odoo')) recon.classList.add('hidden');
}
/* The Tally panels live in #view-tally in the source so the markup stays
   readable, but they belong to the Books hub at runtime. This used to run
   inside renderBooksHub(), which meant the move happened the first time the
   user opened Books — a visible jump as the grid re-measured against its new
   parent. Run it once at boot instead, before Books is ever painted. */
function relocateTallyIntoBooks(){
  const tMount = document.getElementById('booksTallyMount');
  const tContent = document.getElementById('tallyTabContent');
  const tNot = document.getElementById('tallyNotConnected');
  if(!tMount || !tContent || tContent.parentElement === tMount) return;
  if(tNot) tMount.appendChild(tNot);
  tMount.appendChild(tContent);
}
/* The quick ledger (manual receivables/payables) is a source of accounting
   truth like any other, so it belongs on the Books hub next to Zoho, Tally
   and Odoo rather than on a nav item of its own — especially now that a
   connector figure can outrank a hand-typed one. Same boot-time move as
   Tally so nothing jumps on first paint. */
function relocateLedgerIntoBooks(){
  const mount = document.getElementById('booksManualMount');
  const quick = document.getElementById('lsuper-quick');
  if(!mount || !quick || quick.parentElement === mount) return;
  quick.classList.remove('lsuper-panel');
  quick.classList.add('active');
  mount.appendChild(quick);
}
/* Invoicing had the same lazy-relocate-on-first-view pattern; hoist it too. */
function relocateKhataIntoInvoicing(){
  const mount = document.getElementById('invoicingMount');
  const khata = document.getElementById('lsuper-khata');
  if(!mount || !khata || khata.parentElement === mount) return;
  khata.classList.remove('lsuper-panel');
  khata.classList.add('active');
  mount.appendChild(khata);
}
relocateTallyIntoBooks();
relocateLedgerIntoBooks();
relocateKhataIntoInvoicing();
document.querySelectorAll('#booksSourceTabs button').forEach(b => b.addEventListener('click', () => {
  booksActiveSource = b.dataset.src; renderBooksHub();
}));
/* Cross-source disagreements recorded on the latest resolved snapshot.
   Shown on the Books hub because that is where the competing sources live. */
const CONFLICT_FIELD_LABEL = {
  cash:'Cash position', revenue:'Revenue', net_profit:'Net profit', burn:'Total spend',
  gst_leak:'GST/ITC leakage', gst_payable:'GST payable', recv_total:'Receivables',
  recv_90:'Receivables over 90d', pay_soon:'Payables due (30d)'
};
const SOURCE_DISPLAY = { zoho:'Zoho Books', tally:'Tally', odoo:'Odoo', self:'Self-reported',
                         manual:'Manual entry', upload:'CSV upload', ledger:'Ledger entry' };
function renderSourceConflicts(){
  const card = document.getElementById('srcConflictCard');
  const list = document.getElementById('srcConflictList');
  const sub  = document.getElementById('srcConflictSub');
  if(!card || !list) return;
  const conflicts = (snapshots[0] || {}).source_conflicts || [];
  if(!conflicts.length){ card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  if(sub) sub.textContent = conflicts.length + (conflicts.length === 1 ? ' figure' : ' figures');
  list.innerHTML = conflicts.map(c => {
    const vals = Object.keys(c.values || {})
      .map(k => (SOURCE_DISPLAY[k] || k) + ' ' + inr(c.values[k]))
      .join('  ·  ');
    return '<div class="conflict-row">' +
      '<span class="cf-field">' + escapeHtml(CONFLICT_FIELD_LABEL[c.field] || c.field) + '</span>' +
      '<span class="cf-vals">' + escapeHtml(vals) + '</span>' +
      '<span class="cf-spread">' + (c.spread_pct || 0) + '% apart</span>' +
      '<span class="src-tag connector">Used ' + escapeHtml(SOURCE_DISPLAY[c.chosen] || c.chosen) + '</span>' +
    '</div>';
  }).join('');
}
function renderBooksOdooPanel(){
  const host = document.getElementById('booksOdooMount'); if(!host) return;
  if(typeof odooConnected === 'undefined' || !odooConnected || !odooStatus){
    host.innerHTML = '<div class="ledger-empty">Odoo is not connected. Add it under Connections to pull open invoices and vendor bills.</div>';
    return;
  }
  const s = odooStatus;
  const rec = s.receivables || {}, pay = s.payables || {};
  const cash = s.cash_position || { bank_data_available: false };
  host.innerHTML =
    '<div class="pay-grid">' +
      '<div class="pay-card" data-margyn-topic="Odoo receivables"><div class="pc-label">Receivables outstanding</div><div class="pc-value">'+inr(rec.total || rec.amount || 0)+'</div><div class="pc-sub">'+(rec.open_count || 0)+' open invoices. Signal.</div></div>' +
      '<div class="pay-card" data-margyn-topic="Odoo payables"><div class="pc-label">Payables due</div><div class="pc-value">'+inr(pay.total || pay.amount || 0)+'</div><div class="pc-sub">'+(pay.open_count || 0)+' open bills. Signal.</div></div>' +
      '<div class="pay-card" data-margyn-topic="Odoo cash"><div class="pc-label">Bank + cash</div><div class="pc-value">'+(cash.bank_data_available === false ? 'Not available' : inr(cash.balance || 0))+'</div><div class="pc-sub">'+(cash.bank_data_available === false ? 'Re-sync Odoo to pull liquidity account balances.' : ((cash.account_count || 0) + ' liquidity account(s). Feeds Cash Position.'))+'</div></div>' +
      '<div class="pay-card"><div class="pc-label">Instance</div><div class="pc-value" style="font-size:13px;">'+escapeHtml(s.instance || 'Odoo')+'</div><div class="pc-sub">'+(s.last_success_at ? 'Last synced ' + fmtDate(s.last_success_at) : 'Pending first sync')+'</div></div>' +
    '</div>';
}
/* Brand accent per connector for the flow-map logo tiles. Swap the letter
   tile for <img src="images/connectors/<key>.svg"> once the real logos land. */
const CONN_BRAND = {
  razorpay: { color:'#0C2451' }, cashfree: { color:'#6933FF' }, zoho: { color:'#E42527' },
  tally: { color:'#1F6BB8' }, odoo: { color:'#714B67' }, shopify: { color:'#5E8E3E' }
};
const CONN_FEED_MAP = [
  { key:'razorpay', label:'Razorpay', feeds:'Payments health, cash position cross-check, reconciliation', tier:'Verified' },
  { key:'cashfree', label:'Cashfree', feeds:'Settlement reconciliation', tier:'Signal' },
  { key:'zoho', label:'Zoho Books', feeds:'Receivables, payables, GST/ITC, net margin, working-capital runway', tier:'Verified' },
  { key:'tally', label:'Tally', feeds:'Receivables, payables, sales, ledger balances', tier:'Signal' },
  { key:'odoo', label:'Odoo', feeds:'Receivables and payables aging', tier:'Signal' },
  { key:'shopify', label:'Shopify', feeds:'Order volume and revenue reference', tier:'Signal' }
];
function connIsLive(key){
  const map = {
    razorpay: typeof razorpayConnected !== 'undefined' && razorpayConnected,
    cashfree: typeof cashfreeConnected !== 'undefined' && cashfreeConnected,
    zoho: typeof zohoConnected !== 'undefined' && zohoConnected,
    tally: typeof tallyConnected !== 'undefined' && tallyConnected,
    odoo: typeof odooConnected !== 'undefined' && odooConnected,
    shopify: typeof shopifyConnected !== 'undefined' && shopifyConnected
  };
  return !!map[key];
}
function renderConnectionsHub(){
  ['renderRazorpayStatus','renderZohoStatus','renderOdooStatus','renderShopifyStatus','renderTallyStatus','renderCashfreeStatus'].forEach(fn => { if(typeof window[fn] === 'function'){ try { window[fn](); } catch(e){} } });
  const anyLive = CONN_FEED_MAP.some(c => connIsLive(c.key));
  const nudge = document.getElementById('day1Nudge');
  if(nudge) nudge.classList.toggle('hidden', anyLive);
  // flow map: HTML chips (crisp type, drop-in logos later) + an SVG line layer
  const map = document.getElementById('connFlowMap');
  if(map){
    map.className = 'rd-flowmap';
    const n = CONN_FEED_MAP.length;
    const H = Math.max(300, n * 64 + 40);
    const chipX = 244, hubX = 560, hubY = H / 2, W = 620;
    const yFor = i => 40 + i * ((H - 80) / (n - 1));
    let chips = '', paths = '', dots = '';
    CONN_FEED_MAP.forEach((c, i) => {
      const live = connIsLive(c.key);
      const y = yFor(i);
      const brand = CONN_BRAND[c.key] || { color: '#767E8B' };
      chips += '<div class="fm-chip' + (live ? '' : ' off') + '" style="top:' + y + 'px;">' +
        '<span class="fm-logo" style="background:' + (live ? brand.color : 'var(--surf-2)') + ';color:' + (live ? '#fff' : 'var(--text-3)') + ';">' + escapeHtml(c.label[0]) + '</span>' +
        '<span class="fm-meta"><span class="fm-name">' + escapeHtml(c.label) + '</span>' +
        '<span class="fm-stat">' + (live ? 'Live' : 'Not connected') + '</span></span></div>';
      const d = 'M' + chipX + ',' + y.toFixed(0) + ' C' + (chipX + 90) + ',' + y.toFixed(0) + ' ' + (hubX - 120) + ',' + hubY + ' ' + (hubX - 30) + ',' + hubY;
      paths += '<path class="fm-path' + (live ? ' live' : '') + '" d="' + d + '"></path>';
      if(live) dots += '<circle class="fm-dot" r="3.2"><animateMotion dur="2.4s" begin="' + (i * 0.45).toFixed(2) + 's" repeatCount="indefinite" path="' + d + '"></animateMotion></circle>';
    });
    map.style.height = H + 'px';
    map.innerHTML =
      '<svg class="fm-lines" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<defs><linearGradient id="rdEmGrad" x1="0" x2="1"><stop offset="0" stop-color="#3FD79A"/><stop offset="1" stop-color="#0E8F5C"/></linearGradient></defs>' +
      paths + dots + '</svg>' +
      chips +
      '<div class="fm-hub"><span class="fm-hub-ring"></span><span class="fm-hub-core">M</span></div>';
  }
  // feed table
  const t = document.getElementById('connFeedTable');
  if(t){
    let rows = '<thead><tr><th>Source</th><th>Status</th><th>Feeds</th><th>Tier</th></tr></thead><tbody>';
    CONN_FEED_MAP.forEach(c => {
      const live = connIsLive(c.key);
      rows += '<tr><td>' + escapeHtml(c.label) + '</td>' +
        '<td>' + (live ? '<span class="lr-tag ok">Connected</span>' : '<span class="lr-tag unreconciled">Not connected</span>') + '</td>' +
        '<td>' + escapeHtml(c.feeds) + '</td>' +
        '<td>' + escapeHtml(c.tier) + '</td></tr>';
    });
    t.innerHTML = rows + '</tbody>';
  }
}
