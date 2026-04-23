import { ImageResponse } from "next/og";
import { SRUTH_LOGO_TILE_BG, SruthGlyph } from "@/components/logo";

export const alt = "Sruth — Multi-destination live streaming relay";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          height: "100%",
          background: "#0a3d2c",
          color: "#ffffff",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <div
          style={{
            width: 160,
            height: 160,
            borderRadius: 26,
            background: SRUTH_LOGO_TILE_BG,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 40,
          }}
        >
          <SruthGlyph width={61} height={124} fill="#ffffff" />
        </div>
        <div
          style={{
            fontSize: 168,
            fontWeight: 700,
            letterSpacing: "-0.03em",
            lineHeight: 1,
          }}
        >
          Sruth
        </div>
        <div
          style={{
            fontSize: 36,
            marginTop: 24,
            opacity: 0.85,
            letterSpacing: "-0.01em",
          }}
        >
          Multi-destination live streaming relay
        </div>
      </div>
    ),
    { ...size },
  );
}
