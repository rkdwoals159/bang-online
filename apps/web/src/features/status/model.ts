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

/**
 * Only deliberately public event kinds are turned into log copy. Payloads
 * are not inspected or serialized by this UI.
 */
const publicEventMessages: Readonly<Record<string, string>> = Object.freeze({
  BANG_ATTACKED: "뱅 공격이 시작됐어요.",
  BANG_HIT: "뱅 공격 피해가 적용됐어요.",
  BANG_MISSED: "뱅 공격을 피했어요.",
  GATLING_STARTED: "개틀링이 사용됐어요.",
  GATLING_HIT: "개틀링 공격 피해가 적용됐어요.",
  GATLING_MISSED: "개틀링 공격을 피했어요.",
  INDIANS_STARTED: "인디언!이 사용됐어요.",
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

export function formatPublicEvent(event: PublicMatchEvent): string | null {
  return publicEventMessages[event.type] ?? null;
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
    ? "게임이 종료되어 더 이상 행동을 입력할 수 없습니다."
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
      statusMessage = "서버에서 확인한 현재 차례와 단계입니다.";
      break;
    case "paused":
      statusMessage = "게임이 일시 정지되어 행동을 입력할 수 없습니다.";
      break;
    case "completed":
      statusMessage = "게임이 종료되었습니다.";
      break;
    case "recovery_required":
      statusMessage = "서버 복구 확인이 필요해 행동을 입력할 수 없습니다.";
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
      const message = formatPublicEvent(event);
      return message === null ? [] : [{ eventSeq: event.eventSeq, message }];
    }),
  };
}
