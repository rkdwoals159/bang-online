import type { MatchSnapshotView, PublicPlayerView } from "../../../../../packages/contracts/src/protocol.js";

/** Clockwise seating with the viewer at the bottom of the circle. */
export function circleSeatPosition(index: number, count: number): { left: string; top: string } {
  const angle = 2 * Math.PI * index / Math.max(1, count);
  return { left: `${50 - Math.sin(angle) * 34}%`, top: `${50 + Math.cos(angle) * 35}%` };
}

/** Public information only; the server remains responsible for target legality. */
export function viewerDistance(snapshot: MatchSnapshotView, target: PublicPlayerView): number | null {
  const living = snapshot.publicTable.players.filter(player => !player.eliminated).sort((a, b) => a.seatIndex - b.seatIndex);
  const from = living.findIndex(player => player.playerId === snapshot.viewer.playerId);
  const to = living.findIndex(player => player.playerId === target.playerId);
  if (from < 0 || to < 0 || from === to) return null;
  const viewer = living[from]!;
  const difference = Math.abs(from - to);
  const base = Math.min(difference, living.length - difference);
  return Math.max(1, base + Number(target.inPlay.some(card => card.typeId === "mustang")) + Number(target.characterId === "paul_regret") - Number(viewer.inPlay.some(card => card.typeId === "scope")) - Number(viewer.characterId === "rose_doolan"));
}
