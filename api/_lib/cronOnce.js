/**
 * _lib/cronOnce.js
 * "Has this job already run for this slot today (India date)?" so a job can be triggered from two clocks.
 *
 * Why (2026-10-04): Vercel Hobby runs a cron at some minute inside its hour, so the 07:30 update went out at
 * 08:11, the 10:30 one at 11:09 and the 19:00 one at 19:19. Supabase pg_cron (2026-10-04-on-time-crons.sql)
 * now calls the same URLs on the minute; the Vercel cron stays as the backup. Whichever arrives first claims
 * the slot in cron_runs (unique job + day); the other does nothing.
 *
 * Fails open: if the cron_runs table isn't there yet (SQL not run), every call runs, exactly as before.
 * CommonJS, zero-npm.
 */
const { insertRows } = require('./supabaseRest');

function istDay(now) {
  const d = new Date((now ? new Date(now).getTime() : Date.now()) + 5.5 * 3600000);
  return d.toISOString().slice(0, 10);
}

/** true = go ahead (first caller today, or no table); false = already ran today. */
async function claim(job, now) {
  try {
    const rows = await insertRows('cron_runs', [{ job, day: istDay(now), at: new Date().toISOString() }], { onConflict: 'job,day' });
    return Array.isArray(rows) ? rows.length > 0 : true;
  } catch (e) {
    return true;
  }
}

module.exports = { claim, istDay };
