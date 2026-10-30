// Servidor local para testar o site com os MESMOS cabeçalhos (CSP etc.) de web/_headers.
// Uso: npm run dev   (porta 8080; mude com PORT=3000)   |   ROOT=outra-pasta para servir outro diretório.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.env.ROOT || path.join(here, '..', 'web'));
const port = Number(process.env.PORT || 8080);

const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};

function parseHeaders(file) {
    const rules = []; let cur = null;
    if (!fs.existsSync(file)) return rules;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim() || line.startsWith('#')) continue;
        if (!line.startsWith(' ')) { cur = { pattern: line.trim(), headers: {} }; rules.push(cur); continue; }
        const i = line.indexOf(':');
        cur.headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return rules;
}
const rules = parseHeaders(path.join(root, '_headers'));
const matches = (pattern, url) => (pattern === '/*' ? true : pattern === url);

const server = http.createServer((req, res) => {
    let url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (url.endsWith('/')) url += 'index.html';
    const file = path.normalize(path.join(root, url));
    if (!file.startsWith(root + path.sep) || path.basename(file) === '_headers') { res.writeHead(404).end('Not found'); return; }
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
        const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' };
        for (const r of rules) if (matches(r.pattern, url)) Object.assign(headers, r.headers);
        res.writeHead(200, headers).end(data);
    });
});
server.listen(port, () => console.log(`Revenda+ em http://localhost:${port}  (pasta: ${root})`));
export { server };
