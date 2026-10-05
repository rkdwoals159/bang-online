import type { MatchSnapshotView, PublicMatchEvent, TablewideAttackView } from "../../../../../packages/contracts/src/protocol.js";

/** Render accepted choices separately from applied effects. No inferred outcomes. */
export function tablewideResponseLabel(target: TablewideAttackView["targets"][number], pending: MatchSnapshotView["pendingInteraction"]): string {
  const chosen = target.status === "submitted";
  const responding = target.status === "responding";
  const suffix = chosen ? " 선택" : "";
  if (target.response === "TAKE_HIT") return `♥ −1${suffix}${target.status === "eliminated" ? " · 탈락" : responding && pending?.kind === "DEATH_RESCUE" ? " · 구제 중" : ""}`;
  if (target.status === "eliminated") return "탈락";
  if (target.response === "USE_BANG") return `뱅!${suffix}`;
  if (target.response === "USE_MISSED") return `빗나감!${suffix}`;
  if (target.response === "USE_BARREL" || target.response === "USE_JOURDONNAIS") {
    const name = target.response === "USE_BARREL" ? "술통" : "인물 능력";
    return chosen ? `${name} 선택` : responding ? pending?.kind === "GATLING_RESPONSE" ? "다시 선택" : `${name} 판정 중` : `${name} · 방어`;
  }
  return chosen ? "선택함" : target.status === "resolved" ? "대응 마침" : "선택 중";
}

/** Complete only the attack just observed; older events cannot supply a result. */
export function finishTablewideAttack(attack: TablewideAttackView, snapshot: MatchSnapshotView, events: readonly PublicMatchEvent[], afterEventSeq: number): TablewideAttackView {
  return { ...attack, targets: attack.targets.map(target => {
    const fresh = events.filter(event => event.eventSeq > afterEventSeq && event.payload.targetPlayerId === target.playerId);
    const outcome = [...fresh].sort((a,b)=>b.eventSeq-a.eventSeq).find(event => (attack.kind === "indians" ? ["INDIANS_HIT","INDIANS_DEFENDED"] : ["GATLING_HIT","GATLING_MISSED"]).includes(event.type));
    const barrelSucceeded = fresh.some(event=>event.type === "BARREL_CHECK_RESOLVED" && event.payload.succeeded === true && event.payload.attackKind === "GATLING");
    const preserveBarrel = (target.status === "resolved" || barrelSucceeded) && (target.response === "USE_BARREL" || target.response === "USE_JOURDONNAIS");
    const response = outcome?.type.endsWith("_HIT") ? "TAKE_HIT" : outcome?.type === "INDIANS_DEFENDED" ? "USE_BANG"
      : outcome?.type === "GATLING_MISSED" ? preserveBarrel ? target.response : "USE_MISSED" : target.response;
    return { playerId: target.playerId, status: snapshot.publicTable.players.find(player=>player.playerId === target.playerId)?.eliminated ? "eliminated" : "resolved", ...(response ? {response} : {}) };
  }) };
}
