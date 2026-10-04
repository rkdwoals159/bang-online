import type {
  MatchOutcomeView,
  MatchSnapshotView,
  MatchStatus,
  MatchSyncResponse,
  PublicMatchEvent,
  RoleId,
} from "../../../../../packages/contracts/src/protocol.js";

export type MatchStatusSync = Pick<
  MatchSyncResponse,
  "version" | "snapshot" | "visibleEvents"
>;

type StatusPlayer = Pick<
  MatchSnapshotView["publicTable"]["players"][number],
  "playerId" | "displayName" | "role"
>;

export interface MatchStatusProjection {
  version: number;
  status: MatchStatus;
  turn: MatchSnapshotView["publicTable"]["turn"];
  players: readonly StatusPlayer[];
  outcome: MatchOutcomeView | null;
  visibleEvents: readonly PublicMatchEvent[];
}

export interface PublicLogEntry {
  eventSeq: number;
  message: string;
}

export interface RevealedRoleEntry {
  playerName: string;
  roleLabel: string;
}

export interface MatchStatusViewModel {
  status: MatchStatus;
  statusLabel: string;
  statusMessage: string;
  currentPlayerName: string;
  phaseLabel: string;
  inputEnabled: boolean;
  resultTitle: string | null;
  resultMessage: string | null;
  winningFactionLabel: string | null;
  winningPlayerNames: readonly string[];
  revealedRoles: readonly RevealedRoleEntry[];
  publicLog: readonly PublicLogEntry[];
}

const statusLabels: Record<MatchStatus, string> = {
  playing: "게임 진행 중",
  paused: "게임 일시 정지",
  completed: "게임 종료",
  recovery_required: "복구 확인 필요",
};

const phaseLabels: Readonly<Record<string, string>> = Object.freeze({
  start: "턴 시작",
  draw: "카드 뽑기",
  play: "카드 사용",
  discard: "손패 정리",
});

const winningFactionLabels: Readonly<Record<MatchOutcomeView["winningFaction"], string>> = Object.freeze({
  sheriff_and_deputies: "보안관 진영",
  outlaws: "무법자 진영",
  renegade: "배신자 진영",
});

const roleLabels: Readonly<Record<RoleId, string>> = Object.freeze({
  sheriff: "보안관",
  deputy: "부관",
  outlaw: "무법자",
  renegade: "배신자",
});

/** Only named public event kinds and explicitly allowlisted projected fields are shown. */
const publicEventMessages: Readonly<Record<string, string>> = Object.freeze({
  BANG_ATTACKED: "뱅! 공격이 시작됐어요.",
  BANG_HIT: "뱅! 공격이 적중했어요.",
  BANG_MISSED: "뱅! 공격을 피했어요.",
  GATLING_STARTED: "개틀링 공격이 시작됐어요.",
  GATLING_HIT: "개틀링 공격이 적중했어요.",
  GATLING_MISSED: "개틀링 공격을 피했어요.",
  INDIANS_STARTED: "인디언!이 시작됐어요.",
  INDIANS_HIT: "인디언!의 피해가 적용됐어요.",
  INDIANS_DEFENDED: "인디언!에 대응했어요.",
  DUEL_STARTED: "결투가 시작됐어요.",
  DUEL_YIELDED: "결투가 끝났어요.",
  DUEL_BANG_PLAYED: "결투에서 뱅!을 냈어요.",
  BEER_USED: "맥주를 사용했어요.",
  SALOON_USED: "술집을 사용했어요.",
  PLAYER_HEALED: "생명력이 회복됐어요.",
  DYNAMITE_EXPLODED: "다이너마이트가 폭발했어요.",
  DYNAMITE_PASSED: "다이너마이트가 전달됐어요.",
  BARREL_CHECK_REQUESTED: "술통 판정이 시작됐어요.",
  BARREL_JUDGMENT_REVEALED: "술통 판정 카드가 공개됐어요.",
  DYNAMITE_JUDGMENT_REVEALED: "다이너마이트 판정 카드가 공개됐어요.",
  JAIL_JUDGMENT_REVEALED: "감옥 판정 카드가 공개됐어요.",
  BARREL_CHECK_RESOLVED: "술통 판정이 끝났어요.",
  JAIL_JUDGMENT_RESOLVED: "감옥 판정이 끝났어요.",
  GENERAL_STORE_CARD_REVEALED: "잡화점 카드가 공개됐어요.",
});

function isValidEventSeq(event: PublicMatchEvent): boolean {
  return Number.isSafeInteger(event.eventSeq) && event.eventSeq >= 0;
}

/** Sorts by public event sequence, preserves gaps, and keeps the first copy of each sequence. */
export function mergePublicEvents(
  currentEvents: readonly PublicMatchEvent[],
  incomingEvents: readonly PublicMatchEvent[],
): PublicMatchEvent[] {
  const eventsBySeq = new Map<number, PublicMatchEvent>();

  for (const event of currentEvents) {
    if (isValidEventSeq(event) && !eventsBySeq.has(event.eventSeq)) {
      eventsBySeq.set(event.eventSeq, event);
    }
  }

  const orderedIncoming = [...incomingEvents]
    .filter(isValidEventSeq)
    .sort((left, right) => left.eventSeq - right.eventSeq);
  for (const event of orderedIncoming) {
    if (!eventsBySeq.has(event.eventSeq)) eventsBySeq.set(event.eventSeq, event);
  }

  return [...eventsBySeq.values()].sort((left, right) => left.eventSeq - right.eventSeq);
}

/**
 * Accepts only current or newer sync projections. A late older sync reply
 * cannot move the displayed turn/status backwards.
 */
export function mergeMatchStatusProjection(
  current: MatchStatusProjection | null,
  incoming: MatchStatusSync,
): MatchStatusProjection {
  if (current && incoming.version < current.version) return current;

  return {
    version: incoming.version,
    status: incoming.snapshot.status,
    turn: { ...incoming.snapshot.publicTable.turn },
    players: incoming.snapshot.publicTable.players.map(({ playerId, displayName, role }) => ({
      playerId,
      displayName,
      // A role is shown in the result panel only after the server marks the
      // match completed and projects every role into the public table.
      role: incoming.snapshot.status === "completed" ? role : null,
    })),
    outcome: incoming.snapshot.status === "completed"
      ? incoming.snapshot.outcome ?? null
      : null,
    visibleEvents: mergePublicEvents(current?.visibleEvents ?? [], incoming.visibleEvents),
  };
}

/** Only a server-projected playing state may expose the action input surface. */
export function isMatchActionInputEnabled(status: MatchStatus): boolean {
  return status === "playing";
}

function publicName(payload: Readonly<Record<string, unknown>>, key: string, players: ReadonlyMap<string, string>): string | null {
  const id = payload[key];
  return typeof id === "string" ? players.get(id) ?? null : null;
}

function publicNames(payload: Readonly<Record<string, unknown>>, key: string, players: ReadonlyMap<string, string>): string[] {
  const ids = payload[key];
  return Array.isArray(ids)
    ? ids.flatMap((id) => typeof id === "string" && players.has(id) ? [players.get(id)!] : [])
    : [];
}

function publicDamage(payload: Readonly<Record<string, unknown>>): string {
  const damage = payload.damage;
  return typeof damage === "number" && Number.isSafeInteger(damage) && damage > 0
    ? ` · 피해 ${damage}`
    : "";
}

export function formatPublicEvent(
  event: PublicMatchEvent,
  players: ReadonlyMap<string, string> = new Map(),
): string | null {
  const fallback = publicEventMessages[event.type];
  if (!fallback) return null;
  const payload = event.payload;
  const actor = publicName(payload, "actorPlayerId", players);
  const target = publicName(payload, "targetPlayerId", players);
  const initiator = publicName(payload, "initiatorPlayerId", players);
  const responder = publicName(payload, "responderPlayerId", players);
  const damage = publicDamage(payload);

  switch (event.type) {
    case "BANG_ATTACKED": return actor && target ? `${actor} 님이 ${target} 님을 뱅!으로 공격해요.` : fallback;
    case "BANG_HIT": return actor && target ? `${actor} 님의 뱅!이 ${target} 님에게 적중했어요${damage}.` : fallback;
    case "BANG_MISSED": return target ? `${target} 님이 뱅!을 피했어요.` : fallback;
    case "GATLING_STARTED": {
      const targets = publicNames(payload, "targetPlayerIds", players);
      return actor && targets.length ? `${actor} 님이 개틀링을 사용했어요 · 대상 ${targets.join(", ")}` : fallback;
    }
    case "GATLING_HIT": return actor && target ? `${actor} 님의 개틀링이 ${target} 님에게 적중했어요${damage}.` : fallback;
    case "GATLING_MISSED": return target ? `${target} 님이 개틀링을 피했어요.` : fallback;
    case "INDIANS_STARTED": {
      const targets = publicNames(payload, "targetPlayerIds", players);
      return actor && targets.length ? `${actor} 님이 인디언!을 사용했어요 · 대상 ${targets.join(", ")}` : fallback;
    }
    case "INDIANS_HIT": return actor && target ? `${actor} 님의 인디언!이 ${target} 님에게 적중했어요${damage}.` : fallback;
    case "INDIANS_DEFENDED": return target ? `${target} 님이 인디언!에 대응했어요.` : fallback;
    case "DUEL_STARTED": return initiator && target ? `${initiator} 님과 ${target} 님의 결투가 시작됐어요.` : fallback;
    case "DUEL_YIELDED": return publicName(payload, "playerId", players)
      ? `${publicName(payload, "playerId", players)} 님이 결투를 끝냈어요${damage}.` : fallback;
    case "DUEL_BANG_PLAYED": return responder ? `${responder} 님이 결투에서 뱅!을 냈어요.` : fallback;
    case "BEER_USED": return actor ? `${actor} 님이 맥주를 사용했어요.` : fallback;
    case "SALOON_USED": return actor ? `${actor} 님이 술집을 사용했어요.` : fallback;
    case "PLAYER_HEALED": return target ? `${target} 님의 생명력이 회복됐어요.` : fallback;
    case "DYNAMITE_EXPLODED": return target ? `${target} 님에게 다이너마이트가 폭발했어요${damage}.` : fallback;
    case "DYNAMITE_PASSED": {
      const from = publicName(payload, "fromPlayerId", players);
      const to = publicName(payload, "toPlayerId", players);
      return from && to ? `${from} 님이 ${to} 님에게 다이너마이트를 넘겼어요.` : fallback;
    }
    case "BARREL_CHECK_REQUESTED": return target ? `${target} 님의 술통 판정이 시작됐어요.` : fallback;
    case "BARREL_CHECK_RESOLVED": {
      const succeeded = payload.succeeded;
      return target && typeof succeeded === "boolean"
        ? `${target} 님의 술통 판정 ${succeeded ? "성공" : "실패"}이에요.`
        : fallback;
    }
    default: return fallback;
  }
}

export function buildMatchStatusViewModel(
  projection: MatchStatusProjection,
): MatchStatusViewModel {
  const currentPlayer = projection.players.find(
    ({ playerId }) => playerId === projection.turn.currentPlayerId,
  );
  const inputEnabled = isMatchActionInputEnabled(projection.status);
  const resultTitle = projection.status === "completed" ? "게임 결과" : null;
  const resultMessage = projection.status === "completed"
    ? "게임이 끝났어요."
    : null;
  const completedOutcome = projection.status === "completed" ? projection.outcome : null;
  const playersById = new Map(projection.players.map(({ playerId, displayName }) => [playerId, displayName]));
  const winningPlayerNames = completedOutcome
    ? completedOutcome.winningPlayerIds.flatMap((playerId) => {
        const displayName = playersById.get(playerId);
        return displayName === undefined ? [] : [displayName];
      })
    : [];
  const revealedRoles = projection.status === "completed"
    ? projection.players.flatMap(({ displayName, role }) => role
      ? [{ playerName: displayName, roleLabel: roleLabels[role] }]
      : [])
    : [];

  let statusMessage: string;
  switch (projection.status) {
    case "playing":
      statusMessage = "현재 차례와 진행 단계예요.";
      break;
    case "paused":
      statusMessage = "게임이 일시 정지되어 행동을 입력할 수 없습니다.";
      break;
    case "completed":
      statusMessage = "게임이 종료되었습니다.";
      break;
    case "recovery_required":
      statusMessage = "게임 정보를 복구하고 있어요. 행동을 잠시 기다려 주세요.";
      break;
  }

  return {
    status: projection.status,
    statusLabel: statusLabels[projection.status],
    statusMessage,
    currentPlayerName: currentPlayer?.displayName ?? "현재 플레이어",
    phaseLabel: phaseLabels[projection.turn.phase] ?? "현재 단계",
    inputEnabled,
    resultTitle,
    resultMessage,
    winningFactionLabel: completedOutcome
      ? winningFactionLabels[completedOutcome.winningFaction]
      : null,
    winningPlayerNames,
    revealedRoles,
    publicLog: projection.visibleEvents.flatMap((event) => {
      const message = formatPublicEvent(event, playersById);
      return message === null ? [] : [{ eventSeq: event.eventSeq, message }];
    }),
  };
}
