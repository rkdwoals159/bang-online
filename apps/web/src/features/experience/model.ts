import type { CardFaceView, MatchSnapshotView, PublicMatchEvent } from "../../../../../packages/contracts/src/protocol.js";

export type CueKind = "shot" | "burst" | "block" | "hit" | "heal" | "judgment" | "explosion" | "duel" | "threat" | "draw" | "discard" | "equip" | "turn" | "eliminated" | "victory" | "store" | "pick" | "ability" | "pass" | "play";
export interface GameCue {
  id: string;
  kind: CueKind;
  label: string;
  actorId?: string;
  targetIds: readonly string[];
  card?: CardFaceView;
}
export interface PresentationCursor { version: number; eventSeq: number; snapshot: MatchSnapshotView }
export const MAX_QUEUED_CUES = 12;
export const cueDuration = (kind: CueKind): number => kind === "burst" ? 900 : kind === "victory" ? 1600 : kind === "judgment" ? 1100 : 680;

/** Presentation consumes authenticated projections only. It never decides game outcomes. */
export function advancePresentation(previous: PresentationCursor | null, version: number, snapshot: MatchSnapshotView, events: readonly PublicMatchEvent[], now: number, visible = true): { cursor: PresentationCursor; cues: GameCue[] } {
  const eventSeq = Math.max(previous?.eventSeq ?? 0, ...events.map(e => Number.isSafeInteger(e.eventSeq) ? e.eventSeq : 0));
  if (previous && version < previous.version) return { cursor: previous, cues: [] };
  const cursor = { version, eventSeq, snapshot };
  // First connection, hidden-tab backlog, and duplicate snapshots are silent.
  if (!previous || !visible) return { cursor, cues: [] };
  const players = new Map(snapshot.publicTable.players.map(p => [p.playerId, p]));
  const knownId = (value: unknown): string | undefined => typeof value === "string" && players.has(value) ? value : undefined;
  const name = (id?: string): string => id ? players.get(id)?.displayName ?? "참가자" : "참가자";
  const cues: GameCue[] = [];
  const seen = new Set<number>();
  for (const e of [...events].sort((a, b) => a.eventSeq - b.eventSeq)) {
    if (seen.has(e.eventSeq)) continue;
    seen.add(e.eventSeq);
    const timestamp = Date.parse(e.occurredAt);
    if (!Number.isSafeInteger(e.eventSeq) || e.eventSeq <= previous.eventSeq || !Number.isFinite(timestamp) || now - timestamp > 10_000 || timestamp > now + 2_000) continue;
    const p = e.payload;
    const actorId = knownId(p.actorPlayerId);
    const targetId = knownId(p.targetPlayerId);
    const targets = Array.isArray(p.targetPlayerIds) ? [...new Set(p.targetPlayerIds.flatMap(id => knownId(id) ? [id as string] : []))] : targetId ? [targetId] : [];
    const cue = (kind: CueKind, label: string, targetIds = targets, card?: CardFaceView) => cues.push({ id: `event:${e.eventSeq}`, kind, label, actorId, targetIds, ...(card ? { card } : {}) });
    switch (e.type) {
      case "BANG_ATTACKED": if (actorId && targetId) cue("shot", `${name(actorId)} → ${name(targetId)} · 뱅!`); break;
      case "GATLING_STARTED": if (actorId && targets.length) cue("burst", `${name(actorId)} · 개틀링!`); break;
      case "BANG_MISSED": case "GATLING_MISSED": if (targetId) cue("block", `${name(targetId)} · 팅! 방어`); break;
      case "BARREL_CHECK_RESOLVED":
        if (targetId && p.succeeded === true && !events.some(other => other.eventSeq > previous.eventSeq && (other.type === "BANG_MISSED" || other.type === "GATLING_MISSED") && other.payload.targetPlayerId === targetId)) cue("block", `${name(targetId)} · 팅! 판정 성공`);
        else if (targetId && p.succeeded === false) cue("judgment", `${name(targetId)} · 판정 실패`);
        break;
      case "BANG_HIT": case "GATLING_HIT": case "INDIANS_HIT":
        if (targetId) cue("hit", `${name(targetId)} · 피해 ${typeof p.damage === "number" ? p.damage : "적용"}`); break;
      case "PLAYER_HEALED": if (targetId) cue("heal", `${name(targetId)} · 체력 +${typeof p.amount === "number" ? p.amount : 1}`); break;
      case "BEER_USED": cue("ability", `${name(actorId)} · 맥주${p.healed === 0 ? " (회복 없음)" : ""}`, actorId ? [actorId] : []); break;
      case "SALOON_USED": cue("heal", "술집 · 함께 회복", Array.isArray(p.healedPlayerIds) ? p.healedPlayerIds.flatMap(id => knownId(id) ? [id as string] : []) : []); break;
      case "INDIANS_STARTED": if (targets.length) cue("threat", "인디언! · 각자 대응하세요"); break;
      case "INDIANS_DEFENDED": if (targetId) cue("block", `${name(targetId)} · 대응 성공`); break;
      case "PANIC_USED": if (actorId && targetId) cue("pick", `${name(actorId)} · ${name(targetId)}에게 패닉!`); break;
      case "CAT_BALOU_USED": if (actorId && targetId) cue("discard", `${name(actorId)} · ${name(targetId)}에게 캣 벌루`); break;
      case "DUEL_STARTED": if (targetId) cue("duel", `${name(actorId)} ↔ ${name(targetId)} · 결투`); break;
      case "DUEL_BANG_PLAYED": {
        const initiator = knownId(p.initiatorPlayerId), responder = knownId(p.responderPlayerId);
        const opponent = actorId === initiator ? responder : initiator;
        if (actorId && opponent) cue("shot", `${name(actorId)} · 결투 뱅!`, [opponent]); break;
      }
      case "DUEL_YIELDED": { const id = knownId(p.playerId); if (id) cue("hit", `${name(id)} · 결투 피해`, [id]); break; }
      case "DYNAMITE_EXPLODED": if (targetId) cue("explosion", `${name(targetId)} · 다이너마이트 폭발!`); break;
      case "DYNAMITE_PASSED": { const id = knownId(p.toPlayerId); if (id) { cue("pass", `${name(id)}에게 다이너마이트 전달`, [id]); cues[cues.length-1].actorId = knownId(p.fromPlayerId); } break; }
      case "BARREL_JUDGMENT_REVEALED": case "DYNAMITE_JUDGMENT_REVEALED": case "JAIL_JUDGMENT_REVEALED": {
        const card = publicCard(p.card);
        if (card) cue("judgment", e.type.startsWith("JAIL") ? "감옥 판정" : e.type.startsWith("DYNAMITE") ? "다이너마이트 판정" : "술통 판정", actorId ? [actorId] : [], card); break;
      }
      case "JAIL_JUDGMENT_RESOLVED": cue("judgment", p.turnSkipped === true ? "감옥 · 차례 건너뛰기" : "감옥 · 탈출!", actorId ? [actorId] : []); break;
      case "BLACK_JACK_CARD_REVEALED": { const card = publicCard(p.card); if (card) cue("judgment", `${name(actorId)} · 블랙 잭 공개`, actorId ? [actorId] : [], card); break; }
    }
  }
  if (version > previous.version) {
    const old = previous.snapshot;
    const oldPlayers = new Map(old.publicTable.players.map(p => [p.playerId, p]));
    const add = (kind: CueKind, label: string, targetIds: string[], card?: CardFaceView) => cues.push({ id: `snapshot:${version}:${kind}:${targetIds.join(":")}`, kind, label, targetIds, ...(card ? { card } : {}) });
    for (const p of snapshot.publicTable.players) {
      const before = oldPlayers.get(p.playerId);
      if (!before) continue;
      if (p.eliminated && !before.eliminated) { add("eliminated", `${p.displayName} · 탈락`, [p.playerId]); continue; }
      if (p.hp !== before.hp && !cues.some(c => c.targetIds.includes(p.playerId) && ["hit", "heal", "explosion"].includes(c.kind))) add(p.hp > before.hp ? "heal" : "hit", `${p.displayName} · 체력 ${p.hp > before.hp ? "+" : ""}${p.hp - before.hp}`, [p.playerId]);
      for (const card of p.inPlay) if (!before.inPlay.some(c => c.cardInstanceId === card.cardInstanceId) && !cues.some(c => c.kind === "pass" && c.targetIds.includes(p.playerId))) { add("equip", `${p.displayName} · 카드 장착`, [p.playerId], card); cues[cues.length - 1].id += `:${card.cardInstanceId}`; cues[cues.length-1].actorId = old.publicTable.turn.currentPlayerId; }
      if (p.handCount > before.handCount && old.pendingInteraction?.kind !== "GENERAL_STORE_PICK") add("draw", `${p.displayName} · 카드 +${p.handCount - before.handCount}`, [p.playerId]);
    }
    const oldPending = old.pendingInteraction;
    const played = snapshot.publicTable.publicDiscard.topCard;
    if (version === previous.version+1 && !oldPending && played && old.publicTable.turn.currentPlayerId === snapshot.publicTable.turn.currentPlayerId && played.cardInstanceId !== old.publicTable.publicDiscard.topCard?.cardInstanceId && !cues.some(c => ["shot","burst","threat","duel","pick","discard"].includes(c.kind))) {
      add("play", "카드 사용", [old.publicTable.turn.currentPlayerId], played);
      cues[cues.length-1].actorId = old.publicTable.turn.currentPlayerId;
    }
    if (oldPending?.kind === "GENERAL_STORE_PICK" && "currentResponderPlayerId" in oldPending) {
      const remaining = new Set(snapshot.publicTable.generalStoreCards?.map(c => c.cardInstanceId));
      const removed = old.publicTable.generalStoreCards?.filter(c => !remaining.has(c.cardInstanceId)) ?? [];
      // A skipped sync must not attribute several unknown picks to a single player.
      if (removed.length === 1) add("pick", `${name(oldPending.currentResponderPlayerId)} · 카드 획득`, [oldPending.currentResponderPlayerId], removed[0]);
    }
    if (old.pendingInteraction?.kind === "DISCARDS_ORDER" && !snapshot.pendingInteraction && old.selfPrivate && snapshot.selfPrivate && snapshot.selfPrivate.hand.length < old.selfPrivate.hand.length) add("discard", "선택한 카드 버리기", [snapshot.viewer.playerId]);
    if (snapshot.pendingInteraction?.kind === "GENERAL_STORE_PICK" && old.pendingInteraction?.kind !== "GENERAL_STORE_PICK") add("store", "잡화점 · 카드를 펼칩니다", []);
    if (snapshot.status === "playing" && old.publicTable.turn.currentPlayerId !== snapshot.publicTable.turn.currentPlayerId) add("turn", `${name(snapshot.publicTable.turn.currentPlayerId)} · 차례 시작`, [snapshot.publicTable.turn.currentPlayerId]);
    if (snapshot.status === "completed" && old.status !== "completed") add("victory", "승부가 결정됐습니다!", [...(snapshot.outcome?.winningPlayerIds ?? [])]);
  }
  return { cursor, cues: cues.slice(-MAX_QUEUED_CUES) };
}

function publicCard(value: unknown): CardFaceView | undefined {
  if (!value || typeof value !== "object") return undefined;
  const c = value as Partial<CardFaceView>;
  return typeof c.cardInstanceId === "string" && typeof c.typeId === "string" && typeof c.rank === "string" && ["SPADES", "HEARTS", "CLUBS", "DIAMONDS"].includes(c.suit ?? "") ? c as CardFaceView : undefined;
}
