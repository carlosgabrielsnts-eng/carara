require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = Number(process.env.PORT || 3000);
const APP_NAME = process.env.APP_NAME || 'Argos RJ Backend';
const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://argosrj.netlify.app').replace(/\/+$/,'');
const DISCORD_CLIENT_ID = (process.env.DISCORD_CLIENT_ID || '').trim();
const DISCORD_CLIENT_SECRET = (process.env.DISCORD_CLIENT_SECRET || '').trim();
const DISCORD_REDIRECT_URI = (process.env.DISCORD_REDIRECT_URI || 'http://argosrj.netlify.app/auth/discord/callback').trim();
const FIREBASE_DATABASE_URL = (process.env.FIREBASE_DATABASE_URL || '').trim();
const MP_ACCESS_TOKEN = (process.env.MP_ACCESS_TOKEN || '').trim();
const MP_WEBHOOK_SECRET = (process.env.MP_WEBHOOK_SECRET || '').trim();
const WORKER_INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS || 15000);

const runtime = {
  startedAt: new Date().toISOString(),
  logs: [],
  worker: { running:false, lastRunAt:null, lastError:null, lastSummary:null }
};

function addLog(level, message, extra=null){
  const row = { time:new Date().toISOString(), level, message, extra };
  runtime.logs.unshift(row);
  if(runtime.logs.length > 250) runtime.logs.pop();
  const line = `[${row.time}] [${level.toUpperCase()}] ${message}${extra ? ' ' + JSON.stringify(extra) : ''}`;
  if(level === 'error') console.error(line); else console.log(line);
}

function escapeHtml(value=''){
  return String(value)
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#39;");
}

function readServiceAccount(){
  const fileCandidates = [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    process.env.SERVICE_ACCOUNT_FILE,
    '/etc/secrets/serviceAccount.json',
    path.join(__dirname, 'serviceAccount.json')
  ].filter(Boolean);

  for(const file of fileCandidates){
    try{
      if(fs.existsSync(file)){
        return { json: JSON.parse(fs.readFileSync(file, 'utf8')), source:file };
      }
    }catch(err){
      addLog('error', 'Falha ao ler service account file', { file, error: err.message });
    }
  }

  if(process.env.FIREBASE_SERVICE_ACCOUNT_JSON){
    try{
      return { json: JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON), source:'FIREBASE_SERVICE_ACCOUNT_JSON' };
    }catch(err){
      addLog('error', 'FIREBASE_SERVICE_ACCOUNT_JSON inválido', { error: err.message });
    }
  }

  return null;
}

const firebaseState = { connected:false, source:null, db:null };
try{
  const sa = readServiceAccount();
  if(sa && FIREBASE_DATABASE_URL){
    admin.initializeApp({
      credential: admin.credential.cert(sa.json),
      databaseURL: FIREBASE_DATABASE_URL
    });
    firebaseState.connected = true;
    firebaseState.source = sa.source;
    firebaseState.db = admin.database();
    addLog('info', 'Firebase Admin conectado', { source: sa.source });
  }else{
    addLog('warn', 'Firebase Admin pendente', { hasServiceAccount: !!sa, hasDatabaseUrl: !!FIREBASE_DATABASE_URL });
  }
}catch(err){
  addLog('error', 'Erro ao iniciar Firebase Admin', { error: err.message });
}

async function dbGet(refPath){
  if(!firebaseState.connected) return null;
  const snap = await firebaseState.db.ref(refPath).get();
  return snap.exists() ? snap.val() : null;
}
async function dbSet(refPath, value){
  if(!firebaseState.connected) throw new Error('Firebase não conectado');
  await firebaseState.db.ref(refPath).set(value);
}
async function dbUpdate(refPath, value){
  if(!firebaseState.connected) throw new Error('Firebase não conectado');
  await firebaseState.db.ref(refPath).update(value);
}

async function apiFetch(url, options={}){
  const res = await fetch(url, options);
  const text = await res.text();
  let json = null;
  try{ json = JSON.parse(text); }catch{}
  return { res, text, json };
}

async function getDiscordAuthUrl(state, redirectUri){
  const authUrl = new URL('https://discord.com/oauth2/authorize');
  authUrl.searchParams.set('client_id', DISCORD_CLIENT_ID);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'identify email');
  authUrl.searchParams.set('redirect_uri', redirectUri || DISCORD_REDIRECT_URI);
  if(state) authUrl.searchParams.set('state', state);
  return String(authUrl);
}

async function exchangeDiscordCode(code, redirectUri){
  const body = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    client_secret: DISCORD_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri || DISCORD_REDIRECT_URI
  });

  const tokenRes = await apiFetch('https://discord.com/api/v10/oauth2/token', {
    method:'POST',
    headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
    body
  });

  if(!tokenRes.res.ok || !tokenRes.json?.access_token){
    throw new Error(`Discord token error: ${tokenRes.text}`);
  }

  const meRes = await apiFetch('https://discord.com/api/v10/users/@me', {
    headers:{ Authorization:`Bearer ${tokenRes.json.access_token}` }
  });
  if(!meRes.res.ok || !meRes.json?.id){
    throw new Error(`Discord user error: ${meRes.text}`);
  }

  const me = meRes.json;
  return {
    access_token: tokenRes.json.access_token,
    user: {
      id: me.id,
      username: me.username,
      global_name: me.global_name || me.username,
      email: me.email || '',
      discriminator: me.discriminator || me.id,
      avatar_url: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=256` : ''
    }
  };
}

async function createPixPayment(order){
  const payload = {
    transaction_amount: Number(order.total || 0),
    description: order.description || `Pedido Argos RJ ${order.orderId}`,
    payment_method_id: 'pix',
    payer: {
      email: order.buyerEmail || 'comprador@argosrj.local',
      first_name: order.discordUsername || 'Player',
      last_name: 'Argos'
    },
    external_reference: order.orderId,
    notification_url: process.env.MP_WEBHOOK_URL || undefined
  };

  return apiFetch('https://api.mercadopago.com/v1/payments', {
    method:'POST',
    headers:{
      Authorization:`Bearer ${MP_ACCESS_TOKEN}`,
      'Content-Type':'application/json',
      'X-Idempotency-Key': `argos_${order.discordId}_${order.orderId}`
    },
    body: JSON.stringify(payload)
  });
}

function paymentFieldsFromMp(mp){
  const tx = mp?.point_of_interaction?.transaction_data || mp?.transaction_data || {};
  return {
    id: mp?.id || null,
    status: mp?.status || null,
    status_detail: mp?.status_detail || null,
    qr_code: tx?.qr_code || null,
    qr_code_base64: tx?.qr_code_base64 || null,
    ticket_url: tx?.ticket_url || null,
    date_of_expiration: mp?.date_of_expiration || null,
    updatedAt: new Date().toISOString()
  };
}

async function processOrdersWorker(){
  runtime.worker.running = true;
  runtime.worker.lastRunAt = new Date().toISOString();
  let checked = 0, generated = 0, skipped = 0, failures = 0;
  try{
    const siteOrders = await dbGet('siteOrders');
    if(!siteOrders || typeof siteOrders !== 'object'){
      runtime.worker.lastSummary = { checked, generated, skipped, failures, message:'Sem pedidos no Firebase' };
      return runtime.worker.lastSummary;
    }

    for(const [discordId, bucket] of Object.entries(siteOrders)){
      if(!bucket || typeof bucket !== 'object') continue;
      for(const [orderId, order] of Object.entries(bucket)){
        checked += 1;
        const orderStatus = String(order?.status || 'pending').toLowerCase();
        if(order?.payment?.id || ['approved','paid'].includes(orderStatus)){
          skipped += 1;
          continue;
        }
        if(!MP_ACCESS_TOKEN){
          skipped += 1;
          await dbUpdate(`siteOrders/${discordId}/${orderId}`, {
            backendStatus:'missing_mp_token',
            updatedAt: new Date().toISOString()
          });
          continue;
        }

        const mpRes = await createPixPayment({ ...order, discordId, orderId });
        if(!mpRes.res.ok){
          failures += 1;
          addLog('error', 'Mercado Pago recusou criação do pagamento', { discordId, orderId, status: mpRes.res.status, body: mpRes.json || mpRes.text });
          await dbUpdate(`siteOrders/${discordId}/${orderId}`, {
            backendStatus:'mp_error',
            backendError: mpRes.json || mpRes.text,
            updatedAt: new Date().toISOString()
          });
          continue;
        }

        await dbUpdate(`siteOrders/${discordId}/${orderId}`, {
          status: mpRes.json?.status || 'pending',
          backendStatus:'pix_generated',
          payment: paymentFieldsFromMp(mpRes.json),
          updatedAt: new Date().toISOString()
        });
        generated += 1;
      }
    }

    runtime.worker.lastSummary = { checked, generated, skipped, failures };
    addLog('info', 'Worker concluído', runtime.worker.lastSummary);
    return runtime.worker.lastSummary;
  }catch(err){
    failures += 1;
    runtime.worker.lastError = err.message;
    runtime.worker.lastSummary = { checked, generated, skipped, failures, error: err.message };
    addLog('error', 'Erro no worker', { error: err.message });
    return runtime.worker.lastSummary;
  }finally{
    runtime.worker.running = false;
  }
}

setInterval(() => {
  processOrdersWorker().catch(err => addLog('error', 'Loop do worker falhou', { error: err.message }));
}, WORKER_INTERVAL_MS);

async function collectStats(){
  const users = await dbGet('siteUsers');
  const orders = await dbGet('siteOrders');

  const usersCount = users && typeof users === 'object' ? Object.keys(users).length : 0;
  let ordersCount = 0;
  const recentOrders = [];
  if(orders && typeof orders === 'object'){
    for(const [discordId, bucket] of Object.entries(orders)){
      if(!bucket || typeof bucket !== 'object') continue;
      for(const [orderId, order] of Object.entries(bucket)){
        ordersCount += 1;
        recentOrders.push({
          discordId, orderId,
          total: Number(order.total || 0),
          status: order.payment?.status || order.status || 'pending',
          createdAt: order.createdAt || null
        });
      }
    }
  }

  recentOrders.sort((a,b)=> new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return { usersCount, ordersCount, recentOrders: recentOrders.slice(0, 12) };
}

function pageTemplate(title, body){
  return `<!doctype html>
  <html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      :root{--bg:#0b0d11;--card:#131923;--line:#263043;--text:#eef4ff;--muted:#93a0b8;--brand:#cda45e;--ok:#34c07b;--warn:#efb34a;--bad:#ff7373}
      *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#131824 0,#0b0d11 55%);color:var(--text);font:16px/1.45 Inter,system-ui,Arial,sans-serif}
      .wrap{width:min(1200px,calc(100% - 32px));margin:0 auto;padding:24px 0 42px}
      .top{display:flex;justify-content:space-between;gap:16px;align-items:center;flex-wrap:wrap}
      .brand{font-weight:800;font-size:1.3rem}.small{color:var(--muted)} .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
      .card{background:linear-gradient(180deg,rgba(255,255,255,.03),rgba(255,255,255,.015));border:1px solid rgba(255,255,255,.06);border-radius:22px;padding:18px}
      .status{display:inline-flex;align-items:center;padding:8px 10px;border-radius:999px;font-size:.95rem}
      .success{background:rgba(52,192,123,.12);color:#b7f1d2}.warning{background:rgba(239,179,74,.12);color:#ffe0a8}.danger{background:rgba(255,115,115,.12);color:#ffd3d3}
      table{width:100%;border-collapse:collapse}th,td{padding:12px 10px;border-bottom:1px solid rgba(255,255,255,.06);text-align:left}th{color:var(--muted);font-weight:600}
      a.btn,button.btn{display:inline-flex;padding:12px 15px;border-radius:14px;background:linear-gradient(135deg,var(--brand),#e1bf84);color:#111;text-decoration:none;font-weight:800;border:0}
      .logs{max-height:420px;overflow:auto;background:#0c1118;border-radius:18px;padding:12px;border:1px solid rgba(255,255,255,.06)}
      .log{padding:8px 0;border-bottom:1px solid rgba(255,255,255,.05)}
      @media(max-width:980px){.grid{grid-template-columns:1fr}}
    </style>
  </head><body><div class="wrap">${body}</div></body></html>`;
}

app.get('/', async (req, res) => {
  const stats = firebaseState.connected ? await collectStats() : { usersCount:0, ordersCount:0, recentOrders:[] };
  const body = `
    <div class="top">
      <div><div class="brand">${escapeHtml(APP_NAME)}</div><div class="small">Página inicial útil, sem "Cannot GET /".</div></div>
      <div><a class="btn" href="/admin">Abrir admin</a></div>
    </div>
    <div style="height:18px"></div>
    <div class="grid">
      <div class="card"><div class="small">Firebase</div><h2>${firebaseState.connected ? 'Conectado' : 'Pendente'}</h2><div class="${firebaseState.connected ? 'status success':'status warning'}">${firebaseState.connected ? escapeHtml(firebaseState.source || 'service account') : 'Configuração ausente'}</div></div>
      <div class="card"><div class="small">Mercado Pago</div><h2>${MP_ACCESS_TOKEN ? 'Configurado' : 'Pendente'}</h2><div class="${MP_ACCESS_TOKEN ? 'status success':'status warning'}">${MP_ACCESS_TOKEN ? 'Token secreto presente' : 'MP_ACCESS_TOKEN ausente'}</div></div>
      <div class="card"><div class="small">Usuários</div><h2>${stats.usersCount}</h2><div class="small">siteUsers</div></div>
      <div class="card"><div class="small">Pedidos</div><h2>${stats.ordersCount}</h2><div class="small">siteOrders</div></div>
    </div>
    <div style="height:18px"></div>
    <div class="card">
      <h3>Rotas principais</h3>
      <table><tr><th>Rota</th><th>Função</th></tr>
        <tr><td>/admin</td><td>Painel visual com monitoramento</td></tr>
        <tr><td>/api/health</td><td>Healthcheck do backend</td></tr>
        <tr><td>/auth/discord/url</td><td>URL segura do login Discord</td></tr>
        <tr><td>/auth/discord/exchange</td><td>Troca do code por usuário</td></tr>
        <tr><td>/webhooks/mercadopago</td><td>Recebe notificações do Mercado Pago</td></tr>
      </table>
    </div>`;
  res.type('html').send(pageTemplate(APP_NAME, body));
});

app.get('/admin', async (req, res) => {
  const stats = firebaseState.connected ? await collectStats() : { usersCount:0, ordersCount:0, recentOrders:[] };
  const logsHtml = runtime.logs.map(row => `<div class="log"><strong>[${escapeHtml(row.level.toUpperCase())}]</strong> ${escapeHtml(row.message)}<div class="small">${escapeHtml(row.time)} ${row.extra ? '• ' + escapeHtml(JSON.stringify(row.extra)) : ''}</div></div>`).join('');
  const ordersHtml = stats.recentOrders.map(row => `<tr><td>${escapeHtml(row.orderId)}</td><td>${escapeHtml(row.discordId)}</td><td>${escapeHtml(String(row.status))}</td><td>R$ ${Number(row.total).toFixed(2)}</td><td>${escapeHtml(row.createdAt || '—')}</td></tr>`).join('');
  const body = `
    <div class="top">
      <div><div class="brand">/admin • ${escapeHtml(APP_NAME)}</div><div class="small">Monitoramento do backend, Firebase, Mercado Pago, pedidos e worker.</div></div>
      <div class="small">Iniciado em ${escapeHtml(runtime.startedAt)}</div>
    </div>
    <div style="height:18px"></div>
    <div class="grid">
      <div class="card"><div class="small">Firebase</div><h2>${firebaseState.connected ? 'Conectado' : 'Pendente'}</h2><div class="${firebaseState.connected ? 'status success':'status warning'}">${firebaseState.connected ? escapeHtml(firebaseState.source || 'ok') : 'service account/databaseURL ausente'}</div></div>
      <div class="card"><div class="small">Mercado Pago</div><h2>${MP_ACCESS_TOKEN ? 'OK' : 'Pendente'}</h2><div class="${MP_ACCESS_TOKEN ? 'status success':'status warning'}">${MP_ACCESS_TOKEN ? 'MP_ACCESS_TOKEN detectado' : 'Sem token'}</div></div>
      <div class="card"><div class="small">Worker</div><h2>${runtime.worker.lastRunAt ? 'Ativo' : 'Aguardando'}</h2><div class="small">Última execução: ${escapeHtml(runtime.worker.lastRunAt || '—')}</div><div class="small">Resumo: ${escapeHtml(JSON.stringify(runtime.worker.lastSummary || {}))}</div></div>
      <div class="card"><div class="small">Frontend</div><h2>${escapeHtml(FRONTEND_URL)}</h2><div class="small">Callback Discord: ${escapeHtml(DISCORD_REDIRECT_URI)}</div></div>
    </div>
    <div style="height:18px"></div>
    <div class="card">
      <h3>Pedidos recentes</h3>
      <table><thead><tr><th>Order ID</th><th>Discord ID</th><th>Status</th><th>Total</th><th>Criado em</th></tr></thead><tbody>${ordersHtml || '<tr><td colspan="5">Sem pedidos ainda.</td></tr>'}</tbody></table>
    </div>
    <div style="height:18px"></div>
    <div class="card">
      <h3>Logs</h3>
      <div class="logs">${logsHtml || '<div class="small">Sem logs ainda.</div>'}</div>
    </div>`;
  res.type('html').send(pageTemplate(`${APP_NAME} /admin`, body));
});

app.get('/api/health', async (req, res) => {
  let stats = { usersCount:0, ordersCount:0 };
  if(firebaseState.connected){
    const s = await collectStats();
    stats.usersCount = s.usersCount;
    stats.ordersCount = s.ordersCount;
  }
  res.json({
    ok: true,
    app: APP_NAME,
    startedAt: runtime.startedAt,
    frontendUrl: FRONTEND_URL,
    firebase: {
      connected: firebaseState.connected,
      source: firebaseState.source,
      hasDatabaseUrl: !!FIREBASE_DATABASE_URL
    },
    mercadoPago: {
      configured: !!MP_ACCESS_TOKEN
    },
    worker: runtime.worker,
    stats
  });
});

app.get('/api/server/status', async (req, res) => {
  res.json({
    ok: true,
    serverName: 'Argos RJ',
    online: true,
    loginMode: 'Discord',
    backend: req.protocol + '://' + req.get('host')
  });
});

app.get('/auth/discord/url', async (req, res) => {
  if(!DISCORD_CLIENT_ID){
    return res.status(400).json({ error:'DISCORD_CLIENT_ID não configurado no backend.' });
  }
  const state = String(req.query.state || '');
  const redirectUri = String(req.query.redirect_uri || DISCORD_REDIRECT_URI);
  const url = await getDiscordAuthUrl(state, redirectUri);
  res.json({ url, redirectUri });
});

app.post('/auth/discord/exchange', async (req, res) => {
  try{
    if(!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET){
      return res.status(400).json({ error:'Credenciais do Discord não configuradas no backend.' });
    }
    const code = String(req.body.code || '');
    const redirectUri = String(req.body.redirect_uri || DISCORD_REDIRECT_URI);
    if(!code) return res.status(400).json({ error:'code ausente' });

    const auth = await exchangeDiscordCode(code, redirectUri);
    addLog('info', 'Login Discord concluído', { discordId: auth.user.id, username: auth.user.username });
    res.json({ ok:true, user: auth.user });
  }catch(err){
    addLog('error', 'Falha no exchange do Discord', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/process-now', async (req, res) => {
  try{
    const summary = await processOrdersWorker();
    res.json({ ok:true, summary });
  }catch(err){
    res.status(500).json({ ok:false, error: err.message });
  }
});

app.post('/webhooks/mercadopago', async (req, res) => {
  try{
    addLog('info', 'Webhook Mercado Pago recebido', { body: req.body });

    const topic = req.body.type || req.body.topic;
    const paymentId = req.body.data?.id || req.body.id;

    if(topic && paymentId && MP_ACCESS_TOKEN){
      const paymentRes = await apiFetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { Authorization:`Bearer ${MP_ACCESS_TOKEN}` }
      });

      if(paymentRes.res.ok && paymentRes.json){
        const mp = paymentRes.json;
        const externalRef = mp.external_reference;
        const siteOrders = await dbGet('siteOrders');
        if(siteOrders && externalRef){
          for(const [discordId, bucket] of Object.entries(siteOrders)){
            if(!bucket || typeof bucket !== 'object') continue;
            for(const [orderId, order] of Object.entries(bucket)){
              if(orderId === externalRef || order?.orderId === externalRef){
                await dbUpdate(`siteOrders/${discordId}/${orderId}`, {
                  status: mp.status || order.status || 'pending',
                  payment: paymentFieldsFromMp(mp),
                  updatedAt: new Date().toISOString()
                });
                addLog('info', 'Pedido atualizado por webhook', { discordId, orderId, paymentId });
              }
            }
          }
        }
      }
    }

    res.json({ ok:true });
  }catch(err){
    addLog('error', 'Erro no webhook Mercado Pago', { error: err.message });
    res.status(500).json({ ok:false, error: err.message });
  }
});

app.use((req, res) => {
  res.status(404).type('html').send(pageTemplate('404', `
    <div class="card"><h1>404</h1><p class="small">Rota não encontrada.</p><p><a class="btn" href="/">Voltar para a raiz</a></p></div>
  `));
});

app.listen(PORT, () => {
  addLog('info', `${APP_NAME} rodando`, { port: PORT });
});