import sharp from "sharp";

export interface AccentColor {
  hex: string;
  darkHex: string;
}

// Extract a "dominant hue" from an image URL.
// Strategy: resize small, quantize to a ~12 bit color space, drop pixels that
// are too dark / too light / too desaturated, take the most common remaining
// bucket. Returns the picked color plus a slightly-darker variant for
// gradient endpoints.
export async function extractAccentColor(
  imageUrl: string
): Promise<AccentColor | null> {
  if (!imageUrl) return null;

  let buf: Buffer;
  try {
    const res = await fetch(imageUrl, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    buf = Buffer.from(ab);
  } catch {
    return null;
  }

  let raw: { data: Buffer; info: sharp.OutputInfo };
  try {
    raw = await sharp(buf)
      .resize(64, 64, { fit: "inside" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    return null;
  }

  const counts = new Map<number, number>();
  const { data, info } = raw;
  const ch = info.channels;

  for (let i = 0; i < data.length; i += ch) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = ch === 4 ? data[i + 3] : 255;
    if (a < 200) continue;

    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum < 35 || lum > 225) continue;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min < 28) continue; // skip near-gray

    // Quantize to 4 bits per channel (16 buckets per channel = 4096 total).
    const qr = r & 0xf0;
    const qg = g & 0xf0;
    const qb = b & 0xf0;
    const key = (qr << 16) | (qg << 8) | qb;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  if (counts.size === 0) return null;

  let bestKey = 0;
  let bestCount = 0;
  for (const [k, v] of counts) {
    if (v > bestCount) {
      bestKey = k;
      bestCount = v;
    }
  }

  const r = (bestKey >> 16) & 0xff;
  const g = (bestKey >> 8) & 0xff;
  const b = bestKey & 0xff;

  return {
    hex: toHex(r, g, b),
    darkHex: toHex(...darken(r, g, b, 0.7)),
  };
}

function toHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"))
      .join("")
  );
}

function darken(
  r: number,
  g: number,
  b: number,
  factor: number
): [number, number, number] {
  return [r * factor, g * factor, b * factor];
}
