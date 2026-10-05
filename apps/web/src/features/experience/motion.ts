import type { GameCue } from "./model.js";

export type SeatEffect = GameCue["kind"] | "source";
/** Adapted Animista shake-horizontal / scale-in-center (Ana Travas, BSD-2-Clause).
 * Small, finite transforms only; /licenses/animista.txt retains the full notice. */
export function seatMotion(effect: SeatEffect): { frames: Keyframe[]; options: KeyframeAnimationOptions } | null {
  if (effect === "hit" || effect === "explosion") {
    const size = effect === "explosion" ? 5 : 3;
    return {
      frames: [0, -1, 1, -1, 1, -1, 1, -1, .8, -.8, 0].map((n, index) => ({ transform: `translateX(${n * size}px)`, offset: index / 10 })),
      options: { duration: 380, easing: "cubic-bezier(.455,.03,.515,.955)", iterations: 1 },
    };
  }
  if (effect === "source") return { frames: [{ transform: "none" }, { transform: "translateX(-4px) rotate(-1deg)", offset: .35 }, { transform: "none" }], options: { duration: 240, easing: "ease-out", iterations: 1 } };
  if (["turn", "draw", "pick", "equip", "block", "heal", "victory"].includes(effect)) return { frames: [{ transform: "scale(.98)" }, { transform: "scale(1.015)", offset: .45 }, { transform: "scale(1)" }], options: { duration: 360, easing: "cubic-bezier(.25,.46,.45,.94)", iterations: 1 } };
  if (effect === "eliminated") return { frames: [{ transform: "none", opacity: 1 }, { transform: "rotate(-2deg)", opacity: .7, offset: .5 }, { transform: "none", opacity: 1 }], options: { duration: 480, easing: "ease-out", iterations: 1 } };
  return null;
}

/** Each cue starts a fresh animation without remounting a focused player card. */
export function playSeatMotion(element: HTMLElement, effect: SeatEffect | undefined, allowed: boolean): () => void {
  const doc = element.ownerDocument;
  if (!allowed || !effect || doc.hidden || typeof element.animate !== "function") return () => {};
  const preset = seatMotion(effect);
  if (!preset) return () => {};
  try {
    const animation = element.animate(preset.frames, preset.options);
    const hide = () => { if (doc.hidden) animation.cancel(); };
    doc.addEventListener("visibilitychange", hide);
    return () => { doc.removeEventListener("visibilitychange", hide); animation.cancel(); };
  } catch { return () => {}; } // Presentation failures must never prevent an action.
}
