/**
 * _lib/forecastStore.js
 * What Margyn keeps so the forecast gets better on its own (2026-10-04).
 *
 *  - forecast_runs: one forecast per account per India day (the daily path, its range and what drove it).
 *    Once the dates pass, cashFlowModel.accuracyFromRuns grades each run against what the bank actually did,
 *    so the app can show its track record and the model can see where it is biased.
 *  - daily_positions: end-of-day cash, receivables and payables per account. The books only hold this
 *    financial year and can be edited later; this keeps the record of what they said each day.
 *
 * Inputs the forecast reads at run time: customers' promises to pay (whatsapp_chase_targets).
 *
 * Fails open: without the tables (2026-10-04-forecast-learning.sql not run) nothing is stored and the
 * forecast works exactly the same, minus its track record. CommonJS, zero-npm.
 */
const { selectRows, insertRows } = require('./supabaseRest');

const DAY = 86400000;
const istToday = (now) => new Date((now || Date.now()) + 5.5 * 3600000).toISOString().slice(0, 10);

/** Save today's forecast and position (once per account per day; a later run the same day replaces it). */
async function recordDaily(userId, fc, now) {
  if (!userId || !fc) return false;
  const run_date = istToday(now);
  const ok = await Promise.all([
    insertRows('forecast_runs', [{
      user_id: userId, run_date, opening: fc.opening,
      daily_close: fc.daily.close, daily_low: fc.daily.low, daily_high: fc.daily.high,
      weeks: fc.weeks, parts: fc.parts, drivers: fc.drivers, self_check: fc.self_check || null, updated_at: new Date(now || Date.now()).toISOString()
    }], { onConflict: 'user_id,run_date', merge: true }).then(() => true).catch(() => false),
    insertRows('daily_positions', [{
      user_id: userId, date: run_date, cash: fc.opening, receivables: fc.receivables_today, payables: fc.payables_today,
      recorded_at: new Date(now || Date.now()).toISOString()
    }], { onConflict: 'user_id,date', merge: true }).then(() => true).catch(() => false)
  ]);
  return ok.every(Boolean);
}

/** Past forecasts (last 70 days) for grading. [] without the table. */
async function pastRuns(userId, now) {
  const from = new Date((now || Date.now()) - 70 * DAY).toISOString().slice(0, 10);
  try { return await selectRows('forecast_runs', `select=run_date,daily_close&user_id=eq.${encodeURIComponent(userId)}&run_date=gte.${from}&order=run_date.asc&limit=80`); }
  catch (e) { return []; }
}

/** Open promises to pay from payment chases: [{ party, amount, date }]. */
async function promises(userId) {
  try {
    const rows = await selectRows('whatsapp_chase_targets', `select=party_name,amount,promise_to_pay_date,promise_to_pay_amount&user_id=eq.${encodeURIComponent(userId)}&state=eq.paused_promise&limit=200`);
    return rows.filter((r) => r.promise_to_pay_date).map((r) => ({ party: r.party_name, amount: Number(r.promise_to_pay_amount) || Number(r.amount) || 0, date: String(r.promise_to_pay_date).slice(0, 10) }));
  } catch (e) { return []; }
}

module.exports = { recordDaily, pastRuns, promises };
