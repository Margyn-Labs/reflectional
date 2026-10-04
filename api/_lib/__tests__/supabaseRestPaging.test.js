/**
 * selectRows past PostgREST's 1,000-row ceiling (2026-10-04): limit=N above 1,000 and no-limit reads used to
 * come back with the first 1,000 rows only.
 * Zero-dep. Run: node api/_lib/__tests__/supabaseRestPaging.test.js
 * Fake: a PostgREST that, like the real one on this project, never returns more than 1,000 rows a request.
 */
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.SUPABASE_ANON_KEY = 'anon';

let pass = 0, fail = 0;
const check = (n, c, d) => { c ? (pass++, console.log('  ok  - ' + n)) : (fail++, console.log('  FAIL- ' + n + (d !== undefined ? ' :: ' + JSON.stringify(d).slice(0, 300) : ''))); };

const TABLES = {
  big: Array.from({ length: 4321 }, (_, i) => ({ id: i + 1, v: i })),
  small: Array.from({ length: 12 }, (_, i) => ({ id: i + 1 })),
  noid: Array.from({ length: 1500 }, (_, i) => ({ k: i }))
};
const calls = [];
global.fetch = async (url) => {
  const u = new URL(url);
  const table = u.pathname.split('/').pop();
  const p = u.searchParams;
  calls.push(table + '?' + p.toString());
  let rows = TABLES[table].slice();
  const order = p.get('order');
  if (order && order.startsWith('id') && !('id' in rows[0])) {
    return { ok: false, status: 400, text: async () => `{"code":"42703","message":"column ${table}.id does not exist"}` };
  }
  const off = +(p.get('offset') || 0), lim = Math.min(1000, p.get('limit') ? +p.get('limit') : 1000);
  rows = rows.slice(off, off + lim);
  return { ok: true, status: 200, json: async () => rows, text: async () => '' };
};

const { selectRows, selectAllRows } = require('../supabaseRest');

(async () => {
  calls.length = 0;
  let r = await selectRows('big', 'select=*&order=id.asc&limit=5000');
  check('limit=5000 on 4,321 rows returns all 4,321 (was 1,000)', r.length === 4321 && r[4320].id === 4321, r.length);
  check('...in 5 pages of at most 1,000', calls.length === 5 && calls.every((c) => /limit=1000|limit=\d{1,3}&/.test(c)), calls);

  r = await selectRows('big', 'select=*&order=id.asc&limit=2500');
  check('limit=2500 returns exactly 2,500', r.length === 2500 && r[2499].id === 2500, r.length);

  calls.length = 0;
  r = await selectRows('big', 'select=*&user_id=eq.x');
  check('no limit returns every row, ordered by id for stable pages', r.length === 4321 && calls[0].includes('order=id.asc'), [r.length, calls[0]]);

  calls.length = 0;
  r = await selectRows('small', 'select=*&limit=500');
  check('limit at or under 1,000 is one request, unchanged', r.length === 12 && calls.length === 1 && !calls[0].includes('offset'), calls);

  calls.length = 0;
  r = await selectRows('small', 'select=*');
  check('a small unbounded read is still one request', r.length === 12 && calls.length === 1, calls);

  calls.length = 0;
  r = await selectRows('big', 'select=*&order=id.asc&limit=1000&offset=2000');
  check('a caller-paged read (offset=) is left alone', r.length === 1000 && r[0].id === 2001 && calls.length === 1, calls);

  r = await selectRows('noid', 'select=*&limit=3000');
  check('a table without an id still pages past 1,000', r.length === 1500, r.length);

  const all = await selectAllRows('big', 'select=*&order=id.asc', { max: 3000 });
  check('selectAllRows unchanged: truncated past max', all.rows.length === 3000 && all.truncated === true, [all.rows.length, all.truncated]);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
