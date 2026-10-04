import type {
  CommandAck,
  CardFaceView,
  MatchCommand,
  MatchSnapshotView,
  MatchSyncResponse,
  PendingInteractionResponderView,
  PendingDiscardOrderView,
  PendingRespondOption,
  RespondPayload,
  Suit,
} from "../../../../../packages/contracts/src/protocol.js";

export interface ReactionProjection {
  readonly version: number;
  readonly snapshot: MatchSnapshotView;
}

export interface ReactionOptionPresentation {
  readonly label: string;
  readonly detail: string | null;
}

/** Returns the actor-only pending prompt only when the projection grants it to this viewer. */
export function responderPromptFor(snapshot: MatchSnapshotView): PendingInteractionResponderView | null {
  const pending = snapshot.pendingInteraction;
  if (!pending || !("responseOptions" in pending) ||
      pending.currentResponderPlayerId !== snapshot.viewer.playerId) return null;
  return pending;
}

/** The stored option is the payload authority; only ORDER_CARDS needs user-entered fields. */
export function createRespondPayload(
  option: PendingRespondOption,
  orderedCardInstanceIds?: readonly string[],
): RespondPayload | null {
  if (option.choice === "ORDER_CARDS" && !("orderedCardInstanceIds" in option)) {
    if (!orderedCardInstanceIds) return null;
    return {
      interactionId: option.interactionId,
      choice: option.choice,
      orderedCardInstanceIds: [...orderedCardInstanceIds],
    };
  }
  return { ...option } as RespondPayload;
}

/** Checks a user-entered order only against the responder-only DTO supplied by the server. */
export function isCompleteDiscardOrder(
  discardOrder: PendingDiscardOrderView,
  orderedCardInstanceIds: readonly string[],
): boolean {
  return orderedCardInstanceIds.length === discardOrder.requiredCount &&
    new Set(orderedCardInstanceIds).size === orderedCardInstanceIds.length &&
    orderedCardInstanceIds.every((cardId) => discardOrder.allowedCards.some((card) => card.cardInstanceId === cardId));
}

/** Wraps one server-projected response choice in the canonical v1 command envelope. */
export function createRespondCommand(
  matchId: string,
  expectedVersion: number,
  commandId: string,
  option: PendingRespondOption,
  orderedCardInstanceIds?: readonly string[],
): MatchCommand | null {
  const payload = createRespondPayload(option, orderedCardInstanceIds);
  if (!payload) return null;
  return {
    protocolVersion: 1,
    commandId,
    matchId,
    expectedVersion,
    type: "RESPOND",
    payload,
  };
}

export function projectionFromSync(response: MatchSyncResponse): ReactionProjection {
  return { version: response.version, snapshot: response.snapshot };
}

/** Submit one response, then use the server's new viewer projection as the prompt source. */
export async function sendAndRefreshResponse(
  transport: {
    sendMatchCommand(command: MatchCommand): Promise<CommandAck>;
    syncMatch(matchId: string): Promise<MatchSyncResponse>;
  },
  command: MatchCommand,
  onAcknowledgement?: (acknowledgement: CommandAck) => void,
): Promise<{ acknowledgement: CommandAck; projection: ReactionProjection | null }> {
  const acknowledgement = await transport.sendMatchCommand(command);
  onAcknowledgement?.(acknowledgement);
  if (acknowledgement.status === "accepted" && acknowledgement.matchProjection) {
    return { acknowledgement, projection: { version: acknowledgement.aggregateVersion,
      snapshot: acknowledgement.matchProjection.snapshot } };
  }
  try {
    const response = await transport.syncMatch(command.matchId);
    return {
      acknowledgement,
      projection: response.matchId === command.matchId ? projectionFromSync(response) : null,
    };
  } catch {
    return { acknowledgement, projection: null };
  }
}

export function presentOption(
  option: PendingRespondOption,
  snapshot: MatchSnapshotView,
  position: number,
  total: number,
): ReactionOptionPresentation {
  const label = choiceLabels[option.choice] ?? "선택";
  const detail: string[] = [];
  const ownHandById = new Map(responseVisibleCards(snapshot).map((card) => [card.cardInstanceId, card]));

  if ("cardInstanceId" in option) {
    const card = ownHandById.get(option.cardInstanceId);
    if (card) detail.push(cardFaceLabel(card));
  }
  if ("cardInstanceIds" in option) {
    const cards = option.cardInstanceIds.map((id) => ownHandById.get(id));
    if (cards.every((card) => card !== undefined)) {
      detail.push(cards.map((card) => `${cardName(card!.typeId)} ${card!.rank}`).join(" + "));
    }
  }
  if ("selectedCardInstanceIds" in option) {
    const cards = option.selectedCardInstanceIds.map((id) => ownHandById.get(id));
    if (cards.every((card) => card !== undefined)) {
      detail.push(cards.map((card) => `${cardName(card!.typeId)} ${card!.rank}`).join(" + "));
    }
  }
  if ("selectedCardInstanceId" in option) {
    const card = ownHandById.get(option.selectedCardInstanceId);
    if (card) detail.push(cardFaceLabel(card));
  }
  if ("sourcePlayerId" in option) {
    const player = snapshot.publicTable.players.find((candidate) => candidate.playerId === option.sourcePlayerId);
    if (player) detail.push(`${player.displayName}의 손패에서 무작위 선택`);
  }
  if ("source" in option) {
    detail.push(option.source === "DISCARD_TOP" ? "버림더미 맨 위" : "덱 맨 위");
  }
  if ("targetPlayerId" in option) {
    const player = snapshot.publicTable.players.find((candidate) => candidate.playerId === option.targetPlayerId);
    if (player) detail.push(`${player.displayName}의 손패에서 무작위 선택`);
  }

  if ("orderedCardInstanceIds" in option) {
    detail.push(`버릴 순서: ${option.orderedCardInstanceIds.map(id => {
      const card = ownHandById.get(id);
      return card ? cardFaceLabel(card) : "카드";
    }).join(" → ")}`);
  }
  const ordinal = total > 1 ? `선택 ${position + 1}` : null;
  return { label: ordinal ? `${label} · ${ordinal}` : label, detail: detail.length > 0 ? detail.join(" · ") : null };
}

/** Only explicit face DTOs: own hand and the public General Store pool. */
export function responseVisibleCards(snapshot: MatchSnapshotView): readonly CardFaceView[] {
  const pending = responderPromptFor(snapshot);
  return [...(snapshot.selfPrivate?.hand ?? []), ...(snapshot.publicTable.generalStoreCards ?? []),
    ...(snapshot.publicTable.luckyJudgment?.cards ?? []), ...(pending?.choiceCards ?? [])];
}

export function interactionLabel(kind: string): string {
  return interactionLabels[kind] ?? "응답";
}

export function responderName(snapshot: MatchSnapshotView, playerId: string): string {
  return snapshot.publicTable.players.find((player) => player.playerId === playerId)?.displayName ?? "현재 응답자";
}

function cardName(typeId: string): string {
  return cardNames[typeId] ?? "카드";
}

export function cardFaceLabel(card: CardFaceView): string {
  return `${cardName(card.typeId)} ${card.rank} ${suitName(card.suit)}`;
}

function suitName(suit: Suit): string {
  switch (suit) {
    case "SPADES": return "스페이드";
    case "HEARTS": return "하트";
    case "DIAMONDS": return "다이아몬드";
    case "CLUBS": return "클럽";
  }
}

const choiceLabels: Readonly<Record<string, string>> = Object.freeze({
  USE_MISSED: "빗나감! 사용",
  USE_BANG: "뱅! 사용",
  PLAY_BANG: "뱅! 제출",
  USE_BEER: "맥주로 구제",
  USE_BARREL: "술통 판정",
  USE_JOURDONNAIS: "주르도네 판정",
  TAKE_HIT: "피해 받기",
  YIELD: "결투 포기",
  ACCEPT_ELIMINATION: "탈락 수락",
  DRAW_PILE: "덱에서 뽑기",
  DRAW_FROM_PILE: "덱에서 가져오기",
  TAKE_FROM_HAND: "손패에서 가져오기",
  USE_SID: "시드 능력으로 구제",
  ORDER_CARDS: "카드 버릴 순서 정하기",
  TAKE_CARD: "카드 가져오기",
  CHOOSE_CARD: "카드 선택",
  CHOOSE_CARDS: "카드 2장 선택",
  OPPONENT_HAND: "상대 손패에서 무작위 선택",
  CHOOSE_SOURCE: "가져올 곳 선택",
  SELECT_SOURCE: "가져올 곳 선택",
  SELECT_JUDGMENT: "판정 카드 선택",
});

const interactionLabels: Readonly<Record<string, string>> = Object.freeze({
  BANG_RESPONSE: "뱅! 응답",
  INDIANS_RESPONSE: "인디언! 응답",
  GATLING_RESPONSE: "개틀링 응답",
  DUEL_RESPONSE: "결투 응답",
  DEATH_RESCUE: "생명력 구제",
  DISCARDS_ORDER: "카드 정리",
  GENERAL_STORE_PICK: "잡화점 선택",
  KIT_CARLSON_PICK: "킷 칼슨 선택",
  LUCKY_DRAW: "럭키 판정 선택",
  JESSE_FIRST_DRAW: "제시의 첫 카드 선택",
  PEDRO_DISCARD_TOP: "페드로의 카드 원천 선택",
});

const cardNames: Readonly<Record<string, string>> = Object.freeze({
  bang: "뱅!",
  missed: "빗나감!",
  beer: "맥주",
  saloon: "술집",
  stagecoach: "역마차",
  wells_fargo: "웰스 파고",
  general_store: "잡화점",
  panic: "패닉!",
  cat_balou: "캣 벌루",
  gatling: "개틀링",
  indians: "인디언!",
  duel: "결투",
  barrel: "술통",
  jail: "감옥",
  dynamite: "다이너마이트",
  mustang: "머스탱",
  scope: "조준경",
  volcanic: "볼캐닉",
  schofield: "스코필드",
  remington: "레밍턴",
  carabine: "레밍턴 카빈",
  winchester: "윈체스터",
});
