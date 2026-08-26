/**
 * Aggregates freshly-synced Razorpay data (razorpay_transactions /
 * razorpay_settlements) into the same payments_data shape the client
 * produces from a manual "Razorpay Settlements" upload or Quick Manual
 * Entry — see app.html's computePaymentsMetrics() / ZERO_PAYMENTS and the
 * paymentsPayload construction in the upload/manual save handlers.
 *
 * Called by sync-razorpay.js right after a sync, never on its own — this
 * only reads what sync-razorpay.js just wrote, it does not call Razorpay.
 */

const { selectRows } = require('./supabaseRest');

const WINDOW_DAYS = 30; // "this period" for the Payments tab — matches a monthly reporting cadence

function toIso(daysAgo) {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Returns { paymentsData, settlementRows, settlementDailyTrend } computed
 * from the last WINDOW_DAYS of synced Razorpay data, or null if there are
 * no captured/failed payments in that window (caller should leave whatever
 * payments_data is already on the snapshot untouched in that case, rather
 * than overwrite it with zeros).
 */
async function computePaymentsFromRazorpay(userId) {
  const since = toIso(WINDOW_DAYS);

  const [payments, settlements] = await Promise.all([
    selectRows(
      'razorpay_transactions',
      `select=amount,status,fee,method,created_at&user_id=eq.${userId}&created_at=gte.${since}&order=created_at.desc&limit=5000`
    ),
    selectRows(
      'razorpay_settlements',
      `select=settlement_id,amount,fee_deducted,status,created_at,processed_at&user_id=eq.${userId}&created_at=gte.${since}&order=created_at.desc&limit=500`
    )
  ]);

  const captured = payments.filter((p) => p.status === 'captured');
  const failed = payments.filter((p) => p.status === 'failed');
  const total = captured.length + failed.length;

  if (total === 0) return null; // nothing synced in window — caller falls back to existing payments_data

  // Razorpay amounts are in paise.
  const gross = captured.reduce((sum, p) => sum + Number(p.amount || 0), 0) / 100;
  // Razorpay's `fee` is inclusive of GST on the fee, so this is MDR + GST on MDR in one figure —
  // matches what the manual-entry field ("Total MDR + GST on MDR charged") asks for.
  const mdr = captured.reduce((sum, p) => sum + Number(p.fee || 0), 0) / 100;
  const upiCount = captured.filter((p) => p.method === 'upi').length;
  const upiPct = captured.length ? (upiCount / captured.length) * 100 : 0;

  const processedSettlements = settlements.filter((s) => s.processed_at && s.created_at);
  const lagDays = processedSettlements.length
    ? processedSettlements.reduce((sum, s) => {
        const created = new Date(s.created_at).getTime();
        const processed = new Date(s.processed_at).getTime();
        return sum + Math.max(0, (processed - created) / (1000 * 60 * 60 * 24));
      }, 0) / processedSettlements.length
    : 0;

  const paymentsData = {
    gross: Math.round(gross),
    mdr: Math.round(mdr),
    failed: failed.length,
    total,
    lag: Number(lagDays.toFixed(1)),
    upiPct: Math.round(upiPct)
  };

  const settlementRows = settlements.slice(0, 20).map((s) => ({
    id: s.settlement_id,
    date: s.created_at ? s.created_at.slice(0, 10) : null,
    gross: Math.round(Number(s.amount || 0) / 100),
    net: Math.round((Number(s.amount || 0) - Number(s.fee_deducted || 0)) / 100),
    settled: s.status === 'processed'
  }));

  const byDay = {};
  settlements.forEach((s) => {
    if (!s.created_at) return;
    const day = s.created_at.slice(0, 10);
    byDay[day] = (byDay[day] || 0) + Number(s.amount || 0) / 100;
  });
  const days = Object.keys(byDay).sort();
  const settlementDailyTrend = days.length ? days.slice(-7).map((d) => Math.round(byDay[d])) : null;

  return { paymentsData, settlementRows, settlementDailyTrend };
}

module.exports = { computePaymentsFromRazorpay, WINDOW_DAYS };
