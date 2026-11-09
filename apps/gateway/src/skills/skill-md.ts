/**
 * SKILL.md: YAML-ish front matter (name, description, optional title,
 * version, tools / allowed-tools) followed by the Markdown instructions.
 * Compatible with the common SKILL.md format; unknown keys are ignored.
 *
 * The parser handles the subset skills use: `key: value`, quoted strings,
 * inline lists `[a, b]`, dash lists, and `>` / `|` block scalars.
 */
import { SKILL_NAME } from "@open-gpt-live/protocol";

export interface ParsedSkillMd {
  name: string;
  title: string;
  description: string;
  instructions: string;
  tools?: string[];
  version?: string;
}

export class SkillFormatError extends Error {}

type Value = string | string[];

export function parseFrontMatter(source: string): { data: Record<string, Value>; body: string } {
  const text = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!text.startsWith("---\n")) return { data: {}, body: text };
  const end = text.indexOf("\n---", 4);
  if (end < 0) throw new SkillFormatError("The front matter is not closed with ---.");
  const header = text.slice(4, end);
  const after = text.slice(end + 4);
  const body = after.startsWith("\n") ? after.slice(1) : after.replace(/^[^\n]*\n?/, "");
  const data: Record<string, Value> = {};
  const lines = header.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const raw = match[2]!.trim();
    if (raw === ">" || raw === "|" || raw === ">-" || raw === "|-") {
      const block: string[] = [];
      while (index + 1 < lines.length && (/^\s+/.test(lines[index + 1]!) || !lines[index + 1]!.trim())) {
        index += 1;
        block.push(lines[index]!.trim());
      }
      data[key] = raw.startsWith(">") ? block.filter(Boolean).join(" ") : block.join("\n").trim();
      continue;
    }
    if (raw === "") {
      const items: string[] = [];
      while (index + 1 < lines.length && /^\s*-\s+/.test(lines[index + 1]!)) {
        index += 1;
        items.push(unquote(lines[index]!.replace(/^\s*-\s+/, "")));
      }
      data[key] = items.length ? items : "";
      continue;
    }
    if (raw.startsWith("[") && raw.endsWith("]")) {
      data[key] = raw
        .slice(1, -1)
        .split(",")
        .map((item) => unquote(item.trim()))
        .filter(Boolean);
      continue;
    }
    data[key] = unquote(raw);
  }
  return { data, body };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    const inner = trimmed.slice(1, -1);
    return trimmed.startsWith("\"") ? inner.replace(/\\"/g, "\"").replace(/\\n/g, "\n").replace(/\\\\/g, "\\") : inner.replace(/''/g, "'");
  }
  return trimmed;
}

/** Parse a SKILL.md. `fallbackName` (e.g. the folder name) is used when the front matter has none. */
export function parseSkillMd(source: string, fallbackName?: string): ParsedSkillMd {
  const { data, body } = parseFrontMatter(source);
  const str = (key: string): string | undefined => {
    const value = data[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const name = slugify(str("name") ?? fallbackName ?? "");
  if (!name || !SKILL_NAME.test(name)) throw new SkillFormatError("SKILL.md needs a name (lowercase letters, digits and dashes).");
  const description = str("description");
  if (!description) throw new SkillFormatError("SKILL.md needs a description that says when to use the skill.");
  const instructions = body.trim();
  if (!instructions) throw new SkillFormatError("SKILL.md has no instructions after the front matter.");
  const heading = /^#\s+(.+)$/m.exec(instructions)?.[1]?.trim();
  const title = (str("title") ?? heading ?? titleFromName(name)).slice(0, 120);
  const toolsValue = data.tools ?? data["allowed-tools"];
  const tools = (Array.isArray(toolsValue) ? toolsValue : typeof toolsValue === "string" ? toolsValue.split(/[\s,]+/) : [])
    .map((tool) => tool.trim())
    .filter((tool) => /^[a-zA-Z0-9_-]{1,64}$/.test(tool))
    .slice(0, 30);
  const version = str("version");
  return {
    name,
    title,
    description: description.slice(0, 400),
    instructions,
    ...(tools.length ? { tools } : {}),
    ...(version && /^[0-9A-Za-z.+-]{1,32}$/.test(version) ? { version } : {})
  };
}

export function serializeSkillMd(skill: { name: string; title: string; description: string; instructions: string; tools?: string[]; version?: string }): string {
  const lines = [
    "---",
    `name: ${skill.name}`,
    `title: ${yamlString(skill.title)}`,
    `description: ${yamlString(skill.description)}`,
    ...(skill.version ? [`version: ${skill.version}`] : []),
    ...(skill.tools?.length ? [`tools: [${skill.tools.join(", ")}]`] : []),
    "---",
    "",
    skill.instructions.trim(),
    ""
  ];
  return lines.join("\n");
}

function yamlString(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, " ").trim());
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

export function titleFromName(name: string): string {
  const words = name.split("-").filter(Boolean);
  const text = words.join(" ");
  return text ? text[0]!.toUpperCase() + text.slice(1) : name;
}
