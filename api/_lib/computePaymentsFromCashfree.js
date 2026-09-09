/**
 * api/_lib/computePaymentsFromCashfree.js
 *
 * The Cashfree analogue of computePaymentsFromRazorpay.js. Aggregates
 * freshly-synced Cashfree data (cashfree_transactions / cashfree_settlements)
 * into the exact payments_data / settlement_rows / settlement_daily_trend
 * shape the Payments tab and app.html's computePaymentsMetrics() expect.
 *
 * Called by cashfreeSync.js right after a sync — only reads what the sync just
 * wrote, never calls Cashfree itself.
 *
 * IMPORTANT SHAPE NOTES vs the Razorpay version:
 *   - Cashfree amounts are DECIMAL RUPEES, not paise. No /100.
 *   - The Cashfree feed is settlement-recon only, so it contains SETTLED
 *     captures. There is no failed-payment feed in v1 -> `failed` is always 0
 *     and `total` == captured count. The Payments-tab fail-rate will read 0%
 *     for a Cashfree-only merchant until a webhook feed is added. Documented
 *     gap — do not treat 0% as "verified zero".
 */

const { selectRows } = require('./supabaseRest');

const WINDOW_DAYS = 30;

function toIso(daysAgo) {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

async function computePaymentsFromCashfree(userId) {
  const since = toIso(WINDOW_DAYS);

  const [txns, settlements] = await Promise.all([
    selectRows(
      'cashfree_transactions',
      `select=amount,fee,fee_gst,net_amount,payment_method,payment_time,settled_at&user_id=eq.${userId}&payment_time=gte.${since}&order=payment_time.desc&limit=5000`
    ),
    selectRows(
      'cashfree_settlements',
      `select=settlement_id,amount_settled,amount_adjusted,status,settled_on,payment_from,payment_till&user_id=eq.${userId}&settled_on=gte.${since}&order=settled_on.desc&limit=500`
    )
  ]);

  if (!txns.length) return null; // nothing in window — caller leaves existing payments_data untouched

  const gross = txns.reduce((s, t) => s + Number(t.amount || 0), 0);
  // fee + GST on fee, mirroring how Razorpay's inclusive `fee` maps to the
  // "Total MDR + GST on MDR" manual-entry field.
  const mdr = txns.reduce((s, t) => s + Number(t.fee || 0) + Number(t.fee_gst || 0), 0);
  const total = txns.length;

  const upiCount = txns.filter((t) => String(t.payment_method || '').toLowerCase().includes('upi')).length;
  const upiPct = total ? (upiCount / total) * 100 : 0;

  const withLag = txns.filter((t) => t.payment_time && t.settled_at);
  const lagDays = withLag.length
    ? withLag.reduce((s, t) => {
        const paid = new Date(t.payment_time).getTime();
        const settled = new Date(t.settled_at).getTime();
        return s + Math.max(0, (settled - paid) / (1000 * 60 * 60 * 24));
      }, 0) / withLag.length
    : 0;

  const paymentsData = {
    gross: Math.round(gross),
    mdr: Math.round(mdr),
    failed: 0,               // no failed-payment feed in v1 (see file header)
    total,
    lag: Number(lagDays.toFixed(1)),
    upiPct: Math.round(upiPct)
  };

  const settlementRows = settlements.slice(0, 20).map((s) => ({
    id: s.settlement_id,
    date: s.settled_on ? s.settled_on.slice(0, 10) : null,
    gross: Math.round(Number(s.amount_settled || 0) + Number(s.amount_adjusted || 0)),
    net: Math.round(Number(s.amount_settled || 0)),
    settled: String(s.status || '').toUpperCase() === 'PAID'
  }));

  const byDay = {};
  settlements.forEach((s) => {
    if (!s.settled_on) return;
    const day = s.settled_on.slice(0, 10);
    byDay[day] = (byDay[day] || 0) + Number(s.amount_settled || 0);
  });
  const days = Object.keys(byDay).sort();
  const settlementDailyTrend = days.length ? days.slice(-7).map((d) => Math.round(byDay[d])) : null;

  return { paymentsData, settlementRows, settlementDailyTrend };
}

module.exports = { computePaymentsFromCashfree, WINDOW_DAYS };
