// Campo Papi · Voz — app cliente.
//
// Flujo:
//   1) Login a Campo Papi via proxy local /api/campo/auth/login
//   2) Botón mic → /api/realtime/token (server crea ephemeral key OpenAI)
//   3) WebRTC directo a OpenAI (audio in/out + data channel)
//   4) Función-calling: el modelo invoca tools y nosotros pegamos a Campo Papi

const $ = (id) => document.getElementById(id);

// ───── Pricing (USD por 1M tokens, gpt-realtime / gpt-realtime-2) ────
// Ajustá si OpenAI cambia tarifas. Fuente: docs publicas OpenAI realtime.
const PRICING = {
  audio_in:        32.00 / 1_000_000,
  audio_in_cached:  0.40 / 1_000_000,
  audio_out:       64.00 / 1_000_000,
  text_in:          4.00 / 1_000_000,
  text_in_cached:   0.40 / 1_000_000,
  text_out:        16.00 / 1_000_000,
};

// ───── Estado ────────────────────────────────────────────────────────
const state = {
  accessToken: null,
  refreshToken: null,
  user: null,
  campoId: null,
  campos: [],
  pc: null,
  dc: null,
  micStream: null,
  stats: null,         // { startedAt, audioIn, audioInCached, textIn, textInCached, audioOut, textOut, cost, timerId }
  audioCtx: null,
  analyser: null,
  rafId: null,
  voice: 'cedar',      // se actualiza desde localStorage / select
  speakingHysteresis: false, // para el state machine STATUS
};

function resetStats() {
  state.stats = {
    startedAt: Date.now(),
    audioIn: 0, audioInCached: 0,
    textIn: 0, textInCached: 0,
    audioOut: 0, textOut: 0,
    cost: 0,
    timerId: null,
  };
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  if (m < 60) return `${m}:${ss}`;
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  return `${h}:${mm}:${ss}`;
}

function renderStats() {
  const s = state.stats;
  if (!s) {
    $('stat-time').textContent = '00:00';
    $('stat-in').textContent = '0';
    $('stat-out').textContent = '0';
    $('stat-cached').textContent = '0';
    $('stat-cost').textContent = '0.0000';
    return;
  }
  $('stat-time').textContent = fmtDuration((s.endedAt || Date.now()) - s.startedAt);
  $('stat-in').textContent = (s.audioIn + s.textIn).toLocaleString('es-AR');
  $('stat-out').textContent = (s.audioOut + s.textOut).toLocaleString('es-AR');
  $('stat-cached').textContent = (s.audioInCached + s.textInCached).toLocaleString('es-AR');
  $('stat-cost').textContent = s.cost.toFixed(4);
}

// ───── Historial persistente (localStorage) ──────────────────────────
const HISTORY_KEY = 'cp.sessions';
const HISTORY_MAX = 100;

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
  catch { return []; }
}
function saveHistory(arr) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(arr.slice(-HISTORY_MAX)));
}
function persistSession() {
  const s = state.stats;
  if (!s || !s.startedAt) return;
  const durationMs = (s.endedAt || Date.now()) - s.startedAt;
  if (durationMs < 1500 && s.cost === 0) return; // descarta conexiones fallidas/muy cortas sin uso
  const entry = {
    id: crypto.randomUUID(),
    startedAt: s.startedAt,
    endedAt: s.endedAt || Date.now(),
    durationMs,
    audioIn: s.audioIn, audioInCached: s.audioInCached,
    textIn: s.textIn, textInCached: s.textInCached,
    audioOut: s.audioOut, textOut: s.textOut,
    cost: s.cost,
    user: state.user?.email,
    campo: state.campos.find(c => c.id === state.campoId)?.nombre,
  };
  const arr = loadHistory();
  arr.push(entry);
  saveHistory(arr);
  renderHistory();
}

function fmtDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth()+1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderHistory() {
  const arr = loadHistory();
  const list = $('history-list');
  const summary = $('history-summary');
  list.innerHTML = '';
  if (!arr.length) {
    list.innerHTML = '<div class="history-empty">Aún no hay sesiones guardadas.</div>';
    summary.textContent = '';
    return;
  }
  // Mas recientes arriba
  const sorted = arr.slice().sort((a, b) => b.startedAt - a.startedAt);
  const totalCost = arr.reduce((a, e) => a + (e.cost || 0), 0);
  const totalMs = arr.reduce((a, e) => a + (e.durationMs || 0), 0);
  summary.textContent = `${arr.length} · ${fmtDuration(totalMs)} · $${totalCost.toFixed(4)}`;
  for (const e of sorted) {
    const tokIn = (e.audioIn || 0) + (e.textIn || 0) + (e.audioInCached || 0) + (e.textInCached || 0);
    const tokOut = (e.audioOut || 0) + (e.textOut || 0);
    const row = document.createElement('div');
    row.className = 'history-row';
    row.innerHTML = `
      <span class="h-when">${fmtDate(e.startedAt)}</span>
      <span class="h-dur">${fmtDuration(e.durationMs)}</span>
      <span class="h-tok">${tokIn.toLocaleString('es-AR')} / ${tokOut.toLocaleString('es-AR')}</span>
      <span class="h-cost">$${(e.cost || 0).toFixed(4)}</span>
    `;
    row.title = `${e.user || ''} · ${e.campo || ''}\nin: ${tokIn} (cached ${(e.audioInCached||0)+(e.textInCached||0)})\nout: ${tokOut}`;
    list.appendChild(row);
  }
}

function applyUsage(usage) {
  if (!state.stats || !usage) return;
  const s = state.stats;
  const inDet = usage.input_token_details || {};
  const outDet = usage.output_token_details || {};
  const inCacheDet = inDet.cached_tokens_details || {};

  const audio_in_cached = inCacheDet.audio_tokens || 0;
  const text_in_cached  = inCacheDet.text_tokens  || 0;
  // input_token_details.audio_tokens / text_tokens incluyen el total (cached + no-cached).
  // Restamos cached para obtener el "fresh" que se paga full price.
  const audio_in_total = inDet.audio_tokens || 0;
  const text_in_total  = inDet.text_tokens  || 0;
  const audio_in = Math.max(0, audio_in_total - audio_in_cached);
  const text_in  = Math.max(0, text_in_total  - text_in_cached);

  const audio_out = outDet.audio_tokens || 0;
  const text_out  = outDet.text_tokens  || 0;

  s.audioIn       += audio_in;
  s.audioInCached += audio_in_cached;
  s.textIn        += text_in;
  s.textInCached  += text_in_cached;
  s.audioOut      += audio_out;
  s.textOut       += text_out;

  s.cost +=
    audio_in        * PRICING.audio_in +
    audio_in_cached * PRICING.audio_in_cached +
    text_in         * PRICING.text_in +
    text_in_cached  * PRICING.text_in_cached +
    audio_out       * PRICING.audio_out +
    text_out        * PRICING.text_out;

  renderStats();
}

function saveSession() {
  localStorage.setItem('cp.session', JSON.stringify({
    accessToken: state.accessToken,
    refreshToken: state.refreshToken,
    user: state.user,
    campos: state.campos,
    campoId: state.campoId,
  }));
}
function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem('cp.session') || 'null');
    if (s) Object.assign(state, s);
  } catch {}
}

// ───── Helpers Campo Papi ────────────────────────────────────────────
async function campo(method, path, body) {
  const r = await fetch('/api/campo' + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(state.accessToken ? { authorization: `Bearer ${state.accessToken}` } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  const data = text ? safeJson(text) : null;
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}
function safeJson(t) { try { return JSON.parse(t); } catch { return t; } }
function uid() { return crypto.randomUUID(); }
function nowIso() { return new Date().toISOString(); }

async function syncCall(args) {
  return campo('POST', '/sync', { campoId: state.campoId, ...args });
}

async function pullAll(since = 0) {
  const out = {};
  const cursors = {};
  let pages = 50;
  while (pages-- > 0) {
    const r = await syncCall({ since, cursors });
    for (const [t, rows] of Object.entries(r.changes || {})) {
      if (!rows?.length) continue;
      out[t] = (out[t] || []).concat(rows);
    }
    const more = r.hasMore || {};
    if (!Object.values(more).some(Boolean)) break;
    for (const [t, hm] of Object.entries(more)) {
      if (!hm) continue;
      const rows = r.changes[t] || [];
      const last = rows[rows.length - 1];
      const ts = last?.updatedAt || last?.ts || last?.createdAt;
      if (ts) cursors[t] = ts;
    }
  }
  return out;
}

async function pushEntity(table, row) {
  const r = await syncCall({ since: Date.now(), changes: { [table]: [row] } });
  if (r.failed?.[table]?.length) throw new Error('Conflicto: ' + JSON.stringify(r.failed[table]));
  return row;
}

// Cache simple del último pull (para que las queries del modelo sean rapidas).
let cache = { all: null, at: 0 };
async function ensureCache(maxAgeMs = 4000) {
  if (cache.all && Date.now() - cache.at < maxAgeMs) return cache.all;
  cache.all = await pullAll(0);
  cache.at = Date.now();
  return cache.all;
}
function invalidateCache() { cache.at = 0; }

// ───── Tools expuestos al modelo (compactos para minimizar tokens) ──
// Mantener estable y SIN datos por-usuario para maximizar cache hits.
const O = (props, req) => ({ type: 'object', properties: props, required: req || [], additionalProperties: false });
const S = (extra = {}) => ({ type: 'string', ...extra });
const N = (extra = {}) => ({ type: 'number', ...extra });

const tools = [
  { type: 'function', name: 'list_lotes',         description: 'lista lotes',                                parameters: O({}) },
  { type: 'function', name: 'create_lote',        description: 'crea lote',                                  parameters: O({ nombre: S(), color: S(), hectareas: N(), notas: S() }, ['nombre']) },
  { type: 'function', name: 'list_animales',      description: 'lista animales (opt: loteId)',              parameters: O({ loteId: S() }) },
  { type: 'function', name: 'create_animal',      description: 'crea animal',                                parameters: O({ rfid: S(), caravanaVisual: S(), categoria: S(), sexo: S({ enum: ['M','H'] }), raza: S(), loteId: S(), notas: S() }) },
  { type: 'function', name: 'update_animal',      description: 'actualiza animal',                           parameters: O({ id: S(), loteId: S(), estado: S({ enum: ['activo','vendido','muerto'] }), notas: S() }, ['id']) },
  { type: 'function', name: 'move_animal',        description: 'mueve animal a otro lote',                   parameters: O({ animalId: S(), loteDestinoId: S() }, ['animalId','loteDestinoId']) },
  { type: 'function', name: 'list_sesiones',      description: 'lista sesiones',                             parameters: O({}) },
  { type: 'function', name: 'create_sesion',      description: 'inicia sesion (manga/pesaje/sanidad)',       parameters: O({ tipo: S(), nombre: S() }, ['tipo','nombre']) },
  { type: 'function', name: 'close_sesion',       description: 'cierra sesion',                              parameters: O({ id: S() }, ['id']) },
  { type: 'function', name: 'add_evento',         description: 'evento a animal (pesaje/sanidad/parto)',    parameters: O({ animalId: S(), sesionId: S(), tipo: S(), peso: N(), notas: S() }, ['animalId','tipo']) },
  { type: 'function', name: 'add_medicion_pasto', description: 'medicion pasto kgMS/ha',                     parameters: O({ loteId: S(), kgMsHa: N(), cantidadMuestras: { type: 'integer' } }, ['loteId','kgMsHa']) },
  { type: 'function', name: 'add_finanza',        description: 'ingreso/egreso',                             parameters: O({ tipo: S({ enum: ['ingreso','egreso'] }), monto: N(), moneda: S({ enum: ['ARS','USD'] }), descripcion: S() }, ['tipo','monto']) },
  { type: 'function', name: 'get_resumen',        description: 'resumen del campo',                          parameters: O({}) },
];

// ───── Implementacion de cada tool ───────────────────────────────────
const executors = {
  async list_lotes() {
    const all = await ensureCache();
    const lotes = (all.lotes || []).filter(l => !l.deletedAt);
    return lotes.map(l => ({ id: l.id, nombre: l.nombre, hectareas: l.hectareas, color: l.color }));
  },
  async create_lote(args) {
    const ts = nowIso();
    const row = { id: uid(), campoId: state.campoId, createdAt: ts, updatedAt: ts, ...args };
    await pushEntity('lotes', row);
    invalidateCache();
    return { id: row.id, nombre: row.nombre };
  },
  async list_animales({ loteId } = {}) {
    const all = await ensureCache();
    let arr = (all.animales || []).filter(a => !a.deletedAt);
    if (loteId) arr = arr.filter(a => a.loteId === loteId);
    return arr.map(a => ({
      id: a.id, rfid: a.rfid, caravanaVisual: a.caravanaVisual,
      categoria: a.categoria, sexo: a.sexo, loteId: a.loteId, estado: a.estado,
    }));
  },
  async create_animal(args) {
    const ts = nowIso();
    const row = {
      id: uid(),
      campoId: state.campoId,
      rfid: args.rfid || `TMP-${Date.now()}`,
      estado: 'activo',
      createdAt: ts, updatedAt: ts,
      ...args,
    };
    // Si no le mando rfid, vuelvo a fijarlo (el spread arriba podria sobreescribirlo con undefined)
    if (!row.rfid) row.rfid = `TMP-${Date.now()}`;
    await pushEntity('animales', row);
    invalidateCache();
    return { id: row.id, rfid: row.rfid, caravanaVisual: row.caravanaVisual || null };
  },
  async update_animal({ id, ...patch }) {
    const all = await ensureCache();
    const cur = (all.animales || []).find(a => a.id === id);
    if (!cur) throw new Error('Animal no encontrado: ' + id);
    const row = { ...cur, ...patch, id, campoId: state.campoId, updatedAt: nowIso() };
    await pushEntity('animales', row);
    invalidateCache();
    return { id, ok: true };
  },
  async move_animal({ animalId, loteDestinoId }) {
    const all = await ensureCache();
    const animal = (all.animales || []).find(a => a.id === animalId);
    if (!animal) throw new Error('Animal no encontrado');
    const ts = nowIso();
    const mov = {
      id: uid(), campoId: state.campoId, animalId,
      loteOrigenId: animal.loteId || null, loteDestinoId,
      ts, createdAt: ts,
    };
    await pushEntity('movimientos', mov);
    await pushEntity('animales', { ...animal, loteId: loteDestinoId, updatedAt: ts });
    invalidateCache();
    return { ok: true, movimientoId: mov.id };
  },
  async list_sesiones() {
    const all = await ensureCache();
    return (all.sesiones || [])
      .filter(s => !s.deletedAt)
      .map(s => ({ id: s.id, nombre: s.nombre, tipo: s.tipo, iniciadaEn: s.iniciadaEn, cerradaEn: s.cerradaEn }));
  },
  async create_sesion({ tipo, nombre }) {
    const ts = nowIso();
    const row = { id: uid(), campoId: state.campoId, tipo, nombre, iniciadaEn: ts, createdAt: ts, updatedAt: ts };
    await pushEntity('sesiones', row);
    invalidateCache();
    return { id: row.id, nombre };
  },
  async close_sesion({ id }) {
    const all = await ensureCache();
    const cur = (all.sesiones || []).find(s => s.id === id);
    if (!cur) throw new Error('Sesion no encontrada');
    const ts = nowIso();
    await pushEntity('sesiones', { ...cur, cerradaEn: ts, updatedAt: ts });
    invalidateCache();
    return { ok: true };
  },
  async add_evento({ animalId, sesionId, tipo, peso, notas }) {
    const ts = nowIso();
    const row = {
      id: uid(), campoId: state.campoId, animalId,
      sesionId: sesionId || null, tipo,
      peso: peso ?? null, notas: notas || null,
      ts, createdAt: ts, updatedAt: ts,
    };
    await pushEntity('eventos', row);
    invalidateCache();
    return { id: row.id };
  },
  async add_medicion_pasto({ loteId, kgMsHa, cantidadMuestras }) {
    const ts = nowIso();
    const row = {
      id: uid(), campoId: state.campoId, loteId,
      fecha: ts, kgMsHa,
      cantidadMuestras: cantidadMuestras ?? null,
      createdAt: ts, updatedAt: ts,
    };
    await pushEntity('mediciones_pasto', row);
    invalidateCache();
    return { id: row.id };
  },
  async add_finanza({ tipo, monto, moneda = 'ARS', descripcion }) {
    const ts = nowIso();
    const row = {
      id: uid(), campoId: state.campoId, tipo, monto, moneda,
      fecha: ts, descripcion: descripcion || null,
      createdAt: ts, updatedAt: ts,
    };
    await pushEntity('finanzas', row);
    invalidateCache();
    return { id: row.id };
  },
  async get_resumen() {
    const all = await ensureCache();
    const lotes = (all.lotes || []).filter(l => !l.deletedAt);
    const animales = (all.animales || []).filter(a => !a.deletedAt && a.estado !== 'vendido' && a.estado !== 'muerto');
    const sesiones = (all.sesiones || []).filter(s => !s.deletedAt);
    const sesionesAbiertas = sesiones.filter(s => !s.cerradaEn);
    return {
      campo: state.campos.find(c => c.id === state.campoId)?.nombre,
      lotes: lotes.length,
      animales: animales.length,
      sesionesAbiertas: sesionesAbiertas.length,
      sesionesTotales: sesiones.length,
    };
  },
};

// ───── UI ────────────────────────────────────────────────────────────
function showLogin() {
  $('login').classList.remove('hidden');
  $('main').classList.add('hidden');
}
function showMain() {
  $('login').classList.add('hidden');
  $('main').classList.remove('hidden');
  $('user-name').textContent = state.user?.nombre || state.user?.email || '';
  const campo = state.campos.find(c => c.id === state.campoId);
  $('campo-name').textContent = campo ? campo.nombre : '';
  $('user-sep').style.display = campo ? '' : 'none';
}

// Status state machine: STANDBY / CONNECTING / LISTENING / SPEAKING / ERROR
function setStatus(label, opts = {}) {
  const el = $('status-text');
  if (!el) return;
  el.textContent = label;
  const live = !!opts.live || label === 'LISTENING' || label === 'SPEAKING';
  $('status-dot').classList.toggle('live', live);
  $('orb').classList.toggle('live', live);
  const orbLabel = $('orb-label');
  if (orbLabel) {
    if (label === 'STANDBY') orbLabel.textContent = 'TAP TO CONNECT';
    else if (label === 'CONNECTING') orbLabel.textContent = 'CONNECTING…';
    else if (label === 'SPEAKING') orbLabel.textContent = 'SPEAKING';
    else if (label === 'LISTENING') orbLabel.textContent = 'LISTENING';
    else orbLabel.textContent = label;
  }
}

function log(role, text) {
  const div = document.createElement('div');
  div.className = 'msg msg-' + role;
  const prefix = role === 'tool' ? '🔧 ' : role === 'user' ? '🗣️ ' : '🤖 ';
  div.textContent = prefix + text;
  $('transcript').appendChild(div);
  $('transcript').scrollTop = $('transcript').scrollHeight;
}

// ───── Login ─────────────────────────────────────────────────────────
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  const email = $('email').value.trim();
  const password = $('password').value;
  try {
    const r = await fetch('/api/campo/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error || 'Login fallo');
    state.accessToken = data.accessToken;
    state.refreshToken = data.refreshToken;
    state.user = data.user;
    state.campos = data.campos || (data.campo ? [data.campo] : []);
    state.campoId = state.campos[0]?.id || null;
    if (!state.campoId) throw new Error('Tu usuario no tiene un campo asociado.');
    saveSession();
    showMain();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('logout-btn').addEventListener('click', async () => {
  try { await stopRealtime(); } catch {}
  state.accessToken = state.refreshToken = state.user = state.campoId = null;
  state.campos = [];
  localStorage.removeItem('cp.session');
  showLogin();
});

// ───── Realtime (WebRTC GA) ──────────────────────────────────────────
async function startRealtime() {
  setStatus('CONNECTING');
  const voiceQ = state.voice ? `?voice=${encodeURIComponent(state.voice)}` : '';
  const tokenR = await fetch('/api/realtime/token' + voiceQ, { method: 'POST' });
  const tokenData = await tokenR.json();
  if (!tokenR.ok) throw new Error(tokenData?.error?.message || 'Token fallo');
  const eph = tokenData.value;
  const model = tokenData.session?.model;

  const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
  state.micStream = ms;

  const pc = new RTCPeerConnection();
  state.pc = pc;

  const audioEl = $('remote-audio');
  pc.ontrack = (e) => {
    audioEl.srcObject = e.streams[0];
    setupAudioAnalyser(e.streams[0]);
  };
  pc.addTrack(ms.getTracks()[0], ms);

  const dc = pc.createDataChannel('oai-events');
  state.dc = dc;
  dc.addEventListener('open', () => onChannelOpen());
  dc.addEventListener('message', (e) => {
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    onEvent(ev);
  });
  dc.addEventListener('close', () => setStatus('STANDBY'));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // GA: SDP exchange en /v1/realtime/calls
  const sdpR = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(model)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${eph}`, 'Content-Type': 'application/sdp' },
    body: offer.sdp,
  });
  if (!sdpR.ok) {
    const errText = await sdpR.text();
    throw new Error('SDP fallo: ' + sdpR.status + ' ' + errText.slice(0, 200));
  }
  const answerSdp = await sdpR.text();
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
}

// System prompt MUY corto y 100% estatico → cache hit casi total despues
// del primer turno. Los datos del user/campo NO van aca (variarian por
// usuario y romperian el cache); el modelo los puede preguntar o usar.
const SYSTEM_PROMPT = [
  'Asistente de voz de Campo Papi (gestion ganadera).',
  'Hablas castellano rioplatense, voseo, tono breve y directo.',
  'REGLAS:',
  '- Respuestas brevisimas: 1-2 frases, sin floreo.',
  '- Ejecuta funciones al toque sin pedir confirmacion si esta claro.',
  '- Si falta un id, llama primero al list_* correspondiente.',
  '- No leas ids ni uuids en voz alta.',
  '- Si crean animal sin rfid se asigna uno temporal (TMP-...). Avisar muy corto.',
].join('\n');

function onChannelOpen() {
  setStatus('LISTENING');

  // Arranca contador de tiempo y panel de stats.
  resetStats();
  state.stats.timerId = setInterval(renderStats, 1000);
  renderStats();

  state.dc.send(JSON.stringify({
    type: 'session.update',
    session: {
      type: 'realtime',
      instructions: SYSTEM_PROMPT,
      tools,
      tool_choice: 'auto',
      // Cap output → frena respuestas largas (audio output es lo mas caro).
      max_output_tokens: 250,
      audio: {
        input: {
          // VAD mas estricto: 800ms de silencio para cerrar turno, threshold
          // 0.55 evita activaciones por respiracion/ruido.
          turn_detection: {
            type: 'server_vad',
            threshold: 0.55,
            prefix_padding_ms: 200,
            silence_duration_ms: 800,
            create_response: true,
            interrupt_response: true,
          },
        },
      },
    },
  }));

  // Saludo: una sola linea breve para que arranque algo, sin texto largo.
  // (Si querés ahorrar aun mas, sacá este response.create — el usuario habla primero.)
  // state.dc.send(JSON.stringify({ type: 'response.create', response: { instructions: 'Decí solo: "Hola, decime."' } }));
}

async function onEvent(ev) {
  // console.debug('ev', ev.type, ev);
  switch (ev.type) {
    // GA: nuevos nombres
    case 'conversation.item.input_audio_transcription.completed':
      if (ev.transcript) log('user', ev.transcript);
      break;
    case 'response.output_audio_transcript.done':
    case 'response.audio_transcript.done':
      if (ev.transcript) log('assistant', ev.transcript);
      break;
    case 'response.function_call_arguments.done':
      await runTool(ev.call_id, ev.name, ev.arguments);
      break;
    case 'response.done':
      // Acumular usage: ev.response.usage = { input_tokens, output_tokens,
      //   input_token_details: { audio_tokens, text_tokens, cached_tokens_details: { audio_tokens, text_tokens } },
      //   output_token_details: { audio_tokens, text_tokens } }
      applyUsage(ev.response?.usage);
      break;
    case 'error':
      console.error('OAI error', ev);
      log('tool', '⚠️ ' + (ev.error?.message || JSON.stringify(ev.error)));
      break;
  }
}

async function runTool(call_id, name, argsRaw) {
  let args = {};
  try { args = typeof argsRaw === 'string' ? JSON.parse(argsRaw || '{}') : (argsRaw || {}); } catch {}
  log('tool', `${name}(${JSON.stringify(args)})`);
  let result;
  try {
    const fn = executors[name];
    if (!fn) throw new Error('tool desconocido: ' + name);
    result = await fn(args);
  } catch (e) {
    result = { error: e.message };
  }
  state.dc.send(JSON.stringify({
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id,
      output: JSON.stringify(result),
    },
  }));
  // Pedir al modelo que continúe.
  state.dc.send(JSON.stringify({ type: 'response.create' }));
}

async function stopRealtime() {
  setStatus('STANDBY');
  if (state.stats?.timerId) { clearInterval(state.stats.timerId); state.stats.timerId = null; }
  if (state.stats) state.stats.endedAt = Date.now();
  renderStats(); // congela el tiempo final
  persistSession();
  teardownAudioAnalyser();
  try { state.dc?.close(); } catch {}
  try { state.pc?.close(); } catch {}
  state.dc = null; state.pc = null;
  if (state.micStream) {
    state.micStream.getTracks().forEach(t => t.stop());
    state.micStream = null;
  }
  // Reset CSS vars del orb
  const root = document.documentElement;
  root.style.setProperty('--amp', '0');
  for (let i = 0; i < 32; i++) root.style.setProperty(`--bar-${i}`, '0');
}

$('orb').addEventListener('click', async () => {
  if (state.pc) { await stopRealtime(); return; }
  try {
    await startRealtime();
  } catch (e) {
    console.error(e);
    setStatus('ERROR');
    log('tool', '⚠️ ' + e.message);
    try { await stopRealtime(); } catch {}
  }
});

// ───── Audio analyser: orb visualization ─────────────────────────────
// Hooks un AnalyserNode al stream remoto (voz del modelo) para alimentar
// las CSS vars del orb. La voz del usuario nunca pasa por aca, asi que el
// orb se queda quieto cuando habla el user — sin trackear turn state.
function setupAudioAnalyser(stream) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    state.audioCtx = new Ctx();
    const source = state.audioCtx.createMediaStreamSource(stream);
    const analyser = state.audioCtx.createAnalyser();
    analyser.fftSize = 64;                   // 32 bins
    analyser.smoothingTimeConstant = 0.7;
    source.connect(analyser);
    // OJO: NO conectamos analyser al destination, el <audio> ya reproduce
    // via srcObject. Conectar duplicaria audio + agregaria delay.
    state.analyser = analyser;

    const freq = new Uint8Array(analyser.frequencyBinCount);
    const root = document.documentElement;

    const tick = () => {
      if (!state.analyser) return;
      analyser.getByteFrequencyData(freq);
      let sum = 0;
      for (let i = 0; i < freq.length; i++) {
        sum += freq[i];
        root.style.setProperty(`--bar-${i}`, (freq[i] / 255).toFixed(3));
      }
      const amp = (sum / freq.length) / 255;
      root.style.setProperty('--amp', amp.toFixed(3));

      // State machine LISTENING ↔ SPEAKING con histeresis (evita flicker).
      const above = state.speakingHysteresis ? amp > 0.04 : amp > 0.08;
      if (state.dc && state.dc.readyState === 'open') {
        if (above && !state.speakingHysteresis) { state.speakingHysteresis = true; setStatus('SPEAKING'); }
        else if (!above && state.speakingHysteresis) { state.speakingHysteresis = false; setStatus('LISTENING'); }
      }

      state.rafId = requestAnimationFrame(tick);
    };
    state.rafId = requestAnimationFrame(tick);
  } catch (e) {
    console.warn('audio analyser fallo:', e);
  }
}

function teardownAudioAnalyser() {
  if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
  state.analyser = null;
  state.speakingHysteresis = false;
  if (state.audioCtx) {
    try { state.audioCtx.close(); } catch {}
    state.audioCtx = null;
  }
}

// ───── Orb: generar las 32 barras radiales ──────────────────────────
function buildOrbBars() {
  const container = $('orb-bars');
  if (!container || container.childElementCount > 0) return;
  const N = 32;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < N; i++) {
    const bar = document.createElement('div');
    bar.className = 'orb-bar';
    const angle = (i / N) * 360;
    bar.style.setProperty('--angle', angle + 'deg');
    bar.style.setProperty('--bar', `var(--bar-${i}, 0)`);
    frag.appendChild(bar);
  }
  container.appendChild(frag);
}

// ───── Voice selector ────────────────────────────────────────────────
function loadVoicePref() {
  const v = localStorage.getItem('cp.voice');
  if (v) state.voice = v;
  const sel = $('voice-select');
  if (sel) sel.value = state.voice;
}
$('voice-select').addEventListener('change', (e) => {
  state.voice = e.target.value;
  localStorage.setItem('cp.voice', state.voice);
  // Si esta conectado, avisar: hay que reconectar para que tome efecto.
  if (state.pc) log('tool', `voz cambiada a "${state.voice}" — re-conectá para aplicar`);
});

// ───── Drawer (transcript / history) ────────────────────────────────
$('drawer-toggle').addEventListener('click', () => $('drawer').classList.toggle('open'));
$('drawer-close').addEventListener('click', () => $('drawer').classList.remove('open'));

// ───── Historial: botón vaciar ───────────────────────────────────────
$('history-clear').addEventListener('click', () => {
  if (!confirm('¿Borrar todo el historial de sesiones?')) return;
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});

// Cuando el browser cierra/recarga, intentamos guardar la sesion en curso.
window.addEventListener('beforeunload', () => {
  if (state.pc && state.stats) {
    state.stats.endedAt = Date.now();
    try { persistSession(); } catch {}
  }
});

// ───── Init ──────────────────────────────────────────────────────────
buildOrbBars();
loadVoicePref();
loadSession();
if (state.accessToken && state.campoId) showMain();
else showLogin();
setStatus('STANDBY');
renderStats();
renderHistory();
