USE ESSE BACKEND NO RENDER

O que ele faz:
- "/" abre uma tela bonita
- "/admin" abre o painel admin
- "/api/health" mostra status em JSON
- "/api/admin/status" mostra status detalhado

Se continuar aparecendo 'Cannot GET /', então o Render ainda está rodando um projeto antigo ou a pasta errada.

No Render:
1. Suba esta pasta
2. Configure FIREBASE_DATABASE_URL
3. Em Secret Files, adicione:
   Nome: serviceAccount.json
   Conteúdo: JSON completo da conta de serviço do Firebase
