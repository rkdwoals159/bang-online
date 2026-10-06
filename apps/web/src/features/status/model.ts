import { cardName } from "../actions/model.js";
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

/** Bound rendered rows while retaining history for pagination. */
export const PUBLIC_LOG_PAGE_SIZE = 100;

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
  occurredAt: string;
  message: string;
}

export function formatLogTime(occurredAt: string, now: number): string {
  const date = new Date(occurredAt);
  if (!Number.isFinite(date.getTime())) return "시간 정보 없음";
  const clock = [date.getHours(), date.getMinutes(), date.getSeconds()].map(value => String(value).padStart(2, "0")).join(":");
  const seconds = Math.max(0, Math.floor((now - date.getTime()) / 1000));
  return `${clock}(${seconds < 60 ? `${seconds}초 전` : `${Math.floor(seconds / 60)}분 전`})`;
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
  BLACK_JACK_CARD_REVEALED: "블랙 잭의 두 번째 카드가 공개됐어요.",
  GENERAL_STORE_CARD_REVEALED: "잡화점 카드가 공개됐어요.",
  PANIC_USED: "패닉!으로 카드를 가져왔어요.",
  CAT_BALOU_USED: "캣 벌루로 카드를 버렸어요.",
  CARD_USED: "카드를 사용했어요.",
  CARD_EQUIPPED: "카드를 장착했어요.",
  PUBLIC_CARD_DISCARDED: "카드를 버렸어요.",
  PUBLIC_CARD_TAKEN: "다른 플레이어의 카드를 가져왔어요.",
  STORE_CARD_PICKED: "잡화점에서 카드를 가져왔어요.",
  STORE_CARD_DISCARDED: "잡화점의 남은 카드를 버렸어요.",
  CARD_RECEIVED: "카드를 받았어요.",
  DISCARD_CARD_TAKEN: "버림더미에서 카드를 가져왔어요.",
  PLAYER_ELIMINATED: "플레이어가 탈락했어요.",
  MATCH_COMPLETED: "게임이 끝났어요.",
  DRAW_PILE_RESHUFFLED: "버림더미를 섞어 덱을 다시 만들었어요.",
  RULE_RESOURCE_EXHAUSTED: "덱에 카드가 부족해 진행이 멈췄어요.",
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

  return [...eventsBySeq.values()]
    .sort((left, right) => left.eventSeq - right.eventSeq);
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
    case "PANIC_USED": return actor && target ? `${actor} 님이 패닉!으로 ${target} 님의 ${payload.targetZone === "in_play" ? "장착 카드" : "손패"} 1장을 가져왔어요.` : fallback;
    case "CAT_BALOU_USED": return actor && target ? `${actor} 님이 캣 벌루로 ${target} 님의 ${payload.targetZone === "in_play" ? "장착 카드" : "손패"} 1장을 버렸어요.` : fallback;
    case "CARD_USED": return actor ? `${actor} 님이 ${cardName(String(payload.cardType ?? ""))} 카드를 사용했어요.` : fallback;
    case "CARD_EQUIPPED": return actor && target ? `${actor} 님이 ${target === actor ? "" : `${target} 님에게 `}${cardName(String(payload.cardType ?? ""))} 카드를 장착했어요.` : fallback;
    case "PUBLIC_CARD_DISCARDED": return target ? `${target} 님이 ${cardName(String(payload.cardType ?? ""))} 1장을 버렸어요${payload.fromZone === "in_play" ? " · 장착 해제" : ""}.` : fallback;
    case "PUBLIC_CARD_TAKEN": return actor && target ? `${actor} 님이 ${target} 님의 ${payload.targetZone === "in_play" ? "장착 카드" : "손패"} 1장을 가져왔어요.` : fallback;
    case "STORE_CARD_PICKED": return actor ? `${actor} 님이 잡화점에서 ${cardName(String(payload.cardType ?? ""))} 1장을 가져왔어요.` : fallback;
    case "STORE_CARD_DISCARDED": return `잡화점의 ${cardName(String(payload.cardType ?? ""))} 1장을 버렸어요.`;
    case "CARD_RECEIVED": return actor ? `${actor} 님이 카드 1장을 받았어요.` : fallback;
    case "DISCARD_CARD_TAKEN": return actor ? `${actor} 님이 버림더미에서 ${cardName(String(payload.cardType ?? ""))} 1장을 가져왔어요.` : fallback;
    case "PLAYER_ELIMINATED": {
      const player = publicName(payload, "playerId", players);
      return player ? `${player} 님이 탈락했어요.` : fallback;
    }
    case "MATCH_COMPLETED": return "게임이 끝났어요.";
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
    case "PLAYER_HEALED": return target ? `${target} 님의 생명력 +${typeof payload.amount === "number" ? payload.amount : 1}${payload.cause === "SID" ? " · 시드 케첨 능력" : ""}.` : fallback;
    case "DYNAMITE_EXPLODED": return target ? `${target} 님에게 다이너마이트가 폭발했어요${damage}.` : fallback;
    case "DYNAMITE_PASSED": {
      const from = publicName(payload, "fromPlayerId", players);
      const to = publicName(payload, "toPlayerId", players);
      return from && to ? `${from} 님이 ${to} 님에게 다이너마이트를 넘겼어요.` : fallback;
    }
    case "BLACK_JACK_CARD_REVEALED": {
      const card = payload.card as { typeId?: string; rank?: string; suit?: string } | undefined;
      const suits: Record<string, string> = { HEARTS: "하트", DIAMONDS: "다이아몬드", SPADES: "스페이드", CLUBS: "클럽" };
      return actor && card ? `${actor} 님의 두 번째 카드: ${cardName(card.typeId ?? "")} ${card.rank ?? ""} ${suits[card.suit ?? ""] ?? ""}` : fallback;
    }
    case "BARREL_CHECK_REQUESTED": return target ? `${target} 님의 술통 판정이 시작됐어요.` : fallback;
    case "BARREL_CHECK_RESOLVED": {
      const succeeded = payload.succeeded;
      return target && typeof succeeded === "boolean"
        ? `${target} 님의 술통 판정 ${succeeded ? "성공" : "실패"}이에요.`
        : fallback;
    }
    case "JAIL_JUDGMENT_RESOLVED": return actor ? `${actor} 님의 감옥 판정: ${payload.turnSkipped === true ? "이번 차례를 건너뛰어요" : "탈출했어요"}.` : fallback;
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
      return message === null ? [] : [{ eventSeq: event.eventSeq, occurredAt: event.occurredAt, message }];
    }).sort((a, b) => b.eventSeq - a.eventSeq),
  };
}
