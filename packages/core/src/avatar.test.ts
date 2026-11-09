import { describe, expect, it } from "vitest";
import {
  AVATAR_ACCESSORIES,
  AVATAR_EYES,
  AVATAR_KINDS,
  AVATAR_MOODS,
  AVATAR_MOUTHS,
  AVATAR_PALETTE_IDS,
  nextSeed,
  normalizeAvatar,
  randomAvatar,
  renderAvatarSvg,
  type AvatarSpec
} from "./avatar";

/** Minimal well-formedness check: balanced tags, one root <svg>, no stray "undefined"/"NaN". */
function assertValidSvg(svg: string): void {
  expect(svg.startsWith("<svg ")).toBe(true);
  expect(svg.endsWith("</svg>")).toBe(true);
  expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  expect(svg).not.toMatch(/undefined|NaN/);
  const stack: string[] = [];
  // Strip the embedded CSS (it contains braces, not tags).
  const markup = svg.replace(/<style>[\s\S]*?<\/style>/, "<style></style>");
  for (const match of markup.matchAll(/<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g)) {
    const [, closing, name, , selfClosing] = match;
    if (selfClosing) continue;
    if (closing) expect(stack.pop()).toBe(name);
    else stack.push(name!);
  }
  expect(stack).toEqual([]);
}

describe("avatar generator", () => {
  it("randomAvatar is deterministic and always valid", () => {
    expect(randomAvatar("research-dot")).toEqual(randomAvatar("research-dot"));
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const spec = randomAvatar(`seed-${i}`);
      seen.add(spec.kind);
      expect(AVATAR_KINDS).toContain(spec.kind);
      expect(spec.kind).not.toBe("custom-image");
      expect(AVATAR_PALETTE_IDS).toContain(spec.palette);
      expect(AVATAR_EYES).toContain(spec.eyes);
      expect(AVATAR_MOUTHS).toContain(spec.mouth);
      expect(AVATAR_ACCESSORIES).toContain(spec.accessory);
    }
    // Every drawable kind shows up across seeds.
    expect(seen.size).toBe(AVATAR_KINDS.length - 1);
  });

  it("renders the same string for the same spec and mood", () => {
    const spec = randomAvatar("same");
    expect(renderAvatarSvg(spec, { mood: "speaking", size: 40 })).toBe(renderAvatarSvg(spec, { mood: "speaking", size: 40 }));
  });

  it("renders valid SVG for every kind, mood and accessory", () => {
    for (const kind of AVATAR_KINDS) {
      for (const mood of AVATAR_MOODS) {
        for (const accessory of AVATAR_ACCESSORIES) {
          const spec: AvatarSpec = { ...randomAvatar(`${kind}-${mood}`), kind, accessory };
          const svg = renderAvatarSvg(spec, { mood, size: 64 });
          assertValidSvg(svg);
          expect(svg).toContain(`sa-mood-${mood}`);
          expect(svg).toContain('width="64"');
        }
      }
    }
    for (const eyes of AVATAR_EYES) for (const mouth of AVATAR_MOUTHS) assertValidSvg(renderAvatarSvg({ ...randomAvatar("x"), eyes, mouth }));
  });

  it("moods change the face", () => {
    const spec: AvatarSpec = { seed: "s", kind: "dot", palette: "sage", eyes: "round", mouth: "smile", accessory: "none" };
    const idle = renderAvatarSvg(spec, { mood: "idle", omitStyles: true });
    const speaking = renderAvatarSvg(spec, { mood: "speaking", omitStyles: true });
    const sleeping = renderAvatarSvg(spec, { mood: "sleeping", omitStyles: true });
    expect(speaking).toContain("sa-talk");
    expect(idle).not.toContain("sa-talk");
    expect(sleeping).toContain("sa-zz");
    expect(new Set([idle, speaking, sleeping]).size).toBe(3);
  });

  it("is accessible with a title and escapes it", () => {
    const svg = renderAvatarSvg(randomAvatar("a"), { title: 'Sales <Buddy> & "Co"' });
    expect(svg).toContain('role="img"');
    expect(svg).toContain("Sales &lt;Buddy&gt; &amp; &quot;Co&quot;");
    expect(svg).not.toContain("<Buddy>");
    expect(renderAvatarSvg(randomAvatar("a"))).toContain('aria-hidden="true"');
  });

  it("custom images need a safe URL and fall back to a dot", () => {
    const spec: AvatarSpec = { ...randomAvatar("img"), kind: "custom-image", imageUploadId: "up_1" };
    expect(renderAvatarSvg(spec, { imageUrl: "/api/uploads/up_1" })).toContain("<image ");
    expect(renderAvatarSvg(spec, { imageUrl: "javascript:alert(1)" })).not.toContain("<image ");
    expect(renderAvatarSvg(spec)).toContain("sa-kind-dot");
  });

  it("normalizes untrusted specs and shuffles deterministically", () => {
    const spec = normalizeAvatar({ seed: "z", kind: "dragon", palette: "sky", eyes: 3, imageUploadId: "../etc" });
    expect(spec.kind).toBe(randomAvatar("z").kind);
    expect(spec.palette).toBe("sky");
    expect(spec.imageUploadId).toBeUndefined();
    expect(normalizeAvatar(null, "fallback").seed).toBe("fallback");
    expect(nextSeed("a")).toBe(nextSeed("a"));
    expect(nextSeed("a")).not.toBe(nextSeed("b"));
    expect(renderAvatarSvg(spec, { size: 99999 })).toContain('width="512"');
  });
});

describe("no purple", () => {
  it("retired lavender avatars read as clay", () => {
    expect(AVATAR_PALETTE_IDS).not.toContain("lavender");
    expect(normalizeAvatar({ seed: "s", palette: "lavender" }).palette).toBe("clay");
  });
});
