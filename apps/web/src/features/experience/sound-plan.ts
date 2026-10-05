import type { GameCue, SoundKind } from "./model.js";

export interface SoundStep { id: string; kind: SoundKind; offset: number; count: number }
const weapons = new Set(["volcanic", "schofield", "remington", "carabine", "winchester"]);
const safeCount = (value = 1) => Number.isFinite(value) ? Math.max(1, Math.min(4, Math.floor(value))) : 1;

/** Compact one sync into a short score, independently of the visual queue. */
export function planSounds(cues: readonly GameCue[]): SoundStep[] {
  const steps: SoundStep[] = [];
  const seen = new Set<string>();
  // A discarded draw card appears after hand deltas in the visual model;
  // its table tap should precede the incoming paper sounds.
  for (const cue of [...cues].sort((a,b)=>Number(b.kind === "play")-Number(a.kind === "play"))) {
    if (seen.has(cue.id)) continue;
    seen.add(cue.id);
    const kind: SoundKind = cue.sound ?? (cue.kind === "equip" && cue.card
      ? weapons.has(cue.card.typeId) ? "reload" : cue.card.typeId === "jail" ? "jail" : cue.card.typeId === "dynamite" ? "fuse" : "equip"
      : cue.kind);
    const existing = steps.find(step => step.kind === kind);
    if (existing) { if (kind === "draw") existing.count = Math.min(4, existing.count + safeCount(cue.count)); continue; }
    if (steps.length === 6) { if(kind === "victory") steps.pop(); else continue; }
    steps.push({ id: cue.id, kind, offset: steps.length * .075, count: safeCount(cue.count) });
  }
  return steps;
}
