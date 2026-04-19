BACKEND ARGOS RJ - FIREBASE + MERCADO PAGO

Esse backend:
- lê o Firebase Admin por Secret File
- monitora pedidos em siteOrders/{discordId}/{orderId}
- gera PIX no Mercado Pago via backend
- grava qr_code, qr_code_base64 e payment.id no próprio Firebase
- expõe painel em /admin
- recebe webhook do Mercado Pago em /api/mercadopago/webhook

Estrutura esperada do pedido no Firebase:
siteOrders/{discordId}/{orderId} = {
  "status": "pending",
  "total": 19.90,
  "email": "cliente@email.com",
  "description": "Caixa Mythica",
  "items": [...]
}

O frontend deve:
1. criar o pedido no Firebase
2. esperar o backend gerar payment + QR
3. ler de volta do mesmo pedido:
   payment.qr_code
   payment.qr_code_base64
   payment.ticket_url

No Render:
- FIREBASE_DATABASE_URL
- MP_ACCESS_TOKEN
- MP_PUBLIC_KEY
- MP_WEBHOOK_URL
- Secret File: serviceAccount.json
