// UI contract inventory: everything app.html's code depends on that a visual
// redesign must not silently break. Zero-npm.
//
// Usage:
//   node tools/ui-contract.js [file-or-dir ...]            -> prints JSON
//   node tools/ui-contract.js --md  [files...] > UI-CONTRACT-INVENTORY.md
//   node tools/ui-contract.js --diff baseline.json [files...]
//                                   -> exit 1 if anything in the baseline went missing
// Default input is app.html. After the Phase 1 split, pass app.html plus the
// app/ folder so the inventory spans every file: node tools/ui-contract.js app.html app
const fs = require('fs'), path = require('path');

const args = process.argv.slice(2);
const md = args[0] === '--md'; if (md) args.shift();
let diffBase = null; if (args[0] === '--diff') { args.shift(); diffBase = args.shift(); }
const inputs = args.length ? args : [path.join(__dirname, '..', 'app.html')];

const files = [];
(function walk(list) {
  for (const p of list) {
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(fs.readdirSync(p).map(f => path.join(p, f)));
    else if (/\.(html|js|css)$/.test(p)) files.push(p);
  }
})(inputs);
const src = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
// Script bodies only (inline <script> in html + whole .js files) for JS-level scans.
const js = files.map(f => {
  const s = fs.readFileSync(f, 'utf8');
  if (f.endsWith('.js')) return s;
  if (f.endsWith('.css')) return '';
  return [...s.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
}).join('\n');
const markup = files.filter(f => f.endsWith('.html')).map(f => fs.readFileSync(f, 'utf8').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')).join('\n');

const uniq = a => [...new Set(a)].sort();
const counts = a => a.reduce((o, k) => (o[k] = (o[k] || 0) + 1, o), {});
const all = (re, s, g = 1) => [...s.matchAll(re)].map(m => m[g]);

const inv = {
  // ids present in static markup
  ids_static: uniq(all(/\bid="([^"$'+{}]+)"/g, markup)),
  // ids looked up from code (a missing one = null deref at runtime)
  ids_referenced: uniq([
    ...all(/getElementById\(\s*'([^']+)'\s*\)/g, js),
    ...all(/getElementById\(\s*"([^"]+)"\s*\)/g, js),
    ...all(/querySelector(?:All)?\(\s*'#([A-Za-z][\w-]*)/g, js)
  ]),
  // ids built at runtime from a prefix, e.g. getElementById('view-' + v)
  id_prefixes_dynamic: uniq(all(/getElementById\(\s*'([^']+)'\s*\+/g, js)),
  data_view: uniq(all(/data-view="([^"]+)"/g, src)),
  show_view_names: uniq(all(/showView\(\s*'([^']+)'\s*\)/g, js)),
  data_attributes: counts(all(/\b(data-[a-z][\w-]*)=/g, src)),
  supabase_tables: counts(all(/\.from\(\s*'([^']+)'\s*\)/g, js)),
  api_endpoints: uniq(all(/['"`](\/api\/[\w\-/]+(?:\?action=[\w-]+)?)/g, js)),
  // Functions invoked from inline HTML handlers. These MUST stay on window
  // after moving code into <script type="module"> (module scope isn't global).
  inline_handler_calls: uniq(all(/\bon[a-z]+="\s*(?:return\s+)?([A-Za-z_$][\w$]*)\s*\(/g, src)),
  wa_identifiers: uniq(all(/\b(wa[A-Z]\w*)/g, js)),
  contract_literals: counts(all(/'(whatsapp_bell|agent_deployments|business_stakeholders|close_collections|chase_agent|opening_bell|closing_bell)'/g, js)),
  // config-object shapes read by the code
  deployment_config_keys: uniq(all(/\.config\??\.([a-z_]\w*)/g, js)),
  permission_keys: uniq([...all(/\.permissions\??\.([a-z_]\w*)/g, js), ...all(/\bperms?\??\.([a-z_]\w*)/g, js)]),
  local_storage_keys: uniq([...all(/ls(?:Set|Get)\(\s*'([^']+)'/g, js), ...all(/localStorage\.(?:get|set|remove)Item\(\s*'([^']+)'/g, js)]),
  hash_usage: uniq(all(/(location\.hash[^;\n]{0,60})/g, js)),
  top_level_globals: uniq(all(/^(?:let|var|const)\s+([A-Za-z_$][\w$]*)/gm, js)),
  top_level_functions: uniq(all(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm, js)),
  native_confirm_calls: all(/(?:[^.\w]|window\.)confirm\(\s*(['"][^'"]{0,70})/g, js),
  cdn_scripts: uniq(all(/<script[^>]+src="([^"]+)"/g, src))
};
inv._summary = Object.fromEntries(Object.entries(inv).map(([k, v]) => [k, Array.isArray(v) ? v.length : Object.keys(v).length]));
inv._files = files.map(f => path.relative(path.join(__dirname, '..'), f));

if (diffBase) {
  const base = JSON.parse(fs.readFileSync(diffBase, 'utf8'));
  // Only additive-safe checks: anything the baseline had must still exist.
  const keys = ['ids_static', 'ids_referenced', 'id_prefixes_dynamic', 'data_view', 'show_view_names', 'supabase_tables', 'api_endpoints',
    'inline_handler_calls', 'wa_identifiers', 'contract_literals', 'deployment_config_keys', 'permission_keys', 'local_storage_keys', 'top_level_functions'];
  let bad = 0;
  for (const k of keys) {
    const was = Array.isArray(base[k]) ? base[k] : Object.keys(base[k] || {});
    const now = new Set(Array.isArray(inv[k]) ? inv[k] : Object.keys(inv[k] || {}));
    const gone = was.filter(x => !now.has(x));
    if (gone.length) { bad++; console.log(`MISSING ${k}: ${gone.join(', ')}`); }
  }
  // .from() call counts must not drop (a dropped call = lost read/write).
  for (const [t, n] of Object.entries(base.supabase_tables || {})) {
    if ((inv.supabase_tables[t] || 0) < n) { bad++; console.log(`FEWER .from('${t}') calls: ${n} -> ${inv.supabase_tables[t] || 0}`); }
  }
  console.log(bad ? `${bad} contract check(s) failed` : 'contract intact');
  process.exit(bad ? 1 : 0);
}

if (!md) { console.log(JSON.stringify(inv, null, 2)); process.exit(0); }

const list = a => a.length ? a.map(x => '`' + x + '`').join(', ') : '_none_';
const table = o => '| Key | Count |\n|---|---|\n' + Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| \`${k}\` | ${v} |`).join('\n');
const missingStatic = inv.ids_referenced.filter(id => !inv.ids_static.includes(id));
console.log(`# UI contract inventory

Generated by \`node tools/ui-contract.js --md\` from ${inv._files.map(f => '`' + f + '`').join(', ')} on ${new Date().toISOString().slice(0, 10)}.
The machine-readable baseline is \`UI-CONTRACT-BASELINE.json\`. **Before any redesign PR, run**

\`\`\`
node tools/ui-contract.js --diff UI-CONTRACT-BASELINE.json app.html app
\`\`\`

and it must print \`contract intact\`. That check fails if anything below disappears: an id the code looks up,
a \`data-view\`, a \`.from()\` table (or fewer calls to it), an API route, an inline-handler function, a \`wa*\` helper,
a config or permission key, a storage key, or a top-level function. Additions are fine.

## Counts
${table(inv._summary)}

## Rules this protects (for Phase 1)
1. **Shared globals across files.** \`<script type="module">\` is module-scoped, but today every script
   shares one global scope. As of this baseline there are **no inline \`on*=\` handlers** (everything uses
   \`addEventListener\`), so the split risk is cross-file reads/writes of the *top-level globals* and
   *top-level functions* below (\`snapshots\`, \`currentUser\`, \`showView\`, …). \`tools/ui-seed.js\` also
   assigns many of them from outside. Either load the split files as classic \`<script defer>\` in the
   original order (keeps one global scope, zero behaviour change), or export them onto \`window\` explicitly.
2. **Views are keyed by name.** \`showView(name)\` toggles \`#view-<name>\` and \`.pagenav button[data-view]\`.
   The hash router must map onto these exact names. \`ledger\` is an alias that opens \`books\` with the Manual source.
3. **Zoho org-select callback.** Hash usage below includes \`zoho=select-org\`; the router must leave it alone.
4. **No logic change in a visual PR.** \`.from()\` counts and API routes must be identical before and after.

## Views
- \`data-view\` values: ${list(inv.data_view)}
- \`showView('…')\` literal calls: ${list(inv.show_view_names)}

## Supabase tables (\`.from()\` call counts)
${table(inv.supabase_tables)}

## API routes called
${list(inv.api_endpoints)}

## Inline handler calls (must stay global)
${list(inv.inline_handler_calls)}

## WhatsApp / people / agents contract
- \`wa*\` helpers: ${list(inv.wa_identifiers)}
- String literals: ${Object.entries(inv.contract_literals).map(([k, v]) => '`' + k + '` ×' + v).join(', ')}
- \`agent_deployments.config\` keys read: ${list(inv.deployment_config_keys)}
- \`business_stakeholders.permissions\` keys read: ${list(inv.permission_keys)}
  (full shape: \`{ ask, act, forward, opening_bell, closing_bell }\`; primary number's Bells come from \`agent_deployments.config.frequency\`: \`morning | evening | both | none\`)

## Browser state
- Storage keys: ${list(inv.local_storage_keys)}
- Hash usage: ${inv.hash_usage.map(h => '`' + h.trim() + '`').join('<br>') || '_none_'}

## Native \`confirm()\` calls to replace with dialogs (Phase 1)
${inv.native_confirm_calls.map((c, i) => `${i + 1}. ${c.replace(/^['"]/, '')}…`).join('\n')}

## External scripts
${list(inv.cdn_scripts)}

## Element ids
- Looked up from code but **not in static markup** (rendered at runtime; must still exist when their code runs):
  ${list(missingStatic)}
- Dynamic id prefixes: ${list(inv.id_prefixes_dynamic)}
- All ids looked up from code (${inv.ids_referenced.length}): ${list(inv.ids_referenced)}
- All ids in static markup (${inv.ids_static.length}): ${list(inv.ids_static)}

## Top-level globals (${inv.top_level_globals.length})
${list(inv.top_level_globals)}

## Top-level functions (${inv.top_level_functions.length})
${list(inv.top_level_functions)}
`);
