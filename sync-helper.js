const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT) || parseInt(process.env.SYNC_PORT) || 3456;
const HOST = process.env.HOST || '0.0.0.0';
const SYNC_FILE = process.env.SYNC_FILE || path.join(__dirname, 'sync', 'appointments.json');
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readData() {
  try {
    if (fs.existsSync(SYNC_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SYNC_FILE, 'utf8'));
      raw.clients = raw.clients || [];
      raw.services = raw.services || [];
      raw.employees = raw.employees || [];
      raw.appointments = raw.appointments || [];
      return raw;
    }
  } catch (e) { /* fall through */ }
  return { appointments: [], clients: [], services: [], employees: [], lastModified: 0 };
}

function writeData(data) {
  ensureDir(SYNC_FILE);
  data.lastModified = Date.now();
  fs.writeFileSync(SYNC_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function mergeArray(local, remote) {
  const map = new Map();
  local.forEach(item => map.set(item.id, item));
  remote.forEach(item => {
    if (map.has(item.id)) {
      const existing = map.get(item.id);
      if ((item._modified || 0) > (existing._modified || 0)) map.set(item.id, item);
    } else {
      map.set(item.id, item);
    }
  });
  return Array.from(map.values());
}

function pathname(url) { return url.split('?')[0].split('#')[0] }

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const url = pathname(req.url);

  if (url === '/sync' || url === '/sync/') {
    if (req.method === 'GET') {
      const data = readData();
      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const remote = JSON.parse(body);
          const current = readData();
          const merged = { ...current };
          ['appointments', 'clients', 'services', 'employees', 'products', 'projects', 'movements', 'settings'].forEach(k => {
            if (remote[k]) merged[k] = mergeArray(current[k] || [], remote[k]);
          });
          writeData(merged);
          res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            appointments: merged.appointments.length,
            clients: merged.clients.length,
            services: merged.services.length,
            employees: merged.employees.length,
            lastModified: merged.lastModified
          }));
        } catch (e) {
          res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
  }

  if (url === '/health') {
    const data = readData();
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok', file: SYNC_FILE,
      appointments: (data.appointments || []).length,
      clients: (data.clients || []).length,
      services: (data.services || []).length,
      employees: (data.employees || []).length,
      lastModified: data.lastModified
    }));
    return;
  }

  res.writeHead(404, CORS_HEADERS); res.end('Not found');
});

server.listen(PORT, HOST, () => {
  const addr = typeof HOST === 'string' && HOST === '0.0.0.0'
    ? '0.0.0.0 (all interfaces)'
    : HOST;
  console.log(`Sync Helper running on http://${addr}:${PORT}`);
  console.log(`Sync file: ${SYNC_FILE}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`CORS enabled for all origins — suitable for cloud deployment`);
});
