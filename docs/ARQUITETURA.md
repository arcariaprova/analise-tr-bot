# Analise TR Bot — Documentação Técnica

## Visão Geral

Bot para Slack que analisa automaticamente **Termos de Referência (TR)** e **Editais de Licitação** usando a API do Claude (Anthropic). Quando um usuário envia um documento (PDF ou DOCX) em uma thread e menciona o bot, ele classifica o tipo de documento, aplica o prompt de análise adequado e responde com uma análise estruturada na própria thread.

**Repositório:** https://github.com/arcariaprova/analise-tr-bot
**Infraestrutura:** Railway (PaaS)
**Criado em:** Fevereiro/2026, como parte da iniciativa vibecoding da Aprova.

---

## Arquitetura

```
Slack (thread com documento)
    │
    │  @bot mencionado
    ▼
┌─────────────────────────────────────────────┐
│  index.ts — Slack Bot (Socket Mode)         │
│  Escuta evento app_mention                  │
│  Busca arquivos na mensagem ou na thread    │
│  Filtra formatos suportados                 │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│  fileHandler.ts — Extração de conteúdo      │
│                                             │
│  PDF com texto → pdf-parse (extrai texto)   │
│  PDF escaneado → mantém buffer pro Vision   │
│  DOCX/DOC     → mammoth (extrai texto)      │
│  TXT/MD/CSV   → leitura direta UTF-8        │
└──────────────┬──────────────────────────────┘
               │
               │  ExtractedFile[] (texto ou pdfBuffer)
               ▼
┌─────────────────────────────────────────────┐
│  analyzer.ts — Classificação + Análise      │
│                                             │
│  Passo 1: classifyDocument()                │
│    → Envia amostra pro Claude               │
│    → Retorna: TR | EDITAL | DESCONHECIDO    │
│                                             │
│  Passo 2: Seleciona prompt                  │
│    → TR_PROMPT ou EDITAL_PROMPT             │
│                                             │
│  Passo 3: analyzeDocument()                 │
│    → Envia documento completo pro Claude    │
│    → Retorna análise estruturada            │
└──────────────┬──────────────────────────────┘
               │
               │  Texto da análise
               ▼
┌─────────────────────────────────────────────┐
│  index.ts — Resposta no Slack               │
│  Divide em chunks se > 3900 chars           │
│  Responde na thread original                │
└─────────────────────────────────────────────┘
```

---

## Estrutura de Arquivos

```
analise-tr-bot/
├── src/
│   ├── index.ts          # Entry point — Slack bot, evento app_mention
│   ├── analyzer.ts       # Classificação do documento + chamada Claude API
│   ├── fileHandler.ts    # Download e extração de texto dos arquivos do Slack
│   └── prompt.ts         # ⭐ Prompts de análise (TR e Edital) — EDITE AQUI
├── docs/
│   └── ARQUITETURA.md    # Este documento
├── package.json          # Dependências e scripts
├── tsconfig.json         # Configuração TypeScript
├── railway.json          # Configuração de deploy Railway
├── .env.example          # Template de variáveis de ambiente
└── .gitignore            # node_modules, dist, .env
```

---

## Descrição de Cada Arquivo

### `src/index.ts` — Entry Point / Slack Bot

- Inicializa o Slack Bot usando `@slack/bolt` em **Socket Mode** (conexão WebSocket, sem precisar de URL pública)
- Escuta o evento `app_mention` (quando alguém menciona @bot)
- Fluxo ao receber menção:
  1. Verifica se há arquivos na mensagem ou na thread
  2. Filtra por formatos suportados (pdf, docx, doc, txt, md)
  3. Avisa no Slack que está processando
  4. Chama `extractFilesFromSlack()` para extrair conteúdo
  5. Chama `analyzeDocument()` para classificar e analisar
  6. Responde na thread (dividindo em chunks se necessário)
- Função `splitMessage()` divide respostas longas respeitando quebras de linha (limite Slack: ~4000 chars)

### `src/fileHandler.ts` — Extração de Conteúdo

- Recebe a lista de arquivos do Slack e retorna `ExtractedFile[]`
- Cada `ExtractedFile` tem:
  - `name`: nome do arquivo
  - `text`: texto extraído (quando possível)
  - `pdfBuffer`: PDF bruto em Buffer (quando não é possível extrair texto — fallback Vision)
- Lógica por formato:
  - **PDF**: tenta `pdf-parse`. Se o texto extraído tiver menos de 50 caracteres (provável escaneado), retorna o buffer bruto para ser enviado via Claude Vision
  - **DOCX**: usa `mammoth` para extrair texto do XML interno
  - **DOC**: tenta `mammoth` (suporte limitado)
  - **TXT/MD/CSV**: leitura direta como UTF-8

### `src/analyzer.ts` — Classificação e Análise via Claude

- **`classifyDocument()`**: envia uma amostra do documento (5000 chars de texto, ou o PDF completo via Vision) para o Claude com o `CLASSIFICATION_PROMPT`. Retorna `TR`, `EDITAL` ou `DESCONHECIDO`
- **`buildContentBlocks()`**: monta os content blocks da API do Claude. Textos viram blocos `type: "text"`, PDFs escaneados viram blocos `type: "document"` (base64)
- **`analyzeDocument()`**: função principal. Classifica → escolhe prompt → monta blocos → chama Claude → formata resposta
- Trunca textos acima de 180.000 caracteres (~45k tokens)
- A resposta inclui header com tipo identificado e nota se usou Vision

### `src/prompt.ts` — Prompts de Análise

**Este é o arquivo principal para customização.** Contém 3 constantes:

| Constante | Descrição |
|---|---|
| `CLASSIFICATION_PROMPT` | Classifica o documento como TR, EDITAL ou DESCONHECIDO |
| `TR_PROMPT` | Prompt completo para análise de Termos de Referência |
| `EDITAL_PROMPT` | Prompt completo para análise de Editais de Licitação |

**Para alterar os critérios de análise, edite apenas este arquivo.**

---

## Fluxo de Processamento de PDF

```
PDF recebido do Slack
        │
        ▼
   pdf-parse tenta
   extrair texto
        │
   ┌────┴─────┐
   │          │
 ≥ 50 chars  < 50 chars (ou erro)
   │          │
   ▼          ▼
 Texto      Buffer bruto
 extraído   (pdfBuffer)
   │          │
   ▼          ▼
 Enviado    Enviado como
 como       "document" block
 "text"     (Claude Vision lê
 block      o PDF visualmente)
```

**Por que 50 caracteres?** PDFs escaneados (imagens) retornam texto vazio ou com poucos caracteres de ruído. O threshold de 50 chars identifica esses casos e aciona o fallback Vision.

---

## Limites e Custos

### Limites de tamanho

| Cenário | Limite |
|---|---|
| PDF com texto (pdf-parse) | ~150-200 páginas (180k chars) |
| PDF escaneado (Vision) | Até 100 páginas (limite da API Claude) |
| Resposta do Claude | 4096 tokens (~3000 palavras) |
| Mensagem Slack | 3900 chars por mensagem (divide se maior) |

### Custo estimado por análise (Sonnet)

| Tipo de documento | Custo aproximado |
|---|---|
| TR/Edital com texto, 20 páginas | ~R$ 0,10 - 0,30 |
| TR/Edital com texto, 50 páginas | ~R$ 0,30 - 0,60 |
| PDF escaneado 20 páginas (Vision) | ~R$ 0,50 - 1,00 |
| PDF escaneado 50 páginas (Vision) | ~R$ 1,00 - 2,50 |

A classificação é barata (~R$ 0,01) pois usa apenas uma amostra do documento.

---

## Variáveis de Ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `SLACK_BOT_TOKEN` | Sim | Token do bot (xoxb-...) — OAuth & Permissions no Slack |
| `SLACK_SIGNING_SECRET` | Sim | Signing Secret — Basic Information no Slack |
| `SLACK_APP_TOKEN` | Sim | App-Level Token (xapp-...) — Socket Mode no Slack |
| `ANTHROPIC_API_KEY` | Sim | API key da Anthropic (sk-ant-...) |
| `CLAUDE_MODEL` | Não | Modelo Claude. Default: `claude-sonnet-4-20250514` |

### Modelos disponíveis

| Modelo | ID | Quando usar |
|---|---|---|
| Haiku | `claude-haiku-4-5-20251001` | Alto volume, docs simples |
| Sonnet | `claude-sonnet-4-20250514` | Padrão — bom equilíbrio custo/qualidade |
| Opus | `claude-opus-4-6` | Análises complexas que exigem máxima qualidade |

Para trocar o modelo, altere apenas a variável `CLAUDE_MODEL` no Railway.

---

## Dependências

| Pacote | Versão | Função |
|---|---|---|
| `@slack/bolt` | ^4.1.0 | Framework do Slack bot (Socket Mode, eventos, API) |
| `@anthropic-ai/sdk` | ^0.39.0 | SDK oficial da Anthropic para chamar o Claude |
| `pdf-parse` | ^1.1.1 | Extração de texto de PDFs (usa PDF.js internamente) |
| `mammoth` | ^1.8.0 | Extração de texto de DOCX/DOC |

### Dev dependencies

| Pacote | Função |
|---|---|
| `typescript` | Compilador TypeScript |
| `tsx` | Runtime TS para desenvolvimento local (`npm run dev`) |
| `@types/node` | Tipos do Node.js |
| `@types/pdf-parse` | Tipos do pdf-parse |

---

## Deploy

### Railway

O deploy é automático via GitHub. Cada push na `main` dispara um novo deploy.

- **Build**: `npm run build` (compila TypeScript → `dist/`)
- **Start**: `npm start` (executa `node dist/index.js`)
- **Restart policy**: reinicia automaticamente em caso de falha (até 10 tentativas)

Configuração em `railway.json`.

### Desenvolvimento local

```bash
# Clonar
git clone https://github.com/arcariaprova/analise-tr-bot.git
cd analise-tr-bot

# Instalar dependências
npm install

# Criar .env com as variáveis reais
cp .env.example .env
# (editar .env com os valores)

# Rodar em modo dev (com hot reload)
npm run dev
```

---

## Slack App — Configuração necessária

### Permissões (Bot Token Scopes)

- `app_mentions:read` — ler quando o bot é mencionado
- `chat:write` — escrever mensagens
- `files:read` — ler/baixar arquivos
- `channels:history` — ler histórico de canais (para buscar arquivos na thread)
- `groups:history` — ler histórico de grupos privados

### Eventos (Event Subscriptions)

- `app_mention` — disparado quando alguém menciona @bot

### Socket Mode

- Ativado — o bot conecta via WebSocket (não precisa de URL pública)
- App-Level Token com scope `connections:write`

---

## Como usar no Slack

1. Em qualquer canal onde o bot foi adicionado, envie um PDF ou DOCX
2. Na mesma mensagem (ou em uma reply na thread), mencione `@Analise TR`
3. O bot responde na thread com:
   - Tipo identificado (TR ou Edital)
   - Análise completa seguindo o prompt padronizado

**Formatos suportados:** PDF, DOCX, DOC, TXT

---

## Alterações Comuns

### Mudar os critérios de análise
Editar `src/prompt.ts` — altere `TR_PROMPT` ou `EDITAL_PROMPT`.

### Adicionar novo tipo de documento
1. Adicionar categoria no `CLASSIFICATION_PROMPT` em `src/prompt.ts`
2. Criar novo prompt (ex: `CONTRATO_PROMPT`) em `src/prompt.ts`
3. Adicionar o caso no `analyzeDocument()` em `src/analyzer.ts`

### Trocar o modelo Claude
Alterar a variável `CLAUDE_MODEL` no Railway. Não precisa de deploy.

### Aumentar tamanho da resposta
Alterar `max_tokens: 4096` em `src/analyzer.ts` (máximo depende do modelo).

### Alterar threshold de PDF escaneado
Alterar `MIN_TEXT_LENGTH = 50` em `src/fileHandler.ts`.
