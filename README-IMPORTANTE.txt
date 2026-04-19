ARGOS RJ BACKEND ADMIN MONITOR V2

Mudanças:
- "/" redireciona para "/admin"
- painel admin bonito com status, logs, pedidos e vínculos
- "/api/health" e "/api/admin/status"
- leitura automática do Secret File do Render em /etc/secrets/serviceAccount.json

Como configurar no Render:
1. Environment -> Secret Files
2. Filename: serviceAccount.json
3. Contents: cole o JSON COMPLETO original da conta de serviço do Firebase
4. Environment Variables:
   FIREBASE_DATABASE_URL=https://base-mods-97da8-default-rtdb.firebaseio.com
   PORT=3000
   WORKER_INTERVAL_MS=10000

Rotas:
- /
- /admin
- /api/health
- /api/admin/status

No frontend, use a callback:
http://argosrj.netlify.app/auth/discord/callback
