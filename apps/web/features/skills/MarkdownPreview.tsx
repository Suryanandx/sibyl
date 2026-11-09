"use client";

import type { ReactNode } from "react";
import styles from "./skills.module.css";

/**
 * A small, safe Markdown preview for skill instructions: headings, lists,
 * tables (as text rows), code blocks, quotes, bold/italic/code/links.
 * Builds React elements only — never injects HTML.
 */
export function MarkdownPreview({ source }: { source: string }) {
  return <div className={styles.markdown}>{renderBlocks(source.replace(/\r\n?/g, "\n"))}</div>;
}

function renderBlocks(text: string): ReactNode[] {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let index = 0;
  let key = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (/^```/.test(line)) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index]!)) body.push(lines[index++]!);
      index += 1;
      out.push(
        <pre key={key++}>
          <code>{body.join("\n")}</code>
        </pre>
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1]!.length + 1, 6);
      const Tag = `h${level}` as "h2";
      out.push(<Tag key={key++}>{inline(heading[2]!)}</Tag>);
      index += 1;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (index < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[index]!)) {
        items.push(lines[index]!.replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
        index += 1;
      }
      const children = items.map((item, i) => <li key={i}>{inline(item)}</li>);
      out.push(ordered ? <ol key={key++}>{children}</ol> : <ul key={key++}>{children}</ul>);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index]!)) quote.push(lines[index++]!.replace(/^>\s?/, ""));
      out.push(<blockquote key={key++}>{inline(quote.join(" "))}</blockquote>);
      continue;
    }
    if (/^\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      while (index < lines.length && /^\|.*\|\s*$/.test(lines[index]!)) {
        const cells = lines[index]!.trim().slice(1, -1).split("|").map((cell) => cell.trim());
        if (!cells.every((cell) => /^:?-{2,}:?$/.test(cell))) rows.push(cells);
        index += 1;
      }
      out.push(
        <table key={key++}>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (r === 0 ? <th key={c}>{inline(cell)}</th> : <td key={c}>{inline(cell)}</td>))}
              </tr>
            ))}
          </tbody>
        </table>
      );
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index]!.trim() && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s|\|)/.test(lines[index]!)) paragraph.push(lines[index++]!);
    out.push(<p key={key++}>{inline(paragraph.join(" "))}</p>);
  }
  return out;
}

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^)\s]+\))/g;

function inline(text: string): ReactNode[] {
  const parts = text.split(INLINE).filter((part) => part !== "");
  return parts.map((part, i) => {
    if (/^`[^`]+`$/.test(part)) return <code key={i}>{part.slice(1, -1)}</code>;
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (/^(\*[^*]+\*|_[^_]+_)$/.test(part)) return <em key={i}>{part.slice(1, -1)}</em>;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      const href = link[2]!;
      return /^https?:\/\//i.test(href) ? (
        <a key={i} href={href} target="_blank" rel="noopener noreferrer">
          {link[1]}
        </a>
      ) : (
        <span key={i}>{link[1]}</span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}
