import type {
  CommandAck,
  LegalActionProposal,
  MatchCommand,
  MatchSnapshotView,
  MatchSyncResponse,
} from "../../../../../packages/contracts/src/protocol.js";

export interface ActionsProjection {
  readonly version: number;
  readonly snapshot: MatchSnapshotView;
}

export interface ActionTargetOption {
  readonly index: number;
  readonly label: string;
}

/**
 * Returns only server-projected PLAY_CARD proposals for a physical card in
 * the viewer's hand. This does not infer card legality or create candidates.
 */
export function getCardProposalIndexes(
  actions: readonly LegalActionProposal[],
  cardInstanceId: string,
): number[] {
  return actions.flatMap((action, index) =>
    action.type === "PLAY_CARD" && action.payload.cardInstanceId === cardInstanceId ? [index] : [],
  );
}

/**
 * Builds labels for exact server candidates. Candidate membership and payloads
 * remain untouched; this helper only resolves visible names from the projection.
 */
export function getTargetOptions(
  snapshot: MatchSnapshotView,
  actions: readonly LegalActionProposal[],
  proposalIndexes: readonly number[],
): ActionTargetOption[] {
  return proposalIndexes.flatMap((index) => {
    const action = actions[index];
    if (!action || action.type !== "PLAY_CARD") return [];
    const { targetPlayerId, targetZone, targetCardInstanceId, asCardType } = action.payload;
    const targetPlayer = targetPlayerId
      ? snapshot.publicTable.players.find((player) => player.playerId === targetPlayerId)
      : undefined;
    const targetCard = targetCardInstanceId
      ? snapshot.publicTable.players
        .flatMap((player) => player.inPlay)
        .find((card) => card.cardInstanceId === targetCardInstanceId)
      : undefined;
    const labelParts: string[] = [];

    if (targetPlayerId) labelParts.push(targetPlayer?.displayName ?? "대상 플레이어");
    if (targetZone === "HAND") labelParts.push("손패에서 무작위 카드 1장");
    else if (targetZone === "IN_PLAY") {
      labelParts.push(targetCard ? cardName(targetCard.typeId) : "장착 카드 선택");
    }
    if (asCardType) labelParts.push(`${cardName(asCardType)}으로 사용`);

    return [{
      index,
      label: labelParts.join(" · "),
    }];
  });
}

/** Describes publicly knowable cases where a legally proposed Beer play restores no HP. */
export function noHealBeerReasons(snapshot: MatchSnapshotView, cardInstanceId: string): string[] {
  const card = snapshot.selfPrivate?.hand.find(({ cardInstanceId: id }) => id === cardInstanceId);
  if (card?.typeId !== "beer") return [];

  const viewer = snapshot.publicTable.players.find(({ playerId }) => playerId === snapshot.viewer.playerId);
  if (!viewer) return [];
  const reasons: string[] = [];
  if (viewer.hp >= viewer.maxHp) reasons.push("현재 생명력이 최대라 회복량은 0이에요.");
  const livingPlayerCount = snapshot.publicTable.players.filter(({ eliminated }) => !eliminated).length;
  if (livingPlayerCount === 2) reasons.push("생존자가 2명일 때는 맥주 회복량이 0이에요.");
  return reasons;
}

/** Finds an exact server-projected two-card ability proposal; never synthesizes a payload. */
export function findSidAbilityProposalIndex(
  actions: readonly LegalActionProposal[],
  firstCardInstanceId: string | null,
  secondCardInstanceId: string | null,
): number | null {
  if (!firstCardInstanceId || !secondCardInstanceId || firstCardInstanceId === secondCardInstanceId) return null;
  const index = actions.findIndex((action) => action.type === "USE_ABILITY" &&
    action.payload.cardInstanceIds.length === 2 &&
    (action.costSelection?.allowedCardInstanceIds ?? action.payload.cardInstanceIds).includes(firstCardInstanceId) &&
    (action.costSelection?.allowedCardInstanceIds ?? action.payload.cardInstanceIds).includes(secondCardInstanceId));
  return index < 0 ? null : index;
}

/** Expands only a pair explicitly authorized by the server's compact Sid cost set. */
export function resolveSidAbilityProposal(proposal: LegalActionProposal, first: string | null, second: string | null): LegalActionProposal | null {
  if (proposal.type !== "USE_ABILITY" || !proposal.costSelection) return proposal;
  if (!first || !second || first === second || !proposal.costSelection.allowedCardInstanceIds.includes(first) ||
      !proposal.costSelection.allowedCardInstanceIds.includes(second)) return null;
  return { type: "USE_ABILITY", payload: { abilityId: proposal.payload.abilityId, cardInstanceIds: [first, second] } };
}

/** Creates the v1 command envelope from one exact proposal and current version. */
export function createActionCommand(
  matchId: string,
  expectedVersion: number,
  commandId: string,
  proposal: LegalActionProposal,
): MatchCommand {
  return {
    protocolVersion: 1,
    commandId,
    matchId,
    expectedVersion,
    type: proposal.type,
    payload: proposal.payload,
  } as MatchCommand;
}

export function projectionFromSync(response: MatchSyncResponse): ActionsProjection {
  return { version: response.version, snapshot: response.snapshot };
}

/** Submit one canonical proposal, then request the latest server projection. */
export async function sendAndRefreshAction(
  transport: {
    sendMatchCommand(command: MatchCommand): Promise<CommandAck>;
    syncMatch(matchId: string): Promise<MatchSyncResponse>;
  },
  command: MatchCommand,
  onAcknowledgement?: (acknowledgement: CommandAck) => void,
): Promise<{ acknowledgement: CommandAck; projection: ActionsProjection | null }> {
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

export function cardName(typeId: string): string {
  return cardNames[typeId] ?? "카드";
}

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
