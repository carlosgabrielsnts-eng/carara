
require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);
const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || '';
const WORKER_INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS || 10000);
const SECRET_FILE_CANDIDATES = [
  process.env.GOOGLE_APPLICATION_CREDENTIALS,
  process.env.SERVICE_ACCOUNT_FILE,
  '/etc/secrets/serviceAccount.json',
  path.join(__dirname, 'serviceAccount.json')
].filter(Boolean);

const logs = [];
let startupChecks = [];
let workerState = {
  running: false,
  lastRunAt: null,
  lastError: null,
  lastSummary: null
};

function addLog(level, message, extra) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    extra: extra || null
  };
  logs.unshift(entry);
  if (logs.length > 200) logs.pop();
  const printable = `[${entry.ts}] [${level.toUpperCase()}] ${message}${extra ? ' ' + JSON.stringify(extra) : ''}`;
  if (level === 'error') console.error(printable);
  else console.log(printable);
}

function resolveServiceAccount() {
  for (const candidate of SECRET_FILE_CANDIDATES) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        const raw = fs.readFileSync(candidate, 'utf8');
        return { json: JSON.parse(raw), source: candidate };
      }
    } catch (err) {
      startupChecks.push(`Falha ao ler ${candidate}: ${err.message}`);
    }
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      return {
        json: JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON),
        source: 'FIREBASE_SERVICE_ACCOUNT_JSON'
      };
    } catch (err) {
      startupChecks.push(`FIREBASE_SERVICE_ACCOUNT_JSON inválido: ${err.message}`);
    }
  }

  return null;
}

let firebaseReady = false;
let firebaseSource = null;
let db = null;

try {
  const resolved = resolveServiceAccount();
  if (!resolved) {
    startupChecks.push('Nenhum serviceAccount.json encontrado.');
    addLog('warn', 'Firebase Admin não inicializado: service account ausente.');
  } else if (!FIREBASE_DATABASE_URL) {
    startupChecks.push('FIREBASE_DATABASE_URL não configurado.');
    addLog('warn', 'Firebase Admin não inicializado: FIREBASE_DATABASE_URL ausente.');
    firebaseSource = resolved.source;
  } else {
    admin.initializeApp({
      credential: admin.credential.cert(resolved.json),
      databaseURL: FIREBASE_DATABASE_URL
    });
    db = admin.database();
    firebaseReady = true;
    firebaseSource = resolved.source;
    addLog('info', 'Firebase Admin conectado com sucesso.', { source: firebaseSource });
  }
} catch (err) {
  startupChecks.push(`Erro ao conectar Firebase Admin: ${err.message}`);
  addLog('error', 'Erro ao conectar Firebase Admin.', { error: err.message });
}

async function getSnapshotValue(refPath) {
  if (!firebaseReady) return null;
  const snap = await db.ref(refPath).get();
  return snap.exists() ? snap.val() : null;
}

function countObjectKeys(value) {
  if (!value || typeof value !== 'object') return 0;
  return Object.keys(value).length;
}

async function buildStatus() {
  let users = null;
  let orders = null;
  let links = null;
  let pendingOrders = [];
  let pendingLinks = [];

  if (firebaseReady) {
    const siteUsers = await getSnapshotValue('siteUsers');
    const siteOrders = await getSnapshotValue('siteOrders');
    const linkRequests = await getSnapshotValue('linkRequests');

    users = countObjectKeys(siteUsers);

    let orderCount = 0;
    if (siteOrders && typeof siteOrders === 'object') {
      for (const [discordId, orderBucket] of Object.entries(siteOrders)) {
        if (orderBucket && typeof orderBucket === 'object') {
          for (const [orderId, order] of Object.entries(orderBucket)) {
            orderCount += 1;
            const row = { discordId, orderId, ...(order || {}) };
            if ((row.status || '').toLowerCase() !== 'paid' && pendingOrders.length < 10) {
              pendingOrders.push(row);
            }
          }
        }
      }
    }
    orders = orderCount;

    links = countObjectKeys(linkRequests);
    if (linkRequests && typeof linkRequests === 'object') {
      for (const [discordId, req] of Object.entries(linkRequests)) {
        const row = { discordId, ...(req || {}) };
        if ((row.status || 'pending').toLowerCase() !== 'confirmed' && pendingLinks.length < 10) {
          pendingLinks.push(row);
        }
      }
    }
  }

  return {
    ok: true,
    backendOnline: true,
    firebaseReady,
    firebaseSource,
    databaseUrlConfigured: !!FIREBASE_DATABASE_URL,
    worker: workerState,
    counts: { users, orders, links },
    pendingOrders,
    pendingLinks,
    startupChecks,
    logs: logs.slice(0, 50)
  };
}

async function runWorkerOnce() {
  workerState.running = true;
  workerState.lastRunAt = new Date().toISOString();
  workerState.lastError = null;

  try {
    if (!firebaseReady) {
      workerState.lastSummary = { message: 'Worker parado: Firebase não conectado.' };
      return;
    }

    const queue = await getSnapshotValue('paymentQueue');
    const linkRequests = await getSnapshotValue('linkRequests');
    let queueCount = countObjectKeys(queue);
    let linkCount = countObjectKeys(linkRequests);

    workerState.lastSummary = {
      paymentQueue: queueCount,
      linkRequests: linkCount,
      message: 'Leitura do banco concluída.'
    };

    addLog('info', 'Worker executado.', workerState.lastSummary);
  } catch (err) {
    workerState.lastError = err.message;
    addLog('error', 'Erro no worker.', { error: err.message });
  } finally {
    workerState.running = false;
  }
}

app.get('/', (req, res) => {
  res.redirect('/admin');
});

app.get('/api/health', async (req, res) => {
  const status = await buildStatus();
  res.json(status);
});

app.get('/api/admin/status', async (req, res) => {
  const status = await buildStatus();
  res.json(status);
});

app.post('/api/admin/run-worker', async (req, res) => {
  await runWorkerOnce();
  res.json({ ok: true, worker: workerState });
});

app.get('/admin', (req, res) => {
  res.send(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Argos RJ • Backend Admin</title>
<style>
:root{
  --bg:#0b1020; --panel:#11192d; --panel2:#0f1728; --line:rgba(255,255,255,.08);
  --text:#eef3ff; --muted:#aab6d3; --accent:#ff8c2f; --ok:#29d17d; --warn:#ffcc4d; --bad:#ff5f6d;
}
*{box-sizing:border-box}
body{margin:0;font-family:Inter,Arial,sans-serif;background:
radial-gradient(circle at top right, rgba(53,86,173,.35), transparent 30%),
radial-gradient(circle at top left, rgba(255,140,47,.12), transparent 25%),var(--bg);color:var(--text)}
.topbar{display:flex;justify-content:space-between;align-items:center;padding:20px 28px;border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(11,16,32,.85);backdrop-filter:blur(10px);z-index:5}
.wrap{max-width:1320px;margin:0 auto;padding:28px}
h1{margin:0;font-size:24px}
.small{color:var(--muted);font-size:14px}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px}
.card{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--line);border-radius:20px;padding:20px;box-shadow:0 18px 50px rgba(0,0,0,.25)}
.card h3{margin:0 0 10px;font-size:14px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.08em}
.big{font-size:28px;font-weight:800}
.badge{display:inline-flex;align-items:center;gap:8px;padding:7px 12px;border-radius:999px;background:rgba(255,255,255,.05);border:1px solid var(--line);font-size:13px}
.dot{width:10px;height:10px;border-radius:999px;background:var(--warn)}
.dot.ok{background:var(--ok)} .dot.bad{background:var(--bad)}
.layout{display:grid;grid-template-columns:1.2fr .8fr;gap:18px;margin-top:18px}
.section-title{margin:0 0 12px;font-size:18px}
.toolbar{display:flex;gap:10px;align-items:center}
button{border:0;background:var(--accent);color:#1a120b;font-weight:800;padding:12px 14px;border-radius:12px;cursor:pointer}
button.secondary{background:rgba(255,255,255,.06);color:var(--text);border:1px solid var(--line)}
pre, table{width:100%}
pre{background:rgba(255,255,255,.03);border:1px solid var(--line);padding:14px;border-radius:14px;overflow:auto;color:#d6def8}
table{border-collapse:collapse}
th,td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;font-size:14px}
th{color:var(--muted);font-weight:700}
.scroll{max-height:420px;overflow:auto}
.notice{padding:12px 14px;border-radius:12px;background:rgba(255,204,77,.08);border:1px solid rgba(255,204,77,.18);color:#ffe7a0;white-space:pre-wrap}
@media (max-width:1100px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.layout{grid-template-columns:1fr}}
@media (max-width:700px){.grid{grid-template-columns:1fr}.topbar,.wrap{padding:16px}}
</style>
</head>
<body>
  <div class="topbar">
    <div>
      <h1>Argos RJ • Backend Admin</h1>
      <div class="small">Monitoramento do backend, Firebase, pedidos e vínculo do jogo</div>
    </div>
    <div class="toolbar">
      <span id="liveBadge" class="badge"><span class="dot"></span><span>Carregando...</span></span>
      <button id="refreshBtn" class="secondary">Atualizar</button>
      <button id="workerBtn">Rodar worker</button>
    </div>
  </div>

  <div class="wrap">
    <div class="grid">
      <div class="card">
        <h3>Backend</h3>
        <div id="backendOnline" class="big">--</div>
      </div>
      <div class="card">
        <h3>Firebase</h3>
        <div id="firebaseReady" class="big">--</div>
        <div id="firebaseSource" class="small" style="margin-top:8px">--</div>
      </div>
      <div class="card">
        <h3>Usuários</h3>
        <div id="usersCount" class="big">--</div>
      </div>
      <div class="card">
        <h3>Pedidos</h3>
        <div id="ordersCount" class="big">--</div>
      </div>
    </div>

    <div class="layout">
      <div>
        <div class="card" style="margin-bottom:18px">
          <h2 class="section-title">Checagens iniciais</h2>
          <div id="checksBox" class="notice">Lendo status...</div>
        </div>

        <div class="card" style="margin-bottom:18px">
          <h2 class="section-title">Pedidos pendentes</h2>
          <div class="scroll">
            <table>
              <thead><tr><th>Discord</th><th>Pedido</th><th>Status</th><th>Valor</th></tr></thead>
              <tbody id="ordersTable"><tr><td colspan="4">Carregando...</td></tr></tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <h2 class="section-title">Solicitações de vínculo</h2>
          <div class="scroll">
            <table>
              <thead><tr><th>Discord</th><th>ID jogo</th><th>Status</th><th>Código</th></tr></thead>
              <tbody id="linksTable"><tr><td colspan="4">Carregando...</td></tr></tbody>
            </table>
          </div>
        </div>
      </div>

      <div>
        <div class="card" style="margin-bottom:18px">
          <h2 class="section-title">Worker</h2>
          <pre id="workerBox">Carregando...</pre>
        </div>
        <div class="card">
          <h2 class="section-title">Logs recentes</h2>
          <pre id="logsBox">Carregando...</pre>
        </div>
      </div>
    </div>
  </div>

<script>
async function loadStatus(){
  const res = await fetch('/api/admin/status');
  const data = await res.json();

  document.getElementById('backendOnline').textContent = data.backendOnline ? 'ONLINE' : 'OFF';
  document.getElementById('firebaseReady').textContent = data.firebaseReady ? 'CONECTADO' : 'FALHOU';
  document.getElementById('firebaseSource').textContent = data.firebaseSource || 'Sem arquivo/segredo';
  document.getElementById('usersCount').textContent = data.counts.users ?? 0;
  document.getElementById('ordersCount').textContent = data.counts.orders ?? 0;

  const badge = document.getElementById('liveBadge');
  badge.innerHTML = data.firebaseReady
    ? '<span class="dot ok"></span><span>Firebase conectado</span>'
    : '<span class="dot bad"></span><span>Backend online • Firebase com erro</span>';

  const checks = (data.startupChecks && data.startupChecks.length)
    ? data.startupChecks.map(v => '• ' + v).join('\n')
    : 'Tudo certo na inicialização.';
  document.getElementById('checksBox').textContent = checks;

  document.getElementById('workerBox').textContent = JSON.stringify(data.worker, null, 2);
  document.getElementById('logsBox').textContent = (data.logs || []).map(l => `[${l.ts}] [${(l.level||'info').toUpperCase()}] ${l.message}${l.extra ? ' ' + JSON.stringify(l.extra) : ''}`).join('\n') || 'Sem logs.';

  const ordersRows = (data.pendingOrders || []).map(row => `
    <tr>
      <td>${row.discordId || '-'}</td>
      <td>${row.orderId || '-'}</td>
      <td>${row.status || 'pending'}</td>
      <td>${row.total || row.amount || row.price || '-'}</td>
    </tr>`).join('');
  document.getElementById('ordersTable').innerHTML = ordersRows || '<tr><td colspan="4">Sem pedidos pendentes.</td></tr>';

  const linksRows = (data.pendingLinks || []).map(row => `
    <tr>
      <td>${row.discordId || '-'}</td>
      <td>${row.gameId || row.playerId || '-'}</td>
      <td>${row.status || 'pending'}</td>
      <td>${row.code || row.linkCode || '-'}</td>
    </tr>`).join('');
  document.getElementById('linksTable').innerHTML = linksRows || '<tr><td colspan="4">Sem solicitações pendentes.</td></tr>';
}

document.getElementById('refreshBtn').onclick = () => loadStatus().catch(console.error);
document.getElementById('workerBtn').onclick = async () => {
  await fetch('/api/admin/run-worker', { method: 'POST' });
  await loadStatus();
};

loadStatus().catch(console.error);
setInterval(() => loadStatus().catch(console.error), 10000);
</script>
</body>
</html>`);
});

setInterval(() => {
  runWorkerOnce().catch((err) => addLog('error', 'Worker loop falhou.', { error: err.message }));
}, WORKER_INTERVAL_MS);

app.listen(PORT, () => {
  addLog('info', `Backend iniciado na porta ${PORT}.`);
});
