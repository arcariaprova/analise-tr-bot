import type { WebClient } from "@slack/web-api";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";

interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  url_private: string;
  filetype: string;
}

export async function extractTextFromFiles(
  client: WebClient,
  files: SlackFile[]
): Promise<string[]> {
  const results: string[] = [];

  for (const file of files) {
    try {
      const text = await extractSingleFile(client, file);
      if (text.trim()) {
        results.push(`--- Arquivo: ${file.name} ---\n\n${text}`);
      }
    } catch (err) {
      console.error(`Erro ao processar arquivo ${file.name}:`, err);
      results.push(
        `--- Arquivo: ${file.name} ---\n\n[Erro ao extrair texto deste arquivo. Formato: ${file.filetype}]`
      );
    }
  }

  return results;
}

async function extractSingleFile(
  client: WebClient,
  file: SlackFile
): Promise<string> {
  const response = await fetch(file.url_private, {
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Falha ao baixar arquivo: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (file.filetype === "pdf" || file.mimetype === "application/pdf") {
    const data = await pdfParse(buffer);
    return data.text;
  }

  if (
    file.filetype === "docx" ||
    file.mimetype ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (file.filetype === "doc" || file.mimetype === "application/msword") {
    // mammoth tem suporte limitado a .doc, mas tenta
    try {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    } catch {
      return "[Formato .doc antigo - converta para .docx ou .pdf para melhor resultado]";
    }
  }

  // Texto puro
  if (
    file.mimetype?.startsWith("text/") ||
    ["txt", "md", "csv"].includes(file.filetype)
  ) {
    return buffer.toString("utf-8");
  }

  return `[Formato não suportado: ${file.filetype}. Use PDF ou DOCX.]`;
}
