// Reads an artwork's dimensions from the start of its data URI without decoding the whole image.
// Supports lossless WebP (VP8L, the format the Pixagram app writes), lossy WebP (VP8),
// extended WebP (VP8X), PNG and GIF.

export interface ImageInfo {
  mime: string;
  width: number | null;
  height: number | null;
  format: string | null;
}

const DATA_URI = /^data:(image\/[a-z0-9.+-]+);base64,/i;

function decodeHead(b64: string, bytes: number): Uint8Array {
  const chars = Math.ceil(bytes / 3) * 4;
  const slice = b64.slice(0, chars).replace(/[^A-Za-z0-9+/]/g, "");
  const padded = slice + "=".repeat((4 - (slice.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.slice(from, to));

export function imageInfo(body: string): ImageInfo | null {
  const m = body.match(DATA_URI);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  let head: Uint8Array;
  try {
    head = decodeHead(body.slice(m[0].length), 40);
  } catch {
    return { mime, width: null, height: null, format: null };
  }
  if (head.length >= 30 && ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") {
    const chunk = ascii(head, 12, 16);
    if (chunk === "VP8L" && head[20] === 0x2f) {
      const bits = head[21] | (head[22] << 8) | (head[23] << 16) | (head[24] << 24);
      return { mime, format: "webp-lossless", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") {
      const w = 1 + (head[24] | (head[25] << 8) | (head[26] << 16));
      const h = 1 + (head[27] | (head[28] << 8) | (head[29] << 16));
      return { mime, format: "webp-extended", width: w, height: h };
    }
    if (chunk === "VP8 ") {
      const w = (head[26] | (head[27] << 8)) & 0x3fff;
      const h = (head[28] | (head[29] << 8)) & 0x3fff;
      return { mime, format: "webp-lossy", width: w, height: h };
    }
    return { mime, format: "webp", width: null, height: null };
  }
  if (head.length >= 24 && head[0] === 0x89 && ascii(head, 1, 4) === "PNG") {
    const dv = new DataView(head.buffer);
    return { mime, format: "png", width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (head.length >= 10 && ascii(head, 0, 3) === "GIF") {
    return { mime, format: "gif", width: head[6] | (head[7] << 8), height: head[8] | (head[9] << 8) };
  }
  return { mime, format: null, width: null, height: null };
}

/** The app's artwork test: trimmed body is an image data URI with no "<" and no line break. */
export function isArtworkBody(body: string): boolean {
  const b = body.trim();
  return b.startsWith("data:image/") && !b.includes("<") && !/[\r\n]/.test(b);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("");
}
