// Tiny static server for previewing app.html locally (no npm).
// Usage: node tools/serve-static.js [rootDir] [port]
// Defaults: this repo folder, port 5188. Open http://localhost:5188/app.html
// Auth won't work on localhost; seed state with tools/ui-shots.js instead.
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const port = Number(process.argv[3] || 5188);
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.svg':'image/svg+xml', '.json':'application/json', '.woff2':'font/woff2' };
http.createServer((req, res) => {
  let f = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (f.endsWith('/')) f += 'app.html';
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    res.end(d);
  });
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
