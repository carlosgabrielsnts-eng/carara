
require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);
const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || '';
const WORKER_INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS || 15000);
const MP_ACCESS_TOKEN = (process.env.MP_ACCESS_TOKEN || '').trim();
const MP_PUBLIC_KEY = (process.env.MP_PUBLIC_KEY || '').trim();
const MP_WEBHOOK_URL = (process.env.MP_WEBHOOK_URL || '').trim();

const logs = [];
function addLog(level, message, extra) {
  const row = { time: new Date().toISOString(), level, message, extra: extra || null };
  logs.unshift(row);
  if (logs.length > 300) logs.pop();
  const text = `[${row.time}] [${level.toUpperCase()}] ${message}${extra ? ' ' + JSON.stringify(extra) : ''}`;
  if (level === 'error') console.error(text);
  else console.log(text);
}

function readServiceAccount() {
  const candidates = [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    process.env.SERVICE_ACCOUNT_FILE,
    '/etc/secrets/serviceAccount.json',
    path.join(__dirname, 'serviceAccount.json')
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        return { json: JSON.parse(fs.readFileSync(p, 'utf8')), source: p };
      }
    } catch (err) {
      addLog('error', 'Falha ao ler service account', { path: p, error: err.message });
    }
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      return { json: JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON), source: 'FIREBASE_SERVICE_ACCOUNT_JSON' };
    } catch (err) {
      addLog('error', 'FIREBASE_SERVICE_ACCOUNT_JSON inválido', { error: err.message });
    }
  }
  return null;
}

let firebaseReady = false;
let firebaseSource = null;
let db = null;

try {
  const sa = readServiceAccount();
  if (sa && FIREBASE_DATABASE_URL) {
    admin.initializeApp({
      credential: admin.credential.cert(sa.json),
      databaseURL: FIREBASE_DATABASE_URL
    });
    db = admin.database();
    firebaseReady = true;
    firebaseSource = sa.source;
    addLog('info', 'Firebase Admin conectado.', { source: firebaseSource });
  } else {
    addLog('warn', 'Firebase Admin não iniciado.', {
      hasServiceAccount: !!sa,
      hasDatabaseUrl: !!FIREBASE_DATABASE_URL
    });
  }
} catch (err) {
  addLog('error', 'Erro ao iniciar Firebase Admin.', { error: err.message });
}

let worker = {
  running: false,
  lastRunAt: null,
  lastError: null,
  lastSummary: null
};

async function mpFetch(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { response, text, json };
}

async function createPixPayment(order) {
  const idempotency = `argos_${order.discordId}_${order.orderId}`;
  const payload = {
    transaction_amount: Number(order.total || order.amount || order.price || 0),
    description: order.description || `Pedido Argos RJ #${order.orderId}`,
    payment_method_id: 'pix',
    payer: {
      email: order.email || 'comprador@argosrj.local',
      first_name: order.first_name || 'Player',
      last_name: order.last_name || 'Argos'
    },
    external_reference: order.orderId,
    notification_url: MP_WEBHOOK_URL || undefined
  };

  return mpFetch('https://api.mercadopago.com/v1/payments', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': idempotency
    },
    body: JSON.stringify(payload)
  });
}

async function getValue(refPath) {
  if (!firebaseReady) return null;
  const snap = await db.ref(refPath).get();
  return snap.exists() ? snap.val() : null;
}

async function setValue(refPath, value) {
  if (!firebaseReady) throw new Error('Firebase não conectado');
  await db.ref(refPath).set(value);
}

async function updateValue(refPath, value) {
  if (!firebaseReady) throw new Error('Firebase não conectado');
  await db.ref(refPath).update(value);
}

async function processPendingOrders() {
  const siteOrders = await getValue('siteOrders');
  let created = 0, skipped = 0, checked = 0, approved = 0;

  if (!siteOrders || typeof siteOrders !== 'object') {
    return { created, skipped, checked, approved, message: 'Sem pedidos no banco.' };
  }

  for (const [discordId, bucket] of Object.entries(siteOrders)) {
    if (!bucket || typeof bucket !== 'object') continue;

    for (const [orderId, order] of Object.entries(bucket)) {
      checked += 1;
      const status = String(order.status || 'pending').toLowerCase();

      if (status === 'paid' || status === 'approved') {
        approved += 1;
        continue;
      }

      const hasPayment = !!(order.payment && order.payment.id);
      if (hasPayment) {
        skipped += 1;
        continue;
      }

      if (!MP_ACCESS_TOKEN) {
        skipped += 1;
        await updateValue(`siteOrders/${discordId}/${orderId}`, {
          backendStatus: 'missing_mp_token',
          updatedAt: new Date().toISOString()
        });
        continue;
      }

      const { response, text, json } = await createPixPayment({ ...order, discordId, orderId });

      if (!response.ok) {
        addLog('error', 'Mercado Pago recusou criação do pagamento.', {
          orderId, discordId, status: response.status, body: json || text.slice(0, 400)
        });
        await updateValue(`siteOrders/${discordId}/${orderId}`, {
          backendStatus: 'mp_error',
          backendError: json || text,
          updatedAt: new Date().toISOString()
        });
        continue;
      }

      const tx = json && json.point_of_interaction && json.point_of_interaction.transaction_data
        ? json.point_of_interaction.transaction_data
        : (json && json.transaction_data ? json.transaction_data : null);

      await updateValue(`siteOrders/${discordId}/${orderId}`, {
        status: json.status || 'pending',
        backendStatus: 'pix_generated',
        payment: {
          id: json.id || null,
          status: json.status || null,
          status_detail: json.status_detail || null,
          qr_code: tx ? tx.qr_code || null : null,
          qr_code_base64: tx ? tx.qr_code_base64 || null : null,
          ticket_url: tx ? tx.ticket_url || null : null,
          date_of_expiration: json.date_of_expiration || null,
          public_key_present: !!MP_PUBLIC_KEY,
          createdAt: new Date().toISOString()
        },
        updatedAt: new Date().toISOString()
      });

      addLog('info', 'PIX gerado para pedido.', { discordId, orderId, paymentId: json.id });
      created += 1;
    }
  }

  return { created, skipped, checked, approved };
}

async function countUsersAndOrders() {
  const users = await getValue('siteUsers');
  const orders = await getValue('siteOrders');
  let usersCount = users && typeof users === 'object' ? Object.keys(users).length : 0;
  let ordersCount = 0;
  if (orders && typeof orders === 'object') {
    for (const bucket of Object.values(orders)) {
      if (bucket && typeof bucket === 'object') ordersCount += Object.keys(bucket).length;
    }
  }
  return { usersCount, ordersCount };
}

async function runWorker() {
  worker.running = true;
  worker.lastRunAt = new Date().toISOString();
  worker.lastError = null;
  try {
    if (!firebaseReady) {
      worker.lastSummary = { message: 'Firebase não conectado.' };
      return;
    }
    const orderSummary = await processPendingOrders();
    const counts = await countUsersAndOrders();
    worker.lastSummary = { ...orderSummary, ...counts };
  } catch (err) {
    worker.lastError = err.message;
    addLog('error', 'Worker falhou.', { error: err.message });
  } finally {
    worker.running = false;
  }
}

app.get('/', (req, res) => res.redirect('/admin'));

app.get('/api/health', async (req, res) => {
  const counts = firebaseReady ? await countUsersAndOrders() : { usersCount: null, ordersCount: null };
  res.json({
    ok: true,
    backendOnline: true,
    firebaseReady,
    firebaseSource,
    firebaseDatabaseUrlConfigured: !!FIREBASE_DATABASE_URL,
    mercadoPagoConfigured: !!MP_ACCESS_TOKEN,
    mercadoPagoPublicKeyConfigured: !!MP_PUBLIC_KEY,
    worker,
    counts,
    callbackHint: 'Use o frontend Netlify para login/auth. Este backend gera PIX e grava no Firebase.',
    logs: logs.slice(0, 50)
  });
});

app.get('/api/admin/status', async (req, res) => {
  const counts = firebaseReady ? await countUsersAndOrders() : { usersCount: null, ordersCount: null };
  let recentOrders = [];
  if (firebaseReady) {
    const allOrders = await getValue('siteOrders');
    if (allOrders && typeof allOrders === 'object') {
      for (const [discordId, bucket] of Object.entries(allOrders)) {
        if (!bucket || typeof bucket !== 'object') continue;
        for (const [orderId, order] of Object.entries(bucket)) {
          recentOrders.push({ discordId, orderId, ...(order || {}) });
        }
      }
      recentOrders = recentOrders.slice(0, 20);
    }
  }
  res.json({
    ok: true,
    backendOnline: true,
    firebaseReady,
    firebaseSource,
    firebaseDatabaseUrlConfigured: !!FIREBASE_DATABASE_URL,
    mercadoPagoConfigured: !!MP_ACCESS_TOKEN,
    mercadoPagoPublicKeyConfigured: !!MP_PUBLIC_KEY,
    worker,
    counts,
    recentOrders,
    logs: logs.slice(0, 80)
  });
});

app.post('/api/admin/run-worker', async (req, res) => {
  await runWorker();
  res.json({ ok: true, worker });
});

app.post('/api/mercadopago/webhook', async (req, res) => {
  try {
    addLog('info', 'Webhook Mercado Pago recebido.', { body: req.body });
    const dataId = req.body && req.body.data && req.body.data.id ? String(req.body.data.id) : null;
    const topic = req.body && (req.body.type || req.body.topic) ? String(req.body.type || req.body.topic) : null;

    if (!dataId || !(topic === 'payment' || topic === 'payments')) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    if (!MP_ACCESS_TOKEN) {
      return res.status(200).json({ ok: true, ignored: true, reason: 'missing_mp_token' });
    }

    const { response, text, json } = await mpFetch(`https://api.mercadopago.com/v1/payments/${dataId}`, {
      headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` }
    });

    if (!response.ok) {
      addLog('error', 'Falha ao consultar pagamento do webhook.', { paymentId: dataId, status: response.status, body: json || text });
      return res.status(200).json({ ok: true, ignored: true, reason: 'payment_lookup_failed' });
    }

    const externalRef = json.external_reference || null;
    if (!externalRef || !firebaseReady) {
      return res.status(200).json({ ok: true, ignored: true, reason: 'missing_external_reference_or_firebase' });
    }

    const siteOrders = await getValue('siteOrders');
    if (siteOrders && typeof siteOrders === 'object') {
      for (const [discordId, bucket] of Object.entries(siteOrders)) {
        if (!bucket || typeof bucket !== 'object') continue;
        if (bucket[externalRef]) {
          await updateValue(`siteOrders/${discordId}/${externalRef}`, {
            status: json.status || bucket[externalRef].status || 'pending',
            payment: {
              ...(bucket[externalRef].payment || {}),
              id: json.id || null,
              status: json.status || null,
              status_detail: json.status_detail || null,
              updatedAt: new Date().toISOString()
            },
            updatedAt: new Date().toISOString()
          });
          addLog('info', 'Pedido atualizado via webhook.', { discordId, orderId: externalRef, status: json.status });
          break;
        }
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    addLog('error', 'Erro no webhook Mercado Pago.', { error: err.message });
    return res.status(200).json({ ok: true, ignored: true });
  }
});

app.get('/admin', (req, res) => {
  res.send(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Argos RJ • PIX Backend</title>
<style>
:root{
  --bg:#0b1020;--panel:#11192d;--panel2:#0f1728;--line:rgba(255,255,255,.08);
  --text:#eef3ff;--muted:#aab6d3;--accent:#ff8c2f;--ok:#29d17d;--bad:#ff5f6d;--warn:#ffd166;
}
*{box-sizing:border-box}
body{margin:0;font-family:Inter,Arial,sans-serif;background:
radial-gradient(circle at top right, rgba(53,86,173,.35), transparent 30%),
radial-gradient(circle at top left, rgba(255,140,47,.12), transparent 25%),var(--bg);color:var(--text)}
.top{display:flex;justify-content:space-between;align-items:center;padding:20px 28px;border-bottom:1px solid var(--line);background:rgba(11,16,32,.88);position:sticky;top:0}
.wrap{max-width:1320px;margin:0 auto;padding:28px}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px;margin-bottom:18px}
.card{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--line);border-radius:20px;padding:20px;box-shadow:0 18px 50px rgba(0,0,0,.25)}
.big{font-size:26px;font-weight:800}
.muted{color:var(--muted)}
.pre{white-space:pre-wrap;word-break:break-word;background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:14px;padding:14px;max-height:420px;overflow:auto}
.toolbar{display:flex;gap:10px}
.btn{background:var(--accent);color:#1a120b;border:0;padding:12px 16px;border-radius:12px;font-weight:800;cursor:pointer}
.btn.alt{background:rgba(255,255,255,.06);color:var(--text);border:1px solid var(--line)}
table{width:100%;border-collapse:collapse}
th,td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;font-size:14px;vertical-align:top}
th{color:var(--muted)}
.scroll{max-height:480px;overflow:auto}
@media (max-width:1100px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:700px){.grid{grid-template-columns:1fr}.top,.wrap{padding:16px}}
</style>
</head>
<body>
  <div class="top">
    <div>
      <div style="font-size:24px;font-weight:800">Argos RJ • Backend PIX</div>
      <div class="muted">Mercado Pago + Firebase + monitoramento</div>
    </div>
    <div class="toolbar">
      <button class="btn alt" id="refreshBtn">Atualizar</button>
      <button class="btn" id="workerBtn">Rodar worker</button>
    </div>
  </div>

  <div class="wrap">
    <div class="grid">
      <div class="card"><div class="muted">Backend</div><div id="backendBox" class="big">--</div></div>
      <div class="card"><div class="muted">Firebase</div><div id="firebaseBox" class="big">--</div></div>
      <div class="card"><div class="muted">Mercado Pago</div><div id="mpBox" class="big">--</div></div>
      <div class="card"><div class="muted">Pedidos</div><div id="ordersBox" class="big">--</div></div>
    </div>

    <div class="card" style="margin-bottom:18px">
      <div style="font-size:18px;font-weight:800;margin-bottom:10px">Worker</div>
      <div id="workerBox" class="pre">Carregando...</div>
    </div>

    <div class="card" style="margin-bottom:18px">
      <div style="font-size:18px;font-weight:800;margin-bottom:10px">Pedidos recentes</div>
      <div class="scroll">
        <table>
          <thead><tr><th>Discord</th><th>Pedido</th><th>Status</th><th>Valor</th><th>Pagamento</th></tr></thead>
          <tbody id="ordersTable"><tr><td colspan="5">Carregando...</td></tr></tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div style="font-size:18px;font-weight:800;margin-bottom:10px">Logs</div>
      <div id="logsBox" class="pre">Carregando...</div>
    </div>
  </div>

<script>
async function loadStatus(){
  const res = await fetch('/api/admin/status');
  const data = await res.json();

  document.getElementById('backendBox').textContent = data.backendOnline ? 'ONLINE' : 'OFF';
  document.getElementById('firebaseBox').textContent = data.firebaseReady ? 'CONECTADO' : 'FALHOU';
  document.getElementById('mpBox').textContent = data.mercadoPagoConfigured ? 'TOKEN OK' : 'FALTA TOKEN';
  document.getElementById('ordersBox').textContent = (data.counts && data.counts.ordersCount != null) ? data.counts.ordersCount : '--';
  document.getElementById('workerBox').textContent = JSON.stringify(data.worker, null, 2);
  document.getElementById('logsBox').textContent = (data.logs || []).map(l => '[' + l.time + '] [' + l.level.toUpperCase() + '] ' + l.message + (l.extra ? ' ' + JSON.stringify(l.extra) : '')).join('\\n') || 'Sem logs.';

  const rows = (data.recentOrders || []).map(row => {
    const pay = row.payment && row.payment.id ? `PIX ${row.payment.id}` : '-';
    const total = row.total || row.amount || row.price || '-';
    return `<tr>
      <td>${row.discordId || '-'}</td>
      <td>${row.orderId || '-'}</td>
      <td>${row.status || '-'}</td>
      <td>${total}</td>
      <td>${pay}</td>
    </tr>`;
  }).join('');
  document.getElementById('ordersTable').innerHTML = rows || '<tr><td colspan="5">Sem pedidos.</td></tr>';
}

document.getElementById('refreshBtn').onclick = () => loadStatus();
document.getElementById('workerBtn').onclick = async () => {
  await fetch('/api/admin/run-worker', { method: 'POST' });
  await loadStatus();
};

loadStatus();
setInterval(loadStatus, 10000);
</script>
</body>
</html>`);
});

setInterval(() => {
  runWorker().catch((err) => addLog('error', 'Worker loop falhou.', { error: err.message }));
}, WORKER_INTERVAL_MS);

app.listen(PORT, () => addLog('info', `Backend iniciado na porta ${PORT}.`));
