import { ImageResponse } from "next/og";

export const runtime = "nodejs";
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
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
            "linear-gradient(135deg, #f0d97c 0%, #e07a5f 50%, #d4a93a 100%)",
          borderRadius: 38,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 144,
            height: 144,
            borderRadius: 28,
            background: "#fffaf0",
            border: "4px solid rgba(184, 148, 106, 0.55)",
            color: "#e07a5f",
            fontSize: 88,
            fontWeight: 800,
            fontFamily: "sans-serif",
          }}
        >
          sc
        </div>
      </div>
    ),
    size
  );
}
