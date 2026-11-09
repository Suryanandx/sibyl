/**
 * Minimal multipart/form-data reader: returns the first part that carries a
 * filename (the browser's `FormData.append("file", blob, name)`).
 */
export interface MultipartFile {
  filename: string;
  contentType?: string;
  data: Buffer;
}

export function boundaryOf(contentType: string | undefined): string | undefined {
  if (!contentType || !/^multipart\/form-data/i.test(contentType)) return undefined;
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return match?.[1] ?? match?.[2];
}

export function parseMultipartFile(body: Buffer, boundary: string): MultipartFile | undefined {
  const delimiter = Buffer.from(`--${boundary}`);
  let position = body.indexOf(delimiter);
  while (position >= 0) {
    const start = position + delimiter.length;
    // "--" after the delimiter ends the body.
    if (body[start] === 0x2d && body[start + 1] === 0x2d) return undefined;
    const headerStart = body[start] === 0x0d && body[start + 1] === 0x0a ? start + 2 : start;
    const headerEnd = body.indexOf("\r\n\r\n", headerStart);
    if (headerEnd < 0) return undefined;
    const next = body.indexOf(Buffer.concat([Buffer.from("\r\n"), delimiter]), headerEnd + 4);
    if (next < 0) return undefined;
    const headers = body.subarray(headerStart, headerEnd).toString("utf8");
    const disposition = /content-disposition:([^\r\n]*)/i.exec(headers)?.[1] ?? "";
    const filenameStar = /filename\*=(?:UTF-8'')?([^;\r\n]+)/i.exec(disposition)?.[1];
    const filename = filenameStar
      ? safeDecode(filenameStar.trim().replace(/^"|"$/g, ""))
      : /filename="([^"]*)"/i.exec(disposition)?.[1] ?? /filename=([^;\s]+)/i.exec(disposition)?.[1];
    if (filename !== undefined) {
      const contentType = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim();
      return { filename, ...(contentType ? { contentType } : {}), data: body.subarray(headerEnd + 4, next) };
    }
    position = next + 2;
  }
  return undefined;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
