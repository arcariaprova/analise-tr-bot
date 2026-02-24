import Anthropic from "@anthropic-ai/sdk";
import { CLASSIFICATION_PROMPT, TR_PROMPT, EDITAL_PROMPT } from "./prompt";
import type { ExtractedFile } from "./fileHandler";

const anthropic = new Anthropic();

const model = process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514";
const MAX_TEXT_LENGTH = 180_000;
const MAX_PDF_PAGES = 50;

type DocType = "TR" | "EDITAL" | "DESCONHECIDO";

type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "document";
      source: {
        type: "base64";
        media_type: "application/pdf";
        data: string;
      };
    };

/**
 * Monta os content blocks a partir dos arquivos extraídos.
 * Textos viram blocos de texto, PDFs escaneados viram blocos de documento.
 */
function buildContentBlocks(
  files: ExtractedFile[],
  prefix: string
): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  if (prefix) {
    blocks.push({ type: "text", text: prefix });
  }

  for (const file of files) {
    if (file.pdfBuffer) {
      // PDF via Vision — envia o documento direto pro Claude
      blocks.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: file.pdfBuffer.toString("base64"),
        },
      });
      blocks.push({
        type: "text",
        text: `[Arquivo acima: ${file.name} — enviado como PDF pois não foi possível extrair texto]`,
      });
    } else if (file.text) {
      blocks.push({
        type: "text",
        text: `--- Arquivo: ${file.name} ---\n\n${file.text}`,
      });
    }
  }

  return blocks;
}

/**
 * Extrai o texto disponível dos arquivos pra classificação.
 * Pra PDFs escaneados, usa uma amostra via Vision separada.
 */
async function classifyDocument(files: ExtractedFile[]): Promise<DocType> {
  const blocks: ContentBlock[] = [
    { type: "text", text: "Classifique este documento:" },
  ];

  for (const file of files) {
    if (file.pdfBuffer) {
      // Manda o PDF pro Claude classificar via Vision
      blocks.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: file.pdfBuffer.toString("base64"),
        },
      });
    } else if (file.text) {
      // Usa só amostra pra classificação (rápido e barato)
      blocks.push({
        type: "text",
        text: file.text.slice(0, 5000),
      });
    }
  }

  const response = await anthropic.messages.create({
    model,
    max_tokens: 20,
    system: CLASSIFICATION_PROMPT,
    messages: [{ role: "user", content: blocks }],
  });

  const answer = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim()
    .toUpperCase();

  if (answer.includes("EDITAL")) return "EDITAL";
  if (answer.includes("TR")) return "TR";
  return "DESCONHECIDO";
}

const LABELS: Record<DocType, string> = {
  TR: "Termo de Referência",
  EDITAL: "Edital de Licitação",
  DESCONHECIDO: "Documento",
};

export async function analyzeDocument(
  files: ExtractedFile[]
): Promise<{ docType: DocType; analysis: string }> {
  const hasVision = files.some((f) => f.pdfBuffer);

  // Trunca textos longos
  for (const file of files) {
    if (file.text && file.text.length > MAX_TEXT_LENGTH) {
      file.text = file.text.slice(0, MAX_TEXT_LENGTH);
    }
  }

  // Passo 1: Classificar
  const docType = await classifyDocument(files);

  // Passo 2: Escolher prompt e montar mensagem
  let systemPrompt: string;
  let prefix: string;

  if (docType === "EDITAL") {
    systemPrompt = EDITAL_PROMPT;
    prefix = "Analise o seguinte Edital de Licitação:";
  } else if (docType === "TR") {
    systemPrompt = TR_PROMPT;
    prefix = "Analise o seguinte Termo de Referência:";
  } else {
    systemPrompt = TR_PROMPT;
    prefix =
      "O documento a seguir não foi claramente identificado como TR ou Edital. Analise-o da melhor forma possível:";
  }

  const contentBlocks = buildContentBlocks(files, prefix);

  // Passo 3: Analisar
  const response = await anthropic.messages.create({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: contentBlocks }],
  });

  const analysis = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  const header = `📋 *Documento identificado como: ${LABELS[docType]}*\n`;
  const visionNote = hasVision
    ? `🔍 _PDF escaneado detectado — análise feita via leitura visual (Claude Vision)_\n`
    : "";
  const truncatedNote = files.some(
    (f) => f.text && f.text.length >= MAX_TEXT_LENGTH
  )
    ? `\n⚠️ _Documento truncado por ser muito extenso. A análise cobre apenas a parte inicial._`
    : "";

  return {
    docType,
    analysis: header + visionNote + "\n" + analysis + truncatedNote,
  };
}
