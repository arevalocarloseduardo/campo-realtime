// Server minimalista para Campo Realtime.
//
// 1) Sirve estaticos de /public.
// 2) POST /api/realtime/token → llama a OpenAI con tu API key (env) y devuelve
//    un client_secret (ephemeral key ek_...) para que el browser conecte WebRTC.
// 3) /api/campo/* → proxy a https://campo.itereox.com/api/* (evita CORS y
//    mantiene la key OpenAI lejos del cliente).
//
// Correr:  OPENAI_API_KEY=sk-... node server.mjs
// Por env opcional: PORT, REALTIME_MODEL, CAMPO_BASE, REALTIME_VOICE

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8787);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.REALTIME_MODEL || 'gpt-realtime-2';
const REALTIME_VOICE = process.env.REALTIME_VOICE || 'cedar';
const VOICE_WHITELIST = new Set(['cedar', 'marin', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse']);
const CAMPO_BASE = (process.env.CAMPO_BASE || 'https://campo.itereox.com/api').replace(/\/$/, '');

if (!OPENAI_API_KEY) {
  console.error('FALTA OPENAI_API_KEY en env. Ejemplo: OPENAI_API_KEY=sk-... node server.mjs');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function handleRealtimeToken(req, res) {
  // Voice override via query (?voice=cedar). Validamos contra whitelist
  // para no reenviar basura a OpenAI.
  let voice = REALTIME_VOICE;
  const qIdx = req.url.indexOf('?');
  if (qIdx >= 0) {
    const params = new URLSearchParams(req.url.slice(qIdx + 1));
    const v = params.get('voice');
    if (v && VOICE_WHITELIST.has(v)) voice = v;
  }

  const r = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      session: {
        type: 'realtime',
        model: REALTIME_MODEL,
        audio: {
          output: { voice },
          input: { transcription: { model: 'whisper-1' } },
        },
      },
    }),
  });
  const text = await r.text();
  res.writeHead(r.status, { 'content-type': 'application/json' });
  res.end(text);
}

async function handleCampoProxy(req, res, suffix) {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const url = CAMPO_BASE + suffix + qs;
  const isBodyMethod = req.method !== 'GET' && req.method !== 'HEAD';
  const body = isBodyMethod ? await readBody(req) : undefined;

  const fwdHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (['host', 'content-length', 'connection', 'origin', 'referer'].includes(k.toLowerCase())) continue;
    fwdHeaders[k] = Array.isArray(v) ? v.join(',') : v;
  }

  const r = await fetch(url, {
    method: req.method,
    headers: fwdHeaders,
    body: body && body.length ? body : undefined,
  });
  const buf = Buffer.from(await r.arrayBuffer());
  const respHeaders = {};
  for (const [k, v] of r.headers.entries()) {
    if (['content-encoding', 'transfer-encoding', 'content-length'].includes(k.toLowerCase())) continue;
    respHeaders[k] = v;
  }
  respHeaders['content-length'] = String(buf.length);
  res.writeHead(r.status, respHeaders);
  res.end(buf);
}

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    if (url === '/api/realtime/token' && req.method === 'POST') return handleRealtimeToken(req, res);
    if (url === '/api/realtime/config' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: REALTIME_MODEL, voice: REALTIME_VOICE }));
      return;
    }
    if (url.startsWith('/api/campo/')) {
      const suffix = url.slice('/api/campo'.length); // queda con /
      return handleCampoProxy(req, res, suffix);
    }
    serveStatic(req, res);
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e?.message || 'server error' }));
  }
});

server.listen(PORT, () => {
  console.log(`→ http://localhost:${PORT}  (modelo: ${REALTIME_MODEL}, voz: ${REALTIME_VOICE})`);
});
