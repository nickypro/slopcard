import { ImageResponse } from "next/og";

export const runtime = "nodejs";
export const alt = "slopcard — a little card for your twitter profile";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#d4b894",
          backgroundImage:
            "radial-gradient(at 20% 0%, rgba(255,250,240,0.25), transparent 55%), radial-gradient(at 100% 100%, rgba(46,31,18,0.18), transparent 55%)",
          fontFamily: "sans-serif",
          color: "#2e1f12",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 28,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 140,
              height: 140,
              borderRadius: 30,
              background:
                "linear-gradient(135deg, #f0d97c 0%, #e07a5f 50%, #d4a93a 100%)",
              boxShadow:
                "0 1px 2px rgba(46,31,18,0.18), 0 20px 50px -10px rgba(46,31,18,0.35)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 108,
                height: 108,
                borderRadius: 22,
                background: "#fffaf0",
                color: "#e07a5f",
                fontSize: 72,
                fontWeight: 800,
              }}
            >
              sc
            </div>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
            }}
          >
            <div style={{ fontSize: 108, fontWeight: 800, lineHeight: 1 }}>
              slopcard
            </div>
            <div
              style={{
                fontSize: 28,
                color: "#5c4a35",
                marginTop: 12,
                maxWidth: 700,
              }}
            >
              a little card for your twitter profile that links to your
              swapcard
            </div>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 60,
            fontSize: 22,
            color: "#8c7660",
            letterSpacing: 4,
            textTransform: "uppercase",
          }}
        >
          slopcard.org
        </div>
      </div>
    ),
    size
  );
}
