/* ============================================================
   REPORTS MODEL (2026-10-04): the figures behind every Reports chart.

   Before: charts were drawn from Margyn's saved readings, and money that
   flows (revenue, spend, profit) was SUMMED across readings in a period, so a
   week with five readings of "₹2.6 Cr a month" showed ₹13 Cr; cash was plotted
   as ₹0 when the months came from Tally.

   Now, per period:
   - revenue, spend, net profit: each month's own figures from the books
     (Tally P&L by month), added up for a quarter. The books give months, so a
     weekly chart of these is drawn by month and says so.
   - net margin: profit / revenue of that period; none for a month still in
     progress or with running costs not booked yet.
   - cash: the books' cash at the end of the period (cash_history), else the
     last reading in the period.
   - Pulse Score, GST leakage: the last reading in the period (Margyn's own
     measures, not in the books); a period with no reading has none.
   Without books, flows come from the last reading in the period (a monthly
   figure), never a sum of readings.

   Pure: no DOM, no globals. Used by 12-analytics-settings.js; tested by
   api/_lib/__tests__/reports.test.js.
   ============================================================ */
(function(root){
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const FLOW = { revenue:1, spend:1, netprofit:1, margin:1 };
  const DAY = 86400000;
  const istKey = (iso) => { const t = Date.parse(iso); return isNaN(t) ? '' : new Date(t + 5.5 * 3600000).toISOString().slice(0, 10); };
  const addDays = (k, n) => new Date(Date.parse(k + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
  const monthEnd = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };

  function periodOf(dateKey, group){
    const [y, m] = dateKey.split('-').map(Number);
    if(group === 'Quarter'){
      const q = Math.floor((m - 1) / 3);
      const start = y + '-' + String(q * 3 + 1).padStart(2, '0') + '-01';
      return { key:y + '-Q' + (q + 1), label:'Q' + (q + 1) + " '" + String(y).slice(2), start, end:monthEnd(y + '-' + String(q * 3 + 3).padStart(2, '0')) };
    }
    if(group === 'Week'){
      const dow = (new Date(dateKey + 'T00:00:00Z').getUTCDay() + 6) % 7;   // Monday = 0
      const start = addDays(dateKey, -dow), end = addDays(start, 6);
      const [, sm, sd] = start.split('-').map(Number);
      return { key:'W' + start, label:sd + ' ' + MON[sm - 1], start, end };
    }
    const mk = dateKey.slice(0, 7);
    return { key:mk, label:MON[m - 1] + " '" + String(y).slice(2), start:mk + '-01', end:monthEnd(mk) };
  }

  /**
   * @param {object} o
   * @param {object[]} o.pnl        books P&L by month: { month, net_sales, cogs_pre_stock, opex, net_profit_pre_stock, provisional, costs_incomplete, partial_start }
   * @param {object[]} o.cashPoints books cash, end of each day: { date:'YYYY-MM-DD', cash }
   * @param {object[]} o.readings   saved readings (any order): { created_at, revenue, burn, net_profit, cash, pulse_score, gst_leak }
   * @param {string[]} o.metrics    revenue | spend | netprofit | margin | cash | pulse | gstleak
   * @param {string}   o.group      Week | Month | Quarter | Snapshot
   * @param {number}   o.rangeDays  how far back (period end within range)
   * @param {number}   [o.now]
   * @returns {{ group, note, periods:[{ key, label, start, end, in_progress, costs_incomplete, values:{} }] }}
   */
  function build(o){
    const now = o.now || Date.now();
    const today = istKey(new Date(now).toISOString());
    const metrics = (o.metrics || []).slice();
    const pnl = (o.pnl || []).filter(r => r && r.month && !r.partial_start);
    const books = pnl.length > 0;
    const pts = (o.cashPoints || []).filter(p => p && p.date).slice().sort((a, b) => a.date < b.date ? -1 : 1);
    const reads = (o.readings || []).filter(r => r && r.created_at).map(r => Object.assign({ _d:istKey(r.created_at) }, r)).sort((a, b) => a._d < b._d ? -1 : a._d > b._d ? 1 : Date.parse(a.created_at) - Date.parse(b.created_at));
    let group = o.group === 'Snapshot' || !o.group ? 'Month' : o.group;
    let note = '';
    const wantsFlow = metrics.some(m => FLOW[m]);
    if(books && wantsFlow && group === 'Week'){ group = 'Month'; note = 'Revenue, spend and profit come by month from your books, so this chart is by month.'; }

    // Which periods exist: every books month, every day with book cash, every reading.
    const map = new Map();
    const touch = (dateKey) => { const p = periodOf(dateKey, group); if(!map.has(p.key)) map.set(p.key, Object.assign(p, { months:[], reads:[] })); return map.get(p.key); };
    if(books && (wantsFlow || (metrics.includes('cash') && !pts.length))) pnl.forEach(r => touch(r.month + '-01').months.push(r));
    if(metrics.includes('cash') && pts.length && (!books || !wantsFlow)) pts.forEach(p => touch(p.date));
    if(!books || metrics.some(m => !FLOW[m])) reads.forEach(r => touch(r._d).reads.push(r));
    if(books && wantsFlow) reads.forEach(r => { const p = periodOf(r._d, group); if(map.has(p.key)) map.get(p.key).reads.push(r); });

    const cut = istKey(new Date(now - (o.rangeDays || 93) * DAY).toISOString());
    const cashAt = (end) => { const e = end < today ? end : today; let v = null; for(const p of pts){ if(p.date > e) break; v = Number(p.cash); } return v; };
    const periods = [...map.values()].filter(p => p.end >= cut && p.start <= today).sort((a, b) => a.start < b.start ? -1 : 1).map(p => {
      const last = p.reads[p.reads.length - 1] || null;
      const inProgress = p.end >= today || p.months.some(m => m.provisional);
      const costsIncomplete = p.months.some(m => m.costs_incomplete);
      const v = {};
      if(books){
        const sum = (f) => p.months.length ? p.months.reduce((t, m) => t + (Number(f(m)) || 0), 0) : null;
        v.revenue = sum(m => m.net_sales);
        v.spend = sum(m => (Number(m.cogs_pre_stock) || 0) + (Number(m.opex) || 0));
        v.netprofit = sum(m => m.net_profit_pre_stock);
      } else if(last){
        v.revenue = last.revenue == null ? null : Number(last.revenue);
        v.spend = last.burn == null ? null : Number(last.burn);
        v.netprofit = last.net_profit == null ? null : Number(last.net_profit);
      } else { v.revenue = v.spend = v.netprofit = null; }
      v.margin = v.revenue && v.netprofit != null && !inProgress && !costsIncomplete ? v.netprofit / v.revenue * 100 : null;
      const bc = pts.length ? cashAt(p.end) : null;
      v.cash = bc != null ? bc : (last && last.cash != null ? Number(last.cash) : null);
      v.pulse = last && last.pulse_score != null ? Number(last.pulse_score) : null;
      v.gstleak = last && last.gst_leak != null ? Number(last.gst_leak) : null;
      return { key:p.key, label:p.label, start:p.start, end:p.end, in_progress:inProgress, costs_incomplete:costsIncomplete, values:v };
    });
    if(!books && wantsFlow) note = 'Monthly figures from Margyn’s last reading in each period.';
    return { group, note, periods };
  }

  /** Change between the last two whole periods (an unfinished one isn't comparable). */
  function lastChange(periods, metric){
    const whole = periods.filter(p => !(FLOW[metric] && (p.in_progress || p.costs_incomplete)) && p.values[metric] != null);
    if(whole.length < 2) return null;
    const a = whole[whole.length - 1].values[metric], b = whole[whole.length - 2].values[metric];
    if(!b) return null;
    const pct = (a - b) / Math.abs(b) * 100;
    return isFinite(pct) && Math.abs(pct) <= 999 ? { pct, from:whole[whole.length - 2].label, to:whole[whole.length - 1].label } : null;
  }

  const api = { build, lastChange, periodOf, FLOW };
  if(typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MG_REPORTS = api;
})(this);
