import { App } from "@slack/bolt";
import { extractFilesFromSlack } from "./fileHandler";
import { analyzeDocument, OverloadedError } from "./analyzer";

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// Quando o bot é mencionado
app.event("app_mention", async ({ event, client, say }) => {
  const threadTs = event.thread_ts || event.ts;

  try {
    // Busca mensagens da thread pra encontrar arquivos
    let files: any[] = [];

    // Arquivos direto na mensagem que mencionou o bot
    if ((event as any).files?.length) {
      files = (event as any).files;
    }

    // Se não tem arquivo na mensagem, busca na thread
    if (files.length === 0 && event.thread_ts) {
      const threadMessages = await client.conversations.replies({
        channel: event.channel,
        ts: event.thread_ts,
        limit: 20,
      });

      for (const msg of threadMessages.messages || []) {
        if ((msg as any).files?.length) {
          files.push(...(msg as any).files);
        }
      }
    }

    if (files.length === 0) {
      await say({
        text: "Não encontrei nenhum documento nesta thread. Envie um PDF ou DOCX e me mencione novamente.",
        thread_ts: threadTs,
      });
      return;
    }

    // Filtra apenas formatos suportados
    const supportedFiles = files.filter((f: any) =>
      ["pdf", "docx", "doc", "txt", "md"].includes(f.filetype)
    );

    if (supportedFiles.length === 0) {
      await say({
        text: "Encontrei arquivos na thread, mas nenhum em formato suportado (PDF, DOCX, DOC, TXT). Por favor, envie o documento em um desses formatos.",
        thread_ts: threadTs,
      });
      return;
    }

    // Avisa que está processando
    await say({
      text: `Analisando ${supportedFiles.length} documento(s)... Isso pode levar alguns segundos.`,
      thread_ts: threadTs,
    });

    // Extrai conteúdo dos arquivos (texto ou buffer pra Vision)
    const extractedFiles = await extractFilesFromSlack(client, supportedFiles);

    const hasContent = extractedFiles.some((f) => f.text || f.pdfBuffer);
    if (!hasContent) {
      await say({
        text: "Não consegui extrair conteúdo dos documentos. O arquivo pode estar corrompido. Tente enviar novamente.",
        thread_ts: threadTs,
      });
      return;
    }

    // Analisa com Claude (classifica + analisa)
    const { analysis } = await analyzeDocument(extractedFiles);

    // Responde na thread (divide se muito longo pro Slack)
    const MAX_SLACK_MSG = 3900;
    if (analysis.length <= MAX_SLACK_MSG) {
      await say({
        text: analysis,
        thread_ts: threadTs,
      });
    } else {
      const chunks = splitMessage(analysis, MAX_SLACK_MSG);
      for (const chunk of chunks) {
        await say({
          text: chunk,
          thread_ts: threadTs,
        });
      }
    }
  } catch (err) {
    console.error("Erro ao processar menção:", err);

    if (err instanceof OverloadedError) {
      await say({
        text: "⏳ Os servidores da Anthropic (Claude) estão com alto tráfego neste momento. Tentei 3 vezes mas não consegui processar. Tente novamente em alguns minutos.",
        thread_ts: threadTs,
      });
    } else {
      await say({
        text: "Ocorreu um erro ao processar o documento. Tente novamente em alguns instantes.",
        thread_ts: threadTs,
      });
    }
  }
});

function splitMessage(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let cutIndex = remaining.lastIndexOf("\n", maxLength);
    if (cutIndex < maxLength * 0.5) {
      cutIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (cutIndex <= 0) {
      cutIndex = maxLength;
    }

    chunks.push(remaining.slice(0, cutIndex));
    remaining = remaining.slice(cutIndex).trimStart();
  }

  return chunks;
}

(async () => {
  await app.start();
  console.log("Bot de Análise de TR rodando!");
})();
