// Lists every selector in app/css (except polish.css) whose rule hard-codes
// 'IBM Plex Mono', so polish.css can move figures to the main typeface with
// one generated rule. Usage: node tools/redesign-mock/gen-font-override.js
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..', '..', 'app', 'css');
const KEEP_MONO = /kbd|\.code|pre\b|\.mono-keep/;           // real code stays typewriter-style
const sels = new Set();
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.css') && f !== 'polish.css')) {
  const css = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g; let m;
  while ((m = re.exec(css))) {
    if (!/IBM Plex Mono/.test(m[2])) continue;
    m[1].split(',').map(s => s.trim().replace(/\s+/g, ' ')).filter(s => s && s !== ':root' && !s.startsWith('@') && !/^(from|to|\d+%)$/.test(s) && !KEEP_MONO.test(s)).forEach(s => sels.add(s));
  }
}
console.log([...sels].join(',\n'));
console.error(sels.size + ' selectors');
