
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);
const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || '';
const SECRET_PATHS = [
  '/etc/secrets/serviceAccount.json',
  path.join(__dirname, 'serviceAccount.json')
];

const logs = [];
function addLog(level, message, extra) {
  const row = {
    time: new Date().toISOString(),
    level,
    message,
    extra: extra || null
  };
  logs.unshift(row);
  if (logs.length > 200) logs.pop();
  const txt = `[${row.time}] [${level.toUpperCase()}] ${message}${extra ? ' ' + JSON.stringify(extra) : ''}`;
  if (level === 'error') console.error(txt);
  else console.log(txt);
}

function findSecretFile() {
  for (const p of SECRET_PATHS) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

function getStatus() {
  const secretFile = findSecretFile();
  return {
    ok: true,
    backendOnline: true,
    now: new Date().toISOString(),
    firebaseDatabaseUrlConfigured: !!FIREBASE_DATABASE_URL,
    serviceAccountFound: !!secretFile,
    serviceAccountPath: secretFile || null,
    routes: [
      '/',
      '/admin',
      '/api/health',
      '/api/admin/status'
    ],
    notes: [
      'Esta tela é só para monitoramento.',
      'O frontend fica na Netlify.',
      'Se o Firebase não aparecer como configurado, revise o Secret File no Render.'
    ],
    logs: logs.slice(0, 50)
  };
}

app.get('/', (req, res) => {
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Argos RJ Backend</title>
<style>
:root{--bg:#0b1020;--panel:#11192d;--panel2:#0f1728;--line:rgba(255,255,255,.08);--text:#eef3ff;--muted:#aab6d3;--accent:#ff8c2f;--ok:#29d17d;--bad:#ff5f6d}
*{box-sizing:border-box}
body{margin:0;font-family:Inter,Arial,sans-serif;background:
radial-gradient(circle at top right, rgba(53,86,173,.35), transparent 30%),
radial-gradient(circle at top left, rgba(255,140,47,.12), transparent 25%),var(--bg);color:var(--text)}
.wrap{max-width:1100px;margin:0 auto;padding:28px}
.hero,.card{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--line);border-radius:22px;box-shadow:0 18px 50px rgba(0,0,0,.25)}
.hero{padding:28px;margin-top:26px}
h1{margin:0 0 8px;font-size:30px}
p{color:var(--muted);line-height:1.6}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;margin-top:18px}
.card{padding:20px}
.label{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:10px}
.big{font-size:26px;font-weight:800}
.ok{color:var(--ok)} .bad{color:var(--bad)}
.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:18px}
a.btn{display:inline-block;text-decoration:none;background:var(--accent);color:#1a120b;padding:12px 16px;border-radius:12px;font-weight:800}
a.btn.alt{background:rgba(255,255,255,.06);color:var(--text);border:1px solid var(--line)}
.list{margin:0;padding-left:18px;color:var(--muted)}
@media (max-width:900px){.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <h1>Argos RJ • Backend Render</h1>
      <p>Esse backend é o painel de monitoramento. Ele não é o site do player. O site público fica na Netlify. Aqui você vê se o backend está online, se o Firebase está configurado e acessa os logs e o status.</p>
      <div class="actions">
        <a class="btn" href="/admin">Abrir painel admin</a>
        <a class="btn alt" href="/api/health">Ver health JSON</a>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <div class="label">Backend</div>
        <div class="big ok">ONLINE</div>
      </div>
      <div class="card">
        <div class="label">Firebase Database URL</div>
        <div class="big ${FIREBASE_DATABASE_URL ? 'ok' : 'bad'}">${FIREBASE_DATABASE_URL ? 'CONFIGURADO' : 'FALTA CONFIG'}</div>
      </div>
      <div class="card">
        <div class="label">Secret File</div>
        <div class="big ${findSecretFile() ? 'ok' : 'bad'}">${findSecretFile() ? 'ENCONTRADO' : 'NÃO ENCONTRADO'}</div>
      </div>
    </div>

    <div class="card" style="margin-top:18px">
      <div class="label">Observações</div>
      <ul class="list">
        <li>Se abrir <code>/</code>, essa tela precisa aparecer.</li>
        <li>Se não aparecer, o Render provavelmente está rodando um build antigo ou a pasta errada.</li>
        <li>Se quiser dados do Firebase, coloque o Secret File com nome <code>serviceAccount.json</code>.</li>
      </ul>
    </div>
  </div>
</body>
</html>`;
  res.send(html);
});

app.get('/admin', (req, res) => {
  res.send(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Argos RJ • Admin</title>
<style>
:root{--bg:#0b1020;--panel:#11192d;--panel2:#0f1728;--line:rgba(255,255,255,.08);--text:#eef3ff;--muted:#aab6d3;--accent:#ff8c2f;--ok:#29d17d;--bad:#ff5f6d}
*{box-sizing:border-box}
body{margin:0;font-family:Inter,Arial,sans-serif;background:
radial-gradient(circle at top right, rgba(53,86,173,.35), transparent 30%),
radial-gradient(circle at top left, rgba(255,140,47,.12), transparent 25%),var(--bg);color:var(--text)}
.top{display:flex;justify-content:space-between;align-items:center;padding:20px 28px;border-bottom:1px solid var(--line);background:rgba(11,16,32,.88);position:sticky;top:0}
.wrap{max-width:1250px;margin:0 auto;padding:28px}
.card{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--line);border-radius:20px;padding:20px;box-shadow:0 18px 50px rgba(0,0,0,.25)}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;margin-bottom:18px}
.big{font-size:26px;font-weight:800}
.muted{color:var(--muted)}
.pre{white-space:pre-wrap;word-break:break-word;background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:14px;padding:14px;max-height:420px;overflow:auto}
.btn{background:var(--accent);color:#1a120b;border:0;padding:12px 16px;border-radius:12px;font-weight:800;cursor:pointer}
@media (max-width:900px){.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
  <div class="top">
    <div>
      <div style="font-size:24px;font-weight:800">Argos RJ • Painel Admin</div>
      <div class="muted">Monitoramento do backend</div>
    </div>
    <div>
      <button class="btn" onclick="loadStatus()">Atualizar</button>
    </div>
  </div>

  <div class="wrap">
    <div class="grid">
      <div class="card">
        <div class="muted">Backend</div>
        <div id="backend" class="big">--</div>
      </div>
      <div class="card">
        <div class="muted">Firebase Database URL</div>
        <div id="dburl" class="big">--</div>
      </div>
      <div class="card">
        <div class="muted">Secret File</div>
        <div id="secret" class="big">--</div>
      </div>
    </div>

    <div class="card" style="margin-bottom:18px">
      <div style="font-size:18px;font-weight:800;margin-bottom:10px">Status completo</div>
      <div id="statusBox" class="pre">Carregando...</div>
    </div>

    <div class="card">
      <div style="font-size:18px;font-weight:800;margin-bottom:10px">Logs recentes</div>
      <div id="logsBox" class="pre">Carregando...</div>
    </div>
  </div>

<script>
async function loadStatus(){
  const res = await fetch('/api/admin/status');
  const data = await res.json();
  document.getElementById('backend').textContent = data.backendOnline ? 'ONLINE' : 'OFF';
  document.getElementById('dburl').textContent = data.firebaseDatabaseUrlConfigured ? 'CONFIGURADO' : 'FALTA CONFIG';
  document.getElementById('secret').textContent = data.serviceAccountFound ? 'ENCONTRADO' : 'NÃO ENCONTRADO';
  document.getElementById('statusBox').textContent = JSON.stringify(data, null, 2);
  document.getElementById('logsBox').textContent = (data.logs || []).map(l => '[' + l.time + '] [' + l.level.toUpperCase() + '] ' + l.message + (l.extra ? ' ' + JSON.stringify(l.extra) : '')).join('\\n') || 'Sem logs.';
}
loadStatus();
setInterval(loadStatus, 10000);
</script>
</body>
</html>`);
});

app.get('/api/health', (req, res) => {
  res.json(getStatus());
});

app.get('/api/admin/status', (req, res) => {
  res.json(getStatus());
});

app.listen(PORT, () => {
  addLog('info', `Backend iniciado na porta ${PORT}.`);
});
