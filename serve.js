/**
 * Serveur statique minimal — zero dependance, juste Node.
 *
 *   node serve.js            ->  http://localhost:8000
 *   node serve.js 3000       ->  autre port
 *
 * Il sert la racine du projet. Tout le site vit sous `frontend/` :
 *   frontend/solarnav/index.html      le tableau de bord (page d'accueil)
 *   frontend/digital_twin/index.html  la simulation 3D de l'equipe
 *   frontend/index.html               le tableau de bord de l'equipe (demande son backend)
 *
 * Les modules ES exigent http:// : ouvrir les pages en file:// ne marche pas
 * pour le tableau de bord (la simulation 3D, elle, le supporte).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname);
const PORT = Number(process.argv[2]) || 8000;
const HOME = '/frontend/solarnav/index.html';      // page d'accueil

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
  '.py': 'text/plain; charset=utf-8'
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  // Une vraie redirection, pas un service silencieux : sinon le navigateur
  // resterait sur « / » et resoudrait les chemins relatifs de la page
  // (assets/js/app.js…) depuis la racine, ou ils n'existent pas.
  if (url === '/' || url === '/index.html') {
    res.writeHead(302, { Location: HOME });
    res.end();
    return;
  }

  const file = path.resolve(path.join(ROOT, url));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('403');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`404 — ${url} introuvable`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Le port ${PORT} est deja occupe.`);
    console.error(`  Essayez :  node serve.js ${PORT + 1}\n`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, () => {
  const base = `http://localhost:${PORT}`;
  console.log(`\n  SolarNav  ->  ${base}\n`);
  console.log(`  Tableau de bord : ${base}/`);
  console.log(`  Journal         : ${base}/frontend/solarnav/journal.html`);
  console.log(`  Simulation 3D   : ${base}/frontend/digital_twin/index.html\n`);
  console.log(`  Jeux d'exemple  : cd frontend/solarnav && cp data/telemetry.example.json data/telemetry.json\n`);
  console.log('  Ctrl+C pour arreter.\n');
});
