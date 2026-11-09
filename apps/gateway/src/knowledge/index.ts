/**
 * Knowledge bases (see docs/knowledge.md). Installed once by runtime.ts.
 */
import type { Store, ToolRegistry, UsageMeter } from "@open-gpt-live/core";
import { uploadServiceFor } from "../uploads/index.js";
import { embeddingsFromEnv } from "./embeddings.js";
import { ocrFromEnv } from "./ocr.js";
import { KnowledgeService } from "./service.js";
import { createKnowledgeTools } from "./tools.js";

export { KnowledgeService, KnowledgeError, docView, snippet } from "./service.js";
export { chunkText, estimateTokens, type TextChunk } from "./chunk.js";
export { EmbeddingsClient, EmbeddingsError, embeddingsFromEnv, cosine } from "./embeddings.js";
export { createKnowledgeTools } from "./tools.js";
export { OcrClient, OcrError, annotationText, ocrFromEnv, pickOcrModel, type OcrResult } from "./ocr.js";
export { handleKnowledgeHttp, isKnowledgePath, type KnowledgeHttpOptions } from "./http.js";

export async function installKnowledge(input: {
  tools: ToolRegistry;
  store: Store;
  meter: UsageMeter;
  ownerId: string;
  env: NodeJS.ProcessEnv;
  log: (event: string, fields?: Record<string, unknown>) => void;
}): Promise<KnowledgeService> {
  const embeddings = embeddingsFromEnv(input);
  const ocr = ocrFromEnv(input);
  const knowledge = new KnowledgeService({
    store: input.store,
    ownerId: input.ownerId,
    meter: input.meter,
    uploads: uploadServiceFor({ store: input.store, ownerId: input.ownerId, env: input.env, log: input.log }),
    ...(embeddings ? { embeddings } : {}),
    ...(ocr ? { ocr } : {}),
    log: input.log
  });
  const tools = createKnowledgeTools(knowledge);
  for (const tool of tools) input.tools.register(tool);
  const resumed = await knowledge.resume().catch((error: unknown) => {
    input.log("knowledge.resume_failed", { error: (error as Error).message });
    return 0;
  });
  input.log("knowledge.installed", { tools: tools.map((tool) => tool.name), embeddings: embeddings?.model ?? null, ocr: ocr ? ocr.pdfEngine : null, resumed });
  return knowledge;
}
