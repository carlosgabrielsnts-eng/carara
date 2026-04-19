BACKEND ARGOS RJ (Render)

Este backend:
- responde em /
- tem painel em /admin
- healthcheck em /api/health
- gera URL do Discord em /auth/discord/url
- troca code do Discord em /auth/discord/exchange
- lê siteOrders do Firebase
- gera PIX/QR pelo Mercado Pago
- grava payment.id, payment.status, payment.qr_code, payment.qr_code_base64 e payment.ticket_url no Firebase
- aceita webhook do Mercado Pago em /webhooks/mercadopago

CONFIG NO RENDER
1) Start Command: npm start
2) Root Directory: backend
3) Environment Variables:
   - FRONTEND_URL
   - DISCORD_CLIENT_ID
   - DISCORD_CLIENT_SECRET
   - DISCORD_REDIRECT_URI
   - FIREBASE_DATABASE_URL
   - MP_ACCESS_TOKEN
   - MP_WEBHOOK_URL (opcional)
   - WORKER_INTERVAL_MS (opcional)
4) Firebase service account:
   - Secret File: /etc/secrets/serviceAccount.json
   OU
   - FIREBASE_SERVICE_ACCOUNT_JSON

IMPORTANTE
- O frontend NÃO usa segredo do Mercado Pago.
- O client secret do Discord fica só aqui.
- Se / mostrar "Cannot GET /", subiu backend antigo.
- Se Firebase não conectar, verifique FIREBASE_DATABASE_URL e service account.