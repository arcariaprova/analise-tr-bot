import Anthropic from "@anthropic-ai/sdk";
import { CLASSIFICATION_PROMPT, TR_PROMPT, EDITAL_PROMPT } from "./prompt";

const anthropic = new Anthropic();

const model = process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514";
const MAX_TEXT_LENGTH = 180_000;

type DocType = "TR" | "EDITAL" | "DESCONHECIDO";

/**
 * Classifica o documento como TR, Edital ou Desconhecido.
 * Usa apenas os primeiros 5000 caracteres pra ser rápido e barato.
 */
async function classifyDocument(text: string): Promise<DocType> {
  const sample = text.slice(0, 5000);

  const response = await anthropic.messages.create({
    model,
    max_tokens: 20,
    system: CLASSIFICATION_PROMPT,
    messages: [
      {
        role: "user",
        content: `Classifique este documento:\n\n${sample}`,
      },
    ],
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
  documentText: string
): Promise<{ docType: DocType; analysis: string }> {
  let text = documentText;
  let truncatedWarning = "";

  if (text.length > MAX_TEXT_LENGTH) {
    text = text.slice(0, MAX_TEXT_LENGTH);
    truncatedWarning =
      "\n\n⚠️ *O documento foi truncado por ser muito extenso. A análise cobre apenas a parte inicial.*";
  }

  // Passo 1: Classificar
  const docType = await classifyDocument(text);

  // Passo 2: Escolher prompt
  let systemPrompt: string;
  let userMessage: string;

  if (docType === "EDITAL") {
    systemPrompt = EDITAL_PROMPT;
    userMessage = `Analise o seguinte Edital de Licitação:\n\n${text}`;
  } else if (docType === "TR") {
    systemPrompt = TR_PROMPT;
    userMessage = `Analise o seguinte Termo de Referência:\n\n${text}`;
  } else {
    // Desconhecido: usa o prompt de TR como fallback genérico
    systemPrompt = TR_PROMPT;
    userMessage = `O documento a seguir não foi claramente identificado como TR ou Edital. Analise-o da melhor forma possível:\n\n${text}`;
  }

  // Passo 3: Analisar
  const response = await anthropic.messages.create({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  const analysis = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  const header = `📋 *Documento identificado como: ${LABELS[docType]}*\n\n`;

  return {
    docType,
    analysis: header + analysis + truncatedWarning,
  };
}
