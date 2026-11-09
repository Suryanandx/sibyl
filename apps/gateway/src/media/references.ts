/**
 * References in prompts. In Sibyl a picked file is named "@image1",
 * "@video1", "@audio1" (or any "@token" the composer gave it); each model
 * family names its inputs differently, so the prompt is rewritten before it
 * is sent:
 *
 *   Seedance 2.x   @Image1, @Video1, @Audio1   (ByteDance / fal docs)
 *   Wan 2.x        image 1, video 1            (Alibaba Model Studio r2v docs)
 *   others         image 1                     (plain words; the model sees the images in order)
 *
 * References are numbered per media type in the order they are sent; first
 * and last frames are not references and read "the first frame" / "the last frame".
 */
import type { MediaReferenceRole, MediaReferenceSupport } from "@open-gpt-live/protocol";

export type RefMediaType = "image" | "video" | "audio";

export interface ResolvedRef {
  uploadId: string;
  role: MediaReferenceRole;
  mediaType: RefMediaType;
  token?: string;
}

/** The provider's name for the n-th reference of a type (1-based). */
export function referenceLabel(syntax: MediaReferenceSupport["syntax"], type: RefMediaType, n: number): string {
  if (syntax === "seedance") return `@${type[0]!.toUpperCase()}${type.slice(1)}${n}`;
  return `${type} ${n}`;
}

/** Number each reference per type (frames excluded). */
export function numberReferences(refs: ResolvedRef[]): Array<ResolvedRef & { index?: number }> {
  const counters: Record<RefMediaType, number> = { image: 0, video: 0, audio: 0 };
  return refs.map((ref) => (ref.role === "reference" ? { ...ref, index: ++counters[ref.mediaType] } : ref));
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrite reference tokens into the model's syntax. Tokens the composer
 * assigned ("@fox") and the default ones ("@image2", which the brain uses)
 * both work, case-insensitively.
 */
export function providerPrompt(prompt: string, refs: ResolvedRef[], syntax: MediaReferenceSupport["syntax"]): string {
  let text = prompt;
  const numbered = numberReferences(refs);
  const replacements: Array<{ token: string; label: string }> = [];
  for (const ref of numbered) {
    const label = ref.role === "first_frame" ? "the first frame" : ref.role === "last_frame" ? "the last frame" : referenceLabel(syntax, ref.mediaType, ref.index!);
    if (ref.token) replacements.push({ token: ref.token.startsWith("@") ? ref.token : `@${ref.token}`, label });
    if (ref.index) replacements.push({ token: `@${ref.mediaType}${ref.index}`, label });
  }
  // Longest tokens first, so "@image10" is not eaten by "@image1".
  replacements.sort((a, b) => b.token.length - a.token.length);
  const seen = new Set<string>();
  for (const { token, label } of replacements) {
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    text = text.replace(new RegExp(`${escape(token)}(?![\\w-])`, "gi"), label);
  }
  return text;
}

/** Media type of an upload kind / mime, if it can be a reference at all. */
export function refMediaType(kind: string, mime: string): RefMediaType | undefined {
  if (kind === "image" || mime.startsWith("image/")) return "image";
  if (kind === "video" || mime.startsWith("video/")) return "video";
  if (kind === "audio" || mime.startsWith("audio/")) return "audio";
  return undefined;
}

/** Why these references don't fit the model, or undefined when they do. */
export function referenceProblem(refs: ResolvedRef[], support: MediaReferenceSupport, modelName: string): string | undefined {
  const count = (type: RefMediaType) => refs.filter((ref) => ref.role === "reference" && ref.mediaType === type).length;
  for (const role of ["first_frame", "last_frame"] as const) {
    const frames = refs.filter((ref) => ref.role === role);
    if (frames.length > 1) return `Only one ${role.replace("_", " ")} can be used.`;
    if (frames.length && !support.frames.includes(role)) return `${modelName} doesn't take a ${role.replace("_", " ")}.`;
    if (frames.some((ref) => ref.mediaType !== "image")) return `The ${role.replace("_", " ")} must be an image.`;
  }
  const checks: Array<[RefMediaType, number]> = [
    ["image", support.images],
    ["video", support.videos],
    ["audio", support.audio]
  ];
  for (const [type, max] of checks) {
    const n = count(type);
    if (n > max) return max === 0 ? `${modelName} doesn't take reference ${type}s.` : `${modelName} takes at most ${max} reference ${type}${max === 1 ? "" : "s"}.`;
  }
  if (support.syntax === "wan" && count("image") + count("video") > 5) return "Wan takes at most 5 reference images and videos together.";
  if (count("audio") > 0 && count("image") + count("video") === 0) return "Reference audio needs at least one reference image or video.";
  return undefined;
}
