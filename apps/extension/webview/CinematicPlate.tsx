import React from "react";
import type { CinematicKey } from "./cinematic.js";
import { CINEMATIC } from "./cinematic.js";

interface Props {
  /** Which photo from the cinematic registry. */
  image: CinematicKey;
  /** Mono uppercase micro-caption shown top-left (like the website's "SOURCE · BUGCREPORT · 2023"). */
  caption?: string;
  /** Optional headline rendered over the photo in Playfair italic. */
  headline?: React.ReactNode;
  /** Aspect ratio of the plate. Default is 16:9 for hero, but "square" and "portrait" are handy for milestone cards. */
  ratio?: "16:9" | "4:3" | "square" | "portrait";
  /** Height in pixels — lets callers constrain the plate regardless of ratio. */
  height?: number;
  /** Dim the photo further — useful for ghost backdrops. 1 = full, 0 = invisible. */
  intensity?: number;
  /** Children render INSIDE the plate, layered on top of the photo + fade. */
  children?: React.ReactNode;
  className?: string;
}

/**
 * CinematicPlate — the one and only pattern for putting a photo on screen
 * inside Protege. Photo + bottom-to-top fade mask + noise grain + optional
 * mono caption + optional serif headline + any children layered on top.
 *
 * Rules enforced here so the rest of the app stays cohesive:
 *  - Every photo has a 1px glass border.
 *  - Every photo fades to transparent at the bottom 60% so text sits flat.
 *  - Every photo gets a subtle SVG grain overlay.
 *  - Every photo darkens to 40-60% of full luminance so it never shouts.
 */
export function CinematicPlate({
  image,
  caption,
  headline,
  ratio = "16:9",
  height,
  intensity = 0.55,
  children,
  className,
}: Props) {
  const src = CINEMATIC[image];
  const aspect =
    ratio === "16:9"
      ? "16 / 9"
      : ratio === "4:3"
        ? "4 / 3"
        : ratio === "portrait"
          ? "3 / 4"
          : "1 / 1";

  return (
    <div
      className={`plate ${className ?? ""}`}
      style={
        height
          ? { height, aspectRatio: undefined }
          : { aspectRatio: aspect }
      }
    >
      <div
        className="plate-photo"
        style={{
          backgroundImage: `url(${src})`,
          opacity: intensity,
        }}
      />
      <div className="plate-fade" />
      <div className="plate-grain" />
      {caption && <div className="plate-caption">{caption}</div>}
      {headline && <div className="plate-headline">{headline}</div>}
      {children && <div className="plate-body">{children}</div>}
    </div>
  );
}
