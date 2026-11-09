/**
 * Turning a typed message with attachments into the model's user turn:
 * extracted text goes in a marked block (with ids for read_file), images go
 * as OpenAI-style `image_url` parts. Also picks a vision-capable model when
 * the chat model can't see images.
 */
import type { LLMContentPart, LLMMessage } from "@open-gpt-live/adapters";
import type { AttachmentRef } from "@open-gpt-live/protocol";
import type { UploadService, UploadView } from "./service.js";

/** Characters of each file's text placed directly in the prompt. */
export const PROMPT_CHARS_PER_FILE = 6_000;
/** Total characters of file text placed in one turn. */
export const PROMPT_CHARS_TOTAL = 16_000;
/** Images larger than this are not inlined (providers reject huge data URLs). */
export const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

/** `image_url` content part (passed through to OpenAI-compatible APIs as is). */
export interface ImageUrlPart {
  type: "image_url";
  image_url: { url: string };
}

export interface PreparedAttachments {
  /** The user turn's content (text + file block + images). */
  content: LLMContentPart[];
  /** Server-verified references, stored with the conversation. */
  refs: AttachmentRef[];
  files: UploadView[];
  imageCount: number;
  /** Ids the browser sent that are not this owner's uploads. */
  missing: string[];
}

export async function prepareAttachments(
  uploads: UploadService,
  text: string,
  attachments: AttachmentRef[]
): Promise<PreparedAttachments> {
  const files: UploadView[] = [];
  const missing: string[] = [];
  for (const ref of attachments) {
    const file = await uploads.get(ref.id);
    if (file) {
      if (!files.some((existing) => existing.id === file.id)) files.push(file);
    } else missing.push(ref.id);
  }
  const lines: string[] = [];
  const images: ImageUrlPart[] = [];
  let budget = PROMPT_CHARS_TOTAL;
  for (const file of files) {
    if (file.kind === "image") {
      if (file.size <= MAX_INLINE_IMAGE_BYTES) {
        const bytes = await uploads.readBytes(file.id);
        images.push({ type: "image_url", image_url: { url: `data:${file.mime};base64,${bytes.toString("base64")}` } });
        lines.push(`- ${file.name} (image, file id ${file.id}) — shown below.`);
      } else {
        lines.push(`- ${file.name} (image, file id ${file.id}) — too large to show to the model.`);
      }
      continue;
    }
    const fullText = await uploads.readText(file.id);
    const take = Math.max(0, Math.min(PROMPT_CHARS_PER_FILE, budget, fullText.length));
    budget -= take;
    const excerpt = fullText.slice(0, take);
    const more = fullText.length > take;
    lines.push(
      `- ${file.name} (file id ${file.id}; ${file.summary}; ${fullText.length.toLocaleString("en-US")} characters of text)` +
        (excerpt ? `\n<<<file ${file.id}\n${excerpt}${more ? "\n…" : ""}\n>>>` : " — no readable text.") +
        (more ? `\n  (Only the beginning is shown. Call read_file with id "${file.id}" and offset ${take} to read more.)` : "")
    );
  }
  const block = lines.length ? `\n\n[Attached files]\n${lines.join("\n")}` : "";
  const content: LLMContentPart[] = [
    { type: "text", text: `${text}${block}` },
    ...(images as unknown as LLMContentPart[])
  ];
  return {
    content,
    refs: files.map((file) => ({ id: file.id, name: file.name, mime: file.mime, size: file.size })),
    files,
    imageCount: images.length,
    missing
  };
}

/**
 * After the reply, keep only text in the history: images would otherwise be
 * re-sent (and paid for) on every later turn, and the voice brain may not
 * accept them. The model's own reply already describes what it saw.
 */
export function withoutImages(content: LLMMessage["content"]): LLMMessage["content"] {
  if (typeof content === "string") return content;
  const parts = content as Array<LLMContentPart | ImageUrlPart>;
  const images = parts.filter((part) => part.type === "image_url").length;
  if (images === 0) return content;
  const text = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  return `${text}\n(${images === 1 ? "The image was" : `${images} images were`} shown with this message.)`;
}

/** Text the model sees for attachments of a stored (earlier) message. */
export function attachmentNote(refs: AttachmentRef[] | undefined): string {
  if (!refs?.length) return "";
  const list = refs.map((ref) => `${ref.name} (file id ${ref.id})`).join(", ");
  return `\n[Attached: ${list}. Use read_file to read them again.]`;
}

const VISION_PATTERNS = [
  /gpt-4o/, /gpt-4\.1/, /gpt-4-turbo/, /gpt-4-vision/, /gpt-5/, /\bo[34](-|$)/, /o4-mini/,
  /claude-3/, /claude-(sonnet|opus|haiku)-4/, /claude-.*-4/, /claude-(opus|sonnet)/,
  /gemini/, /gemma-3/, /llama-3\.2-\d+b-vision/, /llama-4/, /qwen.*vl/, /qwen3\.5/, /qvq/,
  /pixtral/, /mistral-(small|medium)-3/, /grok-(2-vision|4)/, /nova-(lite|pro|premier)/,
  /glm-4(\.\d)?v/, /kimi-vl/, /kimi-k2\.5/, /phi-4-multimodal/, /minimax-01/, /internvl/, /molmo/
];

/** Heuristic: can this model id read images? (OpenRouter-style ids.) */
export function supportsVision(model: string | undefined): boolean {
  if (!model) return false;
  const id = model.toLowerCase();
  if (/audio|tts|whisper|transcribe|embedding/.test(id)) return false;
  return VISION_PATTERNS.some((pattern) => pattern.test(id));
}

/**
 * The model to answer a message with images: the current one when it can see,
 * else SIBYL_VISION_MODEL, else the first vision-capable model in the catalog.
 */
export function pickVisionModel(
  current: string | undefined,
  catalogModels: string[],
  env: NodeJS.ProcessEnv = process.env
): { model: string; switched: boolean } | undefined {
  if (current && supportsVision(current)) return { model: current, switched: false };
  const configured = env.SIBYL_VISION_MODEL?.trim();
  if (configured) return { model: configured, switched: configured !== current };
  const fallback = catalogModels.find((id) => supportsVision(id));
  return fallback ? { model: fallback, switched: true } : undefined;
}
