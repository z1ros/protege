/**
 * Central registry for all cinematic photography used in the extension.
 *
 * Each import goes through Vite, which hashes the file and emits it into
 * dist/webview/assets/, so the webview can load it without any extra CSP
 * or localResourceRoots plumbing — the image path is relative to the
 * already-allowed webview assets dir.
 *
 * When adding a new photo, keep the naming semantic (what it *means*, not
 * image N) and give it a short role comment so the next reader knows why
 * it exists.
 */

import cathedral from "./cinematic/cathedral.webp";
import emptyChair from "./cinematic/empty-chair.webp";
import blueHorizon from "./cinematic/blue-horizon.webp";
import cometRider from "./cinematic/comet-rider.webp";
import starlitFigure from "./cinematic/starlit-figure.webp";
import haloedMentor from "./cinematic/haloed-mentor.webp";
import cycleBloom from "./cinematic/cycle-bloom.webp";
import valleyOfGold from "./cinematic/valley-of-gold.webp";
import sunflowerGate from "./cinematic/sunflower-gate.webp";

// blue-highlight set — added in pass 2, used for overlay pages
import blueReflection from "./cinematic/blue-reflection.webp";
import electricRoses from "./cinematic/electric-roses.webp";
import greenPlanet from "./cinematic/green-planet.webp";
import galaxySky from "./cinematic/galaxy-sky.webp";
import cometHigh from "./cinematic/comet-high.webp";
import eclipseDawn from "./cinematic/eclipse-dawn.webp";

export const CINEMATIC = {
  /** Primary hero photo — sits behind IQ number on Concepts tab. */
  cathedral,
  /** Chat empty state — "where knowledge begins". */
  emptyChair,
  /** Concepts tab empty state — "save a file to start earning IQ". */
  blueHorizon,
  /** Streak visuals — 7+ day streaks. */
  cometRider,
  /** Expert-level concepts and "first Expert" milestone. */
  starlitFigure,
  /** Voice mode orb underlay — presence behind the circle. */
  haloedMentor,
  /** 14-day IQ sparkline ghost backdrop. */
  cycleBloom,
  /** Onboarding / first-launch splash. */
  valleyOfGold,
  /** Activity bar launcher placeholder. */
  sunflowerGate,

  /** Voice "thinking" / reflection state — contemplative silhouette. */
  blueReflection,
  /** Achievement unlocks — electric blue roses, "reward bloom". */
  electricRoses,
  /** Alt profile hero — planet over a grass horizon. */
  greenPlanet,
  /** Profile page primary hero — figure under rising galaxy. */
  galaxySky,
  /** Subscription page hero — comet over cloud horizon. */
  cometHigh,
  /** Settings page hero — eclipsing planet, deep work mood. */
  eclipseDawn,
} as const;

export type CinematicKey = keyof typeof CINEMATIC;
