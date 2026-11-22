/**
 * Lower Thirds ENT — servidor local (Express + WebSocket)
 *
 * - Serve o Overlay (Browser Source 1920x1080) e o Dock (Custom Browser Dock) do OBS.
 * - API HTTP para operação e integração com Macro Deck.
 * - WebSocket (/ws) para sincronizar Overlay e Dock em tempo real.
 * - Persistência em presets.json e fotos em /uploads.
 */
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { promises as fs, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ */
/* Configuração                                                        */
/* ------------------------------------------------------------------ */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = Object.freeze({
  port: Number(process.env.PORT) || 3000,
  // Por padrão escuta só na máquina local. Use `npm run start:lan` (ou HOST=0.0.0.0)
  // para abrir o Dock a partir de outro computador/tablet da rede.
  host: process.env.HOST || (process.argv.includes('--lan') ? '0.0.0.0' : '127.0.0.1'),
  publicDir: path.join(__dirname, 'public'),
  uploadsDir: path.join(__dirname, 'uploads'),
  presetsFile: path.join(__dirname, 'presets.json'),
  maxUploadBytes: 8 * 1024 * 1024, // 8 MB por imagem (após decodificar o Base64)
  maxAutoHide: 3600,               // segundos
  heartbeatMs: 30_000,
});

const TEMPLATES = Object.freeze([
  'modern', 'clean', 'news', 'cyber',
  'podcast', 'sports', 'minimal', 'split', 'elegant', 'soft', 'breaking', 'gradient',
  'frosted', 'classic', 'outline', 'inline', 'verse', 'ribbon', 'spotlight', 'stack', 'subscribe', 'worship',
]);

// Posição (canto inferior esquerdo do card, em px da tela 1920x1080) e escala.
const GEO_DEFAULT = Object.freeze({ x: 110, y: 120, scale: 1 });

const IMAGE_TYPES = Object.freeze({
  'image/png': { ext: 'png', magic: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
  'image/jpeg': { ext: 'jpg', magic: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/jpg': { ext: 'jpg', magic: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/gif': { ext: 'gif', magic: (b) => b.length > 6 && b.toString('ascii', 0, 3) === 'GIF' },
  'image/webp': {
    ext: 'webp',
    magic: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  },
});

const DEFAULT_PRESETS = [
  { name: 'Carlos Andrade', role: 'Diretor de Tecnologia', photo: '', template: 'modern', autoHide: 8 },
  { name: 'Mariana Souza', role: 'Apresentadora', photo: '', template: 'news', autoHide: 0 },
];

/* ------------------------------------------------------------------ */
/* Utilidades / Validação                                              */
/* ------------------------------------------------------------------ */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function cleanString(value, maxLength) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
}

function cleanPhoto(value) {
  const photo = cleanString(value, 500);
  if (!photo) return '';
  if (/^\/uploads\/[\w.-]+$/.test(photo)) return photo; // arquivo enviado via /api/upload
  if (/^https?:\/\/[^\s"'<>]+$/i.test(photo)) return photo; // URL externa
  return '';
}

function cleanAutoHide(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.round(n * 10) / 10, CONFIG.maxAutoHide);
}

function cleanNumber(value, min, max, fallback) {
  const n = Number(value);
  if (value === '' || value === null || value === undefined || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Normaliza qualquer entrada em um registro de Lower Third válido. */
function toEntry(input = {}) {
  return {
    name: cleanString(input.name, 220), // versículos podem ser longos
    role: cleanString(input.role, 120),
    photo: cleanPhoto(input.photo),
    template: TEMPLATES.includes(input.template) ? input.template : 'modern',
    autoHide: cleanAutoHide(input.autoHide),
    x: Math.round(cleanNumber(input.x, -400, 1900, GEO_DEFAULT.x)),
    y: Math.round(cleanNumber(input.y, -200, 1060, GEO_DEFAULT.y)),
    scale: Math.round(cleanNumber(input.scale, 0.3, 3, GEO_DEFAULT.scale) * 100) / 100,
  };
}

function toPreset(input = {}) {
  const entry = toEntry(input);
  const id = typeof input.id === 'string' && /^[\w-]{6,64}$/.test(input.id) ? input.id : crypto.randomUUID();
  return { id, ...entry };
}

const ENTRY_FIELDS = ['name', 'role', 'photo', 'template', 'autoHide', 'x', 'y', 'scale'];

/** Junta query string + corpo (JSON ou form) — facilita o uso no Macro Deck. */
function readInput(req) {
  const body = isPlainObject(req.body) ? req.body : {};
  return { ...req.query, ...body };
}

const hasEntryFields = (input) => ENTRY_FIELDS.some((k) => input[k] !== undefined);

/* ------------------------------------------------------------------ */
/* Persistência de presets                                             */
/* ------------------------------------------------------------------ */
let presets = [];
let saveChain = Promise.resolve();

async function loadPresets() {
  try {
    const raw = await fs.readFile(CONFIG.presetsFile, 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.presets) ? parsed.presets : [];
    presets = list.filter(isPlainObject).map(toPreset).filter((p) => p.name);
    console.log(`[presets] ${presets.length} preset(s) carregado(s).`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('[presets] presets.json não encontrado — criando com exemplos.');
    } else {
      const backup = CONFIG.presetsFile.replace(/\.json$/, `.corrupt-${Date.now()}.json`);
      await fs.copyFile(CONFIG.presetsFile, backup).catch(() => {});
      console.error(`[presets] presets.json inválido (${err.message}). Backup salvo em ${path.basename(backup)}.`);
    }
    presets = DEFAULT_PRESETS.map(toPreset);
    await savePresets();
  }
}

/** Escrita atômica (tmp + rename) serializada em fila para evitar corrupção. */
function savePresets() {
  const snapshot = JSON.stringify(presets, null, 2);
  saveChain = saveChain
    .then(async () => {
      const tmp = `${CONFIG.presetsFile}.tmp`;
      await fs.writeFile(tmp, snapshot, 'utf8');
      try {
        await fs.rename(tmp, CONFIG.presetsFile);
      } catch {
        // Windows pode bloquear o rename (antivírus/indexador). Fallback direto.
        await fs.writeFile(CONFIG.presetsFile, snapshot, 'utf8');
        await fs.unlink(tmp).catch(() => {});
      }
    })
    .catch((err) => console.error('[presets] Falha ao salvar:', err.message));
  return saveChain;
}

/* ------------------------------------------------------------------ */
/* Estado do ar                                                        */
/* ------------------------------------------------------------------ */
const state = {
  visible: false,
  data: toEntry({ name: 'Nome do Participante', role: 'Função / Cargo' }),
  takeId: Date.now(), // único entre reinícios do servidor
  hideAt: null,
};
let hideTimer = null;

const publicState = () => ({ ...state, data: { ...state.data }, now: Date.now() });

function take(entry) {
  if (!entry.name) throw new HttpError(400, 'O campo "name" é obrigatório.');
  clearTimeout(hideTimer);
  hideTimer = null;

  state.data = entry;
  state.visible = true;
  state.takeId += 1;
  state.hideAt = entry.autoHide > 0 ? Date.now() + entry.autoHide * 1000 : null;

  if (state.hideAt) hideTimer = setTimeout(() => hide('auto-hide'), entry.autoHide * 1000);

  console.log(`[on air] TAKE  "${entry.name}" (${entry.template}${entry.autoHide ? `, ${entry.autoHide}s` : ''})`);
  broadcastState();
}

function hide(reason = 'manual') {
  clearTimeout(hideTimer);
  hideTimer = null;
  if (state.visible) console.log(`[on air] HIDE  (${reason})`);
  state.visible = false;
  state.hideAt = null;
  broadcastState();
}

/* ------------------------------------------------------------------ */
/* Upload de imagens (Base64)                                          */
/* ------------------------------------------------------------------ */
async function saveBase64Image(input) {
  const raw = cleanString(input.image ?? input.data ?? input.base64 ?? '', 20 * 1024 * 1024);
  if (!raw) throw new HttpError(400, 'Envie a imagem em Base64 no campo "image".');

  let mime = cleanString(input.mime ?? input.type ?? '', 40).toLowerCase();
  let base64 = raw;
  const match = raw.match(/^data:([\w/+.-]+);base64,(.*)$/s);
  if (match) {
    mime = match[1].toLowerCase();
    base64 = match[2];
  }

  const type = IMAGE_TYPES[mime];
  if (!type) throw new HttpError(415, 'Formato não suportado. Use PNG, JPG, WEBP ou GIF.');

  const buffer = Buffer.from(base64.replace(/\s+/g, ''), 'base64');
  if (!buffer.length) throw new HttpError(400, 'Base64 inválido.');
  if (buffer.length > CONFIG.maxUploadBytes) {
    throw new HttpError(413, `Imagem muito grande (máx. ${CONFIG.maxUploadBytes / 1024 / 1024} MB).`);
  }
  if (!type.magic(buffer)) throw new HttpError(415, 'O conteúdo não corresponde ao tipo de imagem informado.');

  // photo_<timestamp>.<ext> — com sufixo em caso de colisão no mesmo milissegundo
  const stamp = Date.now();
  for (let i = 0; i < 100; i += 1) {
    const filename = `photo_${stamp}${i ? `_${i}` : ''}.${type.ext}`;
    try {
      await fs.writeFile(path.join(CONFIG.uploadsDir, filename), buffer, { flag: 'wx' });
      return { path: `/uploads/${filename}`, filename, bytes: buffer.length };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new HttpError(500, 'Não foi possível gerar um nome único para a imagem.');
}

/* ------------------------------------------------------------------ */
/* Express                                                             */
/* ------------------------------------------------------------------ */
const app = express();
app.disable('x-powered-by');

// Bloqueia requisições cross-site vindas de páginas da web abertas no navegador
// (Macro Deck, OBS e o próprio Dock não enviam Origin diferente do host).
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    try {
      if (new URL(origin).host !== req.headers.host) {
        return res.status(403).json({ ok: false, error: 'Origem não permitida.' });
      }
    } catch {
      return res.status(403).json({ ok: false, error: 'Origem inválida.' });
    }
  }
  res.set('Cache-Control', 'no-store');
  next();
});

// Aceita JSON também quando enviado como text/plain (comum em ferramentas de automação).
app.use(express.json({ limit: '15mb', type: ['application/json', 'text/plain', 'application/*+json'] }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

const route = (handler) => async (req, res, next) => {
  try {
    await handler(req, res);
  } catch (err) {
    next(err);
  }
};

/* --- Estado --- */
app.get('/api/state', (req, res) => res.json({ ok: true, state: publicState() }));

/* --- Operação (Macro Deck) --- */
app.post('/api/take', route((req, res) => {
  const input = readInput(req);
  let entry = state.data;
  if (hasEntryFields(input)) {
    // Com "name" => novo participante completo; sem "name" => altera só os campos enviados.
    entry = input.name !== undefined ? toEntry(input) : toEntry({ ...state.data, ...input });
  }
  take(entry);
  res.json({ ok: true, state: publicState() });
}));

app.post('/api/hide', route((req, res) => {
  hide('api');
  res.json({ ok: true, state: publicState() });
}));

app.post('/api/toggle', route((req, res) => {
  if (state.visible) {
    hide('toggle');
  } else {
    const input = readInput(req);
    take(hasEntryFields(input) ? toEntry({ ...state.data, ...input }) : state.data);
  }
  res.json({ ok: true, state: publicState() });
}));

app.post('/api/take/slot/:slot', route((req, res) => {
  const slot = Number.parseInt(req.params.slot, 10);
  if (!Number.isInteger(slot) || slot < 1 || slot > presets.length) {
    throw new HttpError(404, `Slot ${req.params.slot} não existe (há ${presets.length} preset(s)).`);
  }
  const { id, ...entry } = presets[slot - 1];
  take(toEntry(entry));
  res.json({ ok: true, slot, presetId: id, state: publicState() });
}));

/* --- Presets --- */
app.get('/api/presets', (req, res) => res.json({ ok: true, presets }));

app.post('/api/presets', route(async (req, res) => {
  const list = Array.isArray(req.body) ? req.body : req.body?.presets;
  if (!Array.isArray(list)) throw new HttpError(400, 'Envie um array de presets (ou { "presets": [...] }).');

  const next = list.filter(isPlainObject).map(toPreset).filter((p) => p.name);
  const seen = new Set();
  presets = next.map((p) => (seen.has(p.id) ? { ...p, id: crypto.randomUUID() } : (seen.add(p.id), p)));

  await savePresets();
  broadcastPresets();
  res.json({ ok: true, presets });
}));

app.post('/api/presets/add', route(async (req, res) => {
  const preset = toPreset({ ...readInput(req), id: undefined });
  if (!preset.name) throw new HttpError(400, 'O campo "name" é obrigatório.');
  presets.push(preset);
  await savePresets();
  broadcastPresets();
  res.status(201).json({ ok: true, slot: presets.length, preset });
}));

app.put('/api/presets/:id', route(async (req, res) => {
  const index = presets.findIndex((p) => p.id === req.params.id);
  if (index === -1) throw new HttpError(404, 'Preset não encontrado.');
  const preset = { ...toPreset(readInput(req)), id: presets[index].id };
  if (!preset.name) throw new HttpError(400, 'O campo "name" é obrigatório.');
  presets[index] = preset;
  await savePresets();
  broadcastPresets();
  res.json({ ok: true, slot: index + 1, preset });
}));

app.delete('/api/presets/:id', route(async (req, res) => {
  const index = presets.findIndex((p) => p.id === req.params.id);
  if (index === -1) throw new HttpError(404, 'Preset não encontrado.');
  const [removed] = presets.splice(index, 1);
  await savePresets();
  broadcastPresets();
  res.json({ ok: true, removed });
}));

/* --- Upload --- */
app.post('/api/upload', route(async (req, res) => {
  const input = isPlainObject(req.body) ? req.body : {};
  const saved = await saveBase64Image(input);
  res.status(201).json({ ok: true, ...saved });
}));

/* --- 404 da API --- */
app.use('/api', (req, res) => res.status(404).json({ ok: false, error: `Rota não encontrada: ${req.method} ${req.originalUrl}` }));

/* --- Arquivos estáticos --- */
app.use('/uploads', express.static(CONFIG.uploadsDir, { maxAge: '30d', immutable: true, dotfiles: 'deny' }));
app.use(express.static(CONFIG.publicDir, { extensions: ['html'], maxAge: 0 }));
app.get('/', (req, res) => res.redirect('/dock.html'));

/* --- Tratamento de erros --- */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  let status = err.status || err.statusCode || 500;
  let message = err.message || 'Erro interno.';
  if (err.type === 'entity.parse.failed') { status = 400; message = 'JSON inválido no corpo da requisição.'; }
  if (err.type === 'entity.too.large') { status = 413; message = 'Corpo da requisição muito grande.'; }
  if (status >= 500) console.error('[erro]', err);
  res.status(status).json({ ok: false, error: message });
});

/* ------------------------------------------------------------------ */
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}
const broadcastState = () => broadcast({ type: 'state', state: publicState() });
const broadcastPresets = () => broadcast({ type: 'presets', presets });

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', (err) => console.warn('[ws] erro no cliente:', err.message));
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg?.type === 'ping') ws.send(JSON.stringify({ type: 'pong', now: Date.now() }));
    if (msg?.type === 'sync') {
      ws.send(JSON.stringify({ type: 'state', state: publicState() }));
      ws.send(JSON.stringify({ type: 'presets', presets }));
    }
  });

  ws.send(JSON.stringify({ type: 'state', state: publicState() }));
  ws.send(JSON.stringify({ type: 'presets', presets }));
  console.log(`[ws] cliente conectado (${req.socket.remoteAddress}) — total: ${wss.clients.size}`);
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, CONFIG.heartbeatMs);
wss.on('close', () => clearInterval(heartbeat));

/* ------------------------------------------------------------------ */
/* Inicialização                                                       */
/* ------------------------------------------------------------------ */
function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

async function start() {
  if (!existsSync(CONFIG.uploadsDir)) mkdirSync(CONFIG.uploadsDir, { recursive: true });
  await loadPresets();
  if (presets[0]) {
    const { id, ...first } = presets[0];
    state.data = toEntry(first);
  }

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[erro] A porta ${CONFIG.port} já está em uso. Feche a outra instância ou use PORT=3001.\n`);
    } else {
      console.error('[erro] Falha no servidor:', err);
    }
    process.exit(1);
  });

  server.listen(CONFIG.port, CONFIG.host, () => {
    const base = `http://localhost:${CONFIG.port}`;
    console.log('\n  Lower Thirds ENT rodando');
    console.log('  ───────────────────────────────────────────────');
    console.log(`  Overlay (Browser Source): ${base}/overlay.html`);
    console.log(`  Dock (Custom Dock)      : ${base}/dock.html`);
    console.log(`  API                     : ${base}/api/take | /api/hide | /api/toggle | /api/take/slot/1`);
    if (CONFIG.host === '0.0.0.0') {
      for (const ip of lanAddresses()) console.log(`  Rede local              : http://${ip}:${CONFIG.port}/dock.html`);
    }
    console.log('  ───────────────────────────────────────────────\n');
  });
}

async function shutdown(signal) {
  console.log(`\n[${signal}] Encerrando...`);
  clearTimeout(hideTimer);
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, 'Servidor encerrando');
  await saveChain;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('[erro] Promise rejeitada sem tratamento:', err));

start().catch((err) => {
  console.error('[erro] Falha ao iniciar:', err);
  process.exit(1);
});
