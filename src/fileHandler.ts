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

export interface ExtractedFile {
  name: string;
  text?: string;
  /** PDF bruto para fallback via Claude Vision (quando pdf-parse não extrai texto) */
  pdfBuffer?: Buffer;
}

const MIN_TEXT_LENGTH = 50; // abaixo disso, provavelmente é PDF escaneado

export async function extractFilesFromSlack(
  client: WebClient,
  files: SlackFile[]
): Promise<ExtractedFile[]> {
  const results: ExtractedFile[] = [];

  for (const file of files) {
    try {
      const result = await extractSingleFile(client, file);
      results.push(result);
    } catch (err) {
      console.error(`Erro ao processar arquivo ${file.name}:`, err);
      results.push({
        name: file.name,
        text: `[Erro ao extrair texto deste arquivo. Formato: ${file.filetype}]`,
      });
    }
  }

  return results;
}

async function downloadFile(file: SlackFile): Promise<Buffer> {
  const response = await fetch(file.url_private, {
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Falha ao baixar arquivo: ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function extractSingleFile(
  client: WebClient,
  file: SlackFile
): Promise<ExtractedFile> {
  const buffer = await downloadFile(file);

  // PDF: tenta extrair texto, se falhar manda o buffer pra Vision
  if (file.filetype === "pdf" || file.mimetype === "application/pdf") {
    try {
      const data = await pdfParse(buffer);
      const text = data.text?.trim() || "";

      if (text.length >= MIN_TEXT_LENGTH) {
        return { name: file.name, text };
      }
    } catch (err) {
      console.warn(`pdf-parse falhou para ${file.name}, usando Vision fallback`);
    }

    // Fallback: envia o PDF bruto pro Claude Vision
    console.log(`PDF "${file.name}" sem texto extraível, usando Claude Vision`);
    return { name: file.name, pdfBuffer: buffer };
  }

  // DOCX
  if (
    file.filetype === "docx" ||
    file.mimetype ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const result = await mammoth.extractRawText({ buffer });
    return { name: file.name, text: result.value };
  }

  // DOC antigo
  if (file.filetype === "doc" || file.mimetype === "application/msword") {
    try {
      const result = await mammoth.extractRawText({ buffer });
      return { name: file.name, text: result.value };
    } catch {
      return {
        name: file.name,
        text: "[Formato .doc antigo - converta para .docx ou .pdf para melhor resultado]",
      };
    }
  }

  // Texto puro
  if (
    file.mimetype?.startsWith("text/") ||
    ["txt", "md", "csv"].includes(file.filetype)
  ) {
    return { name: file.name, text: buffer.toString("utf-8") };
  }

  return {
    name: file.name,
    text: `[Formato não suportado: ${file.filetype}. Use PDF ou DOCX.]`,
  };
}
