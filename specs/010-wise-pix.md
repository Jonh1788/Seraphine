# Spec 010 — Wise API Integration (PIX + Transfers)

## Contexto

A Seraphine precisa fazer PIX e transferências financeiras pelo usuário.
Em vez de browser automation (lento, frágil), usamos a **Wise Platform API**
que tem suporte nativo a PIX brasileiro, transferências internacionais,
consulta de saldo e extrato.

Wise API: `https://api.wise.com/v1/` (produção) ou
`https://api.sandbox.transferwise.tech/v1/` (sandbox pra testes).

Docs: https://docs.wise.com/api-docs/

## Fluxo de uma transferência PIX

```
1. GET  /v1/profiles           → pegar profileId do usuário
2. POST /v3/profiles/{id}/quotes  → criar cotação (BRL→BRL, amount)
3. POST /v1/accounts            → criar/buscar recipient (chave PIX)
4. POST /v1/transfers           → criar transferência (quoteId + recipientId)
5. POST /v3/profiles/{id}/transfers/{id}/payments → fundar/executar
```

Cada passo retorna IDs que alimentam o próximo. O PIX é uma transferência
BRL→BRL com `targetCurrency=BRL` e o recipient é cadastrado com a chave
PIX (CPF, telefone, email, ou chave aleatória).

## Autenticação

- **API Token**: gerado no Wise Settings → API tokens
- Header: `Authorization: Bearer <token>`
- Tokens podem ter escopo read-only ou full-access
- **SCA (Strong Customer Authentication)**: transferências acima de
  certo valor podem exigir 2FA — Wise retorna 403 com header
  `X-2FA-Approval` contendo um OTP ID. O usuário precisa aprovar no
  app Wise.

## API Contract

### GET /v1/profiles

Retorna os perfis do usuário (pessoal + business se tiver).

```
Authorization: Bearer <token>
→ [
    {
      "id": 12345,
      "type": "personal",
      "fullName": "Jonathan Santos"
    }
  ]
```

### POST /v3/profiles/{profileId}/quotes

Criar cotação. Para PIX (BRL→BRL), a cotação é trivial (1:1, sem câmbio).

```json
{
  "sourceCurrency": "BRL",
  "targetCurrency": "BRL",
  "sourceAmount": 50.00,
  "targetAmount": null,
  "payOut": "PIX"
}
→ {
    "id": "quote-uuid",
    "sourceCurrency": "BRL",
    "targetCurrency": "BRL",
    "sourceAmount": 50.00,
    "targetAmount": 50.00,
    "fee": 0.00,
    "rate": 1.0,
    "expirationTime": "2026-04-12T12:00:00Z"
  }
```

### POST /v1/accounts

Criar ou buscar recipient. Para PIX, o `type` depende da chave:

```json
{
  "currency": "BRL",
  "type": "brazil_pix",
  "profile": 12345,
  "accountHolderName": "Rodrigo Silva",
  "details": {
    "pixKey": "73999887766",
    "pixKeyType": "PHONE"
  }
}
→ {
    "id": 67890,
    "accountHolderName": "Rodrigo Silva",
    "currency": "BRL",
    "type": "brazil_pix"
  }
```

`pixKeyType`: `CPF`, `CNPJ`, `PHONE`, `EMAIL`, `EVP` (chave aleatória).

### POST /v1/transfers

Criar a transferência vinculando quote + recipient.

```json
{
  "targetAccount": 67890,
  "quoteUuid": "quote-uuid",
  "customerTransactionId": "uuid-unico-por-transfer",
  "details": {
    "reference": "PIX via Seraphine"
  }
}
→ {
    "id": 11111,
    "status": "incoming_payment_waiting",
    "sourceAmount": 50.00,
    "targetAmount": 50.00,
    "sourceCurrency": "BRL",
    "targetCurrency": "BRL"
  }
```

### POST /v3/profiles/{profileId}/transfers/{transferId}/payments

Fundar a transferência (executar o pagamento). Para saldo em conta Wise:

```json
{
  "type": "BALANCE"
}
→ {
    "status": "COMPLETED",
    "errorCode": null
  }
```

### GET /v1/transfers/{transferId}

Consultar status da transferência.

```json
→ {
    "id": 11111,
    "status": "outgoing_payment_sent",
    "sourceAmount": 50.00,
    "targetAmount": 50.00
  }
```

Status possíveis: `incoming_payment_waiting`, `processing`,
`funds_converted`, `outgoing_payment_sent`, `completed`, `cancelled`.

### GET /v4/profiles/{profileId}/balances?types=STANDARD

Consultar saldo.

```json
→ [
    {
      "id": 99999,
      "currency": "BRL",
      "amount": {"value": 1250.50, "currency": "BRL"},
      "type": "STANDARD"
    }
  ]
```

### GET /v1/profiles/{profileId}/transfers

Listar transferências recentes (extrato).

Query params: `limit`, `offset`, `createdDateStart`, `createdDateEnd`, `status`.

---

## Componente 1: Seraphine Tools (Python backend)

### Arquivos

```
backend/seraphine/wise/
├── __init__.py
├── client.py        # WiseClient — httpx wrapper pra API
└── routes.py        # (futuro) webhook de status updates

backend/seraphine/tools/wise.py   # 6 tools pro LLM
```

### WiseClient

```python
class WiseClient:
    def __init__(self, api_key: str, base_url: str = "https://api.wise.com",
                 profile_id: int | None = None):
        ...

    async def get_profiles(self) -> list[dict]: ...
    async def create_quote(self, source_currency, target_currency, amount, pay_out="PIX") -> dict: ...
    async def create_recipient(self, name, pix_key, pix_key_type, currency="BRL") -> dict: ...
    async def list_recipients(self, currency="BRL") -> list[dict]: ...
    async def create_transfer(self, quote_id, recipient_id, reference="") -> dict: ...
    async def fund_transfer(self, transfer_id) -> dict: ...
    async def get_transfer(self, transfer_id) -> dict: ...
    async def get_balances(self) -> list[dict]: ...
    async def list_transfers(self, limit=20) -> list[dict]: ...
```

### Tools

| Tool | Name | Confirmation | Descrição |
|---|---|---|---|
| `WiseBalanceTool` | `wise_balance` | No | Consulta saldo na conta Wise |
| `WiseTransactionsTool` | `wise_transactions` | No | Lista transferências recentes (extrato) |
| `WiseQuoteTool` | `wise_quote` | No | Cria cotação (mostra taxas antes de enviar) |
| `WiseRecipientsTool` | `wise_recipients` | No | Lista destinatários cadastrados |
| `WiseSendPixTool` | `wise_send_pix` | **Yes** | Envia PIX: cria quote → recipient → transfer → fund. Gate de aprovação com TODOS os detalhes. |
| `WiseTransferStatusTool` | `wise_transfer_status` | No | Consulta status de uma transferência |

### `wise_send_pix` — a tool principal

Schema:
```json
{
  "type": "object",
  "properties": {
    "recipient_name": {"type": "string", "description": "Nome do destinatário"},
    "pix_key": {"type": "string", "description": "Chave PIX (CPF, telefone, email, ou chave aleatória)"},
    "pix_key_type": {"type": "string", "enum": ["CPF", "CNPJ", "PHONE", "EMAIL", "EVP"]},
    "amount": {"type": "number", "description": "Valor em BRL"},
    "reference": {"type": "string", "description": "Descrição/referência do PIX"}
  },
  "required": ["recipient_name", "pix_key", "pix_key_type", "amount"]
}
```

Fluxo interno do execute():
1. Cria quote (BRL→BRL, amount, payOut=PIX)
2. Cria ou busca recipient (name + pix_key + type)
3. Cria transfer (quoteId + recipientId + reference)
4. Fund transfer (type=BALANCE)
5. Retorna status + detalhes

Tudo numa única tool call com **requires_confirmation=True**. O approval
gate mostra:
```
PIX de R$ 50,00 para Rodrigo Silva
Chave: 73999887766 (PHONE)
Referência: PIX via Seraphine
Taxa: R$ 0,00
Confirmar?
```

### Config

```python
# Wise API — leave key empty to disable
wise_api_key: str = ""
wise_profile_id: int = 0          # 0 = auto-detect from GET /profiles
wise_sandbox: bool = False         # True = use sandbox.transferwise.tech
```

### Bootstrap

`_check_wise()`:
- Se `wise_api_key` não vazio, GET /v1/profiles pra validar token
- Printa "✓ Wise connected as Jonathan Santos (profile 12345)"
- Se 401: "✗ Wise API key invalid"
- Warning only (não fatal)

---

## Segurança

- **API key**: armazenada no `.env`, nunca logada/exibida
- **Approval gate**: TODA transferência passa pelo gate com valor, nome, chave
- **SCA/2FA**: se Wise retornar 403, Seraphine avisa o usuário pra aprovar
  no app Wise e retenta depois
- **customerTransactionId**: UUID gerado por transferência — previne
  duplicatas se o request for retentado
- **Sandbox primeiro**: testar no sandbox antes de ir pra produção

---

## Fases

### Fase A — Read-only (saldo + extrato + cotação)

1. `backend/seraphine/wise/` + `tools/wise.py`
2. Tools: wise_balance, wise_transactions, wise_quote, wise_recipients
3. Config + bootstrap
4. Testes unitários

**Critério**: "qual meu saldo na Wise?" funciona.

### Fase B — Send PIX

1. `wise_send_pix` tool com approval gate
2. `wise_transfer_status` tool
3. Teste em sandbox com PIX fake
4. Depois: produção com PIX real de R$1 pra validar

**Critério**: PIX de R$1 pra si mesmo funciona end-to-end.

### Fase C — Polish

1. Webhook de status update (Wise notifica quando PIX completa/falha)
2. Retry em caso de SCA (pede pro usuário aprovar no app)
3. Transferências internacionais (não só PIX)
4. Cache de recipients
