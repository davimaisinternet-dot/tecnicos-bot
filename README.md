# Técnicos Bot — WhatsApp + Gemini Vision

Bot que monitora um grupo de WhatsApp da equipe técnica de um ISP, extrai dados de **fotos de equipamentos** (ONT, ONU, roteadores) com Gemini Vision e alimenta uma **planilha web** em tempo real.

Cada foto que um técnico envia com uma legenda tipo *"Instalação cliente João Silva CPF 123.456.789-00"* é automaticamente processada:

- **Serial / MAC / Modelo / Fabricante** extraídos da etiqueta na foto
- **Tipo (instalação, troca, manutenção) / Cliente / CPF** extraídos do texto
- **Quem enviou** (nome do técnico no WhatsApp) já vira auditoria
- Salvo em Postgres + bot responde no grupo confirmando
- Painel web com filtros, busca e export CSV pronto pro Excel

## Screenshot

![painel](docs/screenshot.png)

## Stack

- **Node.js 22** (worker + API + serve painel estático)
- **Postgres** (estrutura simples, 1 tabela com índices)
- **[WPPConnect](https://github.com/wppconnect-team/wppconnect-server)** (WhatsApp Web)
- **Gemini Vision API** (free tier, modelo `gemini-2.5-flash-lite`)
- **Dispatcher** (roteia só mensagens do grupo alvo pro bot)

## Arquitetura

```
Grupo WhatsApp "Suporte Mais Internet"
   │ (foto + legenda)
   ▼
WPPConnect (:21465)
   │ webhook
   ▼
webhook-dispatcher (:3099)
   │ filtra por chat_id do grupo
   ▼
tecnicos-bot worker (:3100)
   ├─ salva foto em /app/fotos/
   ├─ Gemini Vision extrai JSON estruturado
   ├─ Gesprov lookup (opcional) valida cliente por CPF
   ├─ grava Postgres
   └─ responde no grupo: "✅ Registrado #N ..."
   │
   └─ serve painel web + /api/eventos + /api/export.csv
```

## Instalação rápida

```bash
git clone https://github.com/davimaisinternet-dot/tecnicos-bot.git
cd tecnicos-bot
cp .env.example .env
nano .env   # preencher GEMINI_KEY, CHAT_ID, WPP_SESSION
./deploy.sh
```

Isso sobe:
1. Schema SQL no postgres
2. Patch no `webhook-dispatcher` pra rotear o grupo alvo
3. Worker em Docker
4. Painel em `http://host:3100/`

## Como descobrir o `chat_id` do grupo

Depois do WPPConnect entrar no grupo (via invite link ou manualmente), consulte:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:21465/api/$SESSION/all-groups | jq '.response[] | {id:.id._serialized, name}'
```

Cole o `id._serialized` do grupo certo no `.env` como `CHAT_ID`.

## Modelos Gemini suportados (fallback chain)

O bot tenta em sequência:

1. `gemini-2.5-flash-lite` ← **default free tier** (funciona sem billing)
2. `gemini-2.0-flash-lite`
3. `gemini-2.0-flash`
4. `gemini-2.5-flash`
5. `gemini-2.5-flash` (retry final)

Modelos 2.0 podem dar 429 (quota=0) se a key for free tier sem billing — 2.5-flash-lite quase sempre passa.

## Campos extraídos automaticamente

O prompt pede retorno em JSON estrito:

```json
{
  "tipo": "instalacao | troca | manutencao | outros",
  "cliente_nome": "string",
  "cliente_cpf": "string",
  "cliente_login": "string (login PPPoE)",
  "equipamento": "roteador | ont | onu | switch | outro",
  "fabricante": "Tenda | Huawei | ZTE | ...",
  "modelo": "string",
  "serial": "string (da etiqueta)",
  "mac": "AA:BB:CC:DD:EE:FF",
  "equip_anterior": "string (se troca)",
  "observacoes": "string"
}
```

## Painel

- Cards de resumo: total, por tipo, hoje, técnicos ativos
- Filtros: busca livre, tipo, técnico, data
- Coluna **Técnico** em destaque (quem mandou a foto)
- **Botão Exportar Excel** → baixa CSV com BOM UTF-8 + `="..."` em CPF/Serial/MAC (evita notação científica)
- Auto-refresh a cada 15s

## Integração com Gesprov (opcional)

Se você tem um sistema ERP com API de consulta por CPF/login (o "ACS Panel" da Mais Internet faz isso via Gesprov), o bot enriquece o registro automaticamente. Configure `GESPROV_URL` no `.env`.

## Licença

MIT. Projeto educacional — adapte à realidade da sua empresa.
