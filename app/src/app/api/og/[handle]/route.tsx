import { ImageResponse } from "next/og";
import { readFile } from "fs/promises";
import path from "path";
import { getCard } from "@/lib/db";
import { normalizeHandle } from "@/lib/handle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ handle: string }>;
}

// Satori's bundled Inter font only covers Latin and lacks ♡, ★, etc. We
// ship Noto Sans (Latin + Bold) plus Noto Sans Symbols 2 (for misc symbols)
// in app/public/fonts/ and load them once per cold start.

interface SatoriFont {
  name: string;
  data: Buffer;
  weight: 400 | 700;
  style: "normal";
}

let fontsPromise: Promise<SatoriFont[] | null> | null = null;

function getFonts(): Promise<SatoriFont[] | null> {
  if (fontsPromise) return fontsPromise;
  const dir = path.join(process.cwd(), "public", "fonts");
  fontsPromise = (async () => {
    try {
      const [reg, bold, sym] = await Promise.all([
        readFile(path.join(dir, "NotoSans-Regular.ttf")),
        readFile(path.join(dir, "NotoSans-Bold.ttf")),
        readFile(path.join(dir, "NotoSansSymbols2-Regular.ttf")),
      ]);
      return [
        { name: "NotoSans", data: reg, weight: 400, style: "normal" },
        { name: "NotoSans", data: bold, weight: 700, style: "normal" },
        // Symbols2 contains ♡ ★ etc. Registered under a SEPARATE family so
        // we can put it in the fontFamily fallback chain — Satori is more
        // reliable falling through families than weights within one family.
        { name: "NotoSansSymbols", data: sym, weight: 400, style: "normal" },
      ];
    } catch {
      return null;
    }
  })();
  return fontsPromise;
}

export async function GET(_req: Request, { params }: RouteCtx) {
  const { handle } = await params;
  const card = getCard(normalizeHandle(handle));
  if (!card || card.status !== "approved") {
    return new Response("not found", { status: 404 });
  }

  const name = card.displayName || `@${card.handle}`;
  const bio = card.description || "";
  const avatar =
    card.avatarUrl || `https://unavatar.io/twitter/${card.handle}`;
  const accent = card.accentColor || "#e07a5f";

  const fonts = await getFonts();

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#d4b894",
          backgroundImage:
            "radial-gradient(at 20% 0%, rgba(255,250,240,0.25), transparent 55%), radial-gradient(at 100% 100%, rgba(46,31,18,0.18), transparent 55%)",
          fontFamily: "NotoSans, NotoSansSymbols, sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            position: "relative",
            width: 760,
            background: "#fffaf0",
            borderRadius: 22,
            boxShadow:
              "0 1px 2px rgba(46,31,18,0.12), 0 30px 60px -20px rgba(46,31,18,0.4)",
            border: "2px solid rgba(184,148,106,0.55)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "16px 28px",
              background: `linear-gradient(90deg, #f0d97c 0%, ${accent} 50%, #d4a93a 100%)`,
              color: "#2e1f12",
              fontSize: 18,
              fontWeight: 700,
              letterSpacing: 4,
              textTransform: "uppercase",
            }}
          >
            <span>SLOPCARD</span>
            <span>★</span>
            <span>v1</span>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              padding: "44px 56px 36px",
              color: "#2e1f12",
            }}
          >
            <div
              style={{
                display: "flex",
                padding: 4,
                background: `linear-gradient(135deg, #d4a93a, ${accent}, #81b29a)`,
                borderRadius: 999,
                marginBottom: 22,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={avatar}
                alt=""
                width={160}
                height={160}
                style={{
                  borderRadius: 999,
                  border: "4px solid #fffaf0",
                  objectFit: "cover",
                }}
              />
            </div>
            <div style={{ fontSize: 52, fontWeight: 800, lineHeight: 1.1 }}>
              {name}
            </div>
            <div
              style={{
                fontSize: 26,
                color: "#8c7660",
                marginTop: 6,
                marginBottom: 18,
              }}
            >
              {`@${card.handle}`}
            </div>
            {bio ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  fontSize: 24,
                  fontStyle: "italic",
                  textAlign: "center",
                  color: "#5c4a35",
                  maxWidth: 620,
                  lineHeight: 1.35,
                }}
              >
                {(bio.length > 220 ? bio.slice(0, 217) + "…" : bio)
                  .split("\n")
                  .map((line, i) => (
                    <div key={i}>{line || " "}</div>
                  ))}
              </div>
            ) : null}
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              padding: "12px 28px",
              borderTop: "1px dashed #b8946a",
              color: "#8c7660",
              fontSize: 16,
              letterSpacing: 3,
              textTransform: "uppercase",
            }}
          >
            {`slopcard.org / ${card.handle}`}
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      ...(fonts ? { fonts } : {}),
      // Twemoji covers most misc symbols (♡ ♥ ★ ☆ ✦ …) as SVGs; Satori
      // falls back to it for glyphs the registered fonts lack.
      emoji: "twemoji",
    }
  );
}
