import { ImageResponse } from "next/og";
import { getCard } from "@/lib/db";
import { normalizeHandle } from "@/lib/handle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ handle: string }>;
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

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background:
            "linear-gradient(135deg, #1a1822 0%, #2a2440 50%, #1a1822 100%)",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            padding: "40px 60px",
            borderRadius: 28,
            background: "rgba(34, 31, 45, 0.95)",
            border: "2px solid #c084fc",
            width: 720,
            color: "#f1eef8",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={avatar}
            alt=""
            width={140}
            height={140}
            style={{
              borderRadius: 999,
              border: "4px solid #c084fc",
              marginBottom: 20,
              objectFit: "cover",
            }}
          />
          <div style={{ fontSize: 48, fontWeight: 800 }}>{name}</div>
          <div style={{ fontSize: 26, color: "#9c93b3", marginBottom: 16 }}>
            @{card.handle}
          </div>
          {bio ? (
            <div
              style={{
                fontSize: 24,
                fontStyle: "italic",
                textAlign: "center",
                maxWidth: 600,
                lineHeight: 1.3,
              }}
            >
              {bio.length > 160 ? bio.slice(0, 157) + "…" : bio}
            </div>
          ) : null}
          <div
            style={{
              marginTop: 28,
              fontSize: 18,
              color: "#9c93b3",
              letterSpacing: 2,
            }}
          >
            SLOPCARD.ORG / {card.handle.toUpperCase()}
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    }
  );
}
