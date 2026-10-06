import { useGameExperience } from "../experience/GameExperience.js";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CommandAck,
  MatchCommand,
  MatchSnapshotView,
  MatchSyncResponse,
} from "../../../../../packages/contracts/src/protocol.js";
import { getPlayingCardDescription, PlayingCardZoomButton } from "../cards/CardFaces.js";
import {
  cardName,
  createActionCommand,
  findSidAbilityProposalIndex,
  resolveSidAbilityProposal,
  getCardProposalIndexes,
  getTargetOptions,
  noHealBeerReasons,
  projectionFromSync,
  sendAndRefreshAction,
  type ActionsProjection,
} from "./model.js";
import "./actions.css";
import { ChoiceStage } from "../experience/ChoiceStage.js";
import { useCommandRecovery } from "../feedback/hooks.js";
import type { RecoveryTransport } from "../feedback/recovery.js";

export interface ActionTransport extends RecoveryTransport {
  sendMatchCommand(command: MatchCommand): Promise<CommandAck>;
  syncMatch(matchId: string): Promise<MatchSyncResponse>;
}

export interface ActionsPanelProps {
  readonly variant?: "panel" | "scene";
  readonly matchId: string;
  /** Version accompanying the supplied server projection. */
  readonly version: number;
  readonly snapshot: MatchSnapshotView;
  readonly transport: ActionTransport;
  /** Injectable to keep envelope/idempotency behavior deterministic in tests. */
  readonly createCommandId?: () => string;
}

type ActionSelection =
  | { readonly matchId: string; readonly version: number; readonly kind: "card"; readonly cardInstanceId: string; readonly proposalIndex: number | null };
type NoHealBeerConfirmation = {
  readonly matchId: string;
  readonly version: number;
  readonly cardInstanceId: string;
  readonly proposalIndex: number;
};
type SidAbilitySelection = {
  readonly matchId: string;
  readonly version: number;
  readonly firstCardInstanceId: string | null;
  readonly secondCardInstanceId: string | null;
};
type CardSuit = MatchSnapshotView["publicTable"]["players"][number]["inPlay"][number]["suit"];

const createDefaultCommandId = (): string => globalThis.crypto.randomUUID();

/** A command surface driven entirely by the authenticated viewer's projection. */
export function ActionsPanel({
  matchId,
  version,
  snapshot,
  transport,
  createCommandId = createDefaultCommandId,
  variant = "panel",
}: ActionsPanelProps) {
  const [abilityOpen, setAbilityOpen] = useState(false);
  const experience = useGameExperience();
  const [syncedProjection, setSyncedProjection] = useState<(ActionsProjection & { readonly matchId: string }) | null>(null);
  const [selection, setSelection] = useState<ActionSelection | null>(null);
  const [noHealBeerConfirmation, setNoHealBeerConfirmation] = useState<NoHealBeerConfirmation | null>(null);
  const [sidAbilitySelection, setSidAbilitySelection] = useState<SidAbilitySelection | null>(null);
  const [pendingCommand, setPendingCommand] = useState<MatchCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [notice, setNotice] = useState("");
  const busyRef = useRef(false);
  const currentMatchIdRef = useRef(matchId);

  useEffect(() => {
    currentMatchIdRef.current = matchId;
    setSyncedProjection(null);
    setSelection(null);
    setNoHealBeerConfirmation(null);
    setSidAbilitySelection(null);
    setPendingCommand(null);
    setBusy(false);
    setNeedsRefresh(false);
    setNotice("");
    busyRef.current = false;
  }, [matchId]);

  const projection = syncedProjection?.matchId === matchId && syncedProjection.version >= version
    ? syncedProjection
    : { version, snapshot };
  const currentSnapshot = projection.snapshot;
  const actions = currentSnapshot.legalActions ?? [];
  const visibleSelection = selection?.matchId === matchId && selection.version === projection.version ? selection : null;
  const selectionExpired = selection?.matchId === matchId && selection.version !== projection.version;
  const activePendingCommand = pendingCommand?.matchId === matchId ? pendingCommand : null;
  useCommandRecovery(transport, activePendingCommand, busy, (ack, response) => {
    if (currentMatchIdRef.current !== response.matchId) return;
    const incoming = projectionFromSync(response);
    setSyncedProjection(current => current?.matchId === matchId && current.version > incoming.version
      ? current : { ...incoming, matchId });
    setPendingCommand(null);
    setNeedsRefresh(false);
    setSelection(null);
    setNoHealBeerConfirmation(null);
    setSidAbilitySelection(null);
    setNotice(ack.status === "rejected" ? rejectionMessage(ack.error.code) : "");
  });
  const selectedProposal = visibleSelection?.kind === "card" && visibleSelection.proposalIndex !== null
    ? actions[visibleSelection.proposalIndex]
    : undefined;
  const hand = currentSnapshot.selfPrivate?.hand ?? [];
  const proposalIndexesByCardId = useMemo(
    () => {
      const indexesByCardId = new Map<string, number[]>();
      actions.forEach((action, index) => {
        if (action.type !== "PLAY_CARD") return;
        const indexes = indexesByCardId.get(action.payload.cardInstanceId) ?? [];
        indexes.push(index);
        indexesByCardId.set(action.payload.cardInstanceId, indexes);
      });
      return indexesByCardId;
    },
    [actions],
  );
  const handById = useMemo(() => new Map(hand.map((card) => [card.cardInstanceId, card])), [hand]);
  const selectedCard = visibleSelection ? handById.get(visibleSelection.cardInstanceId) : undefined;
  const handIndexById = useMemo(
    () => new Map(hand.map((card, index) => [card.cardInstanceId, index])),
    [hand],
  );
  const selectedBeerReasons = visibleSelection?.kind === "card" &&
      selectedProposal?.type === "PLAY_CARD" &&
      selectedProposal.payload.cardInstanceId === visibleSelection.cardInstanceId
    ? noHealBeerReasons(currentSnapshot, visibleSelection.cardInstanceId)
    : [];
  const beerConfirmationMatches = visibleSelection?.kind === "card" &&
    visibleSelection.proposalIndex !== null &&
    noHealBeerConfirmation?.matchId === matchId &&
    noHealBeerConfirmation?.version === projection.version &&
    noHealBeerConfirmation?.cardInstanceId === visibleSelection.cardInstanceId &&
    noHealBeerConfirmation?.proposalIndex === visibleSelection.proposalIndex;
  const activeViewer = currentSnapshot.viewer.mode === "active" && currentSnapshot.selfPrivate !== null;
  const turnOwner = currentSnapshot.publicTable.players.find(
    (player) => player.playerId === currentSnapshot.publicTable.turn.currentPlayerId,
  );
  const viewerIsTurnOwner = turnOwner?.playerId === currentSnapshot.viewer.playerId;
  const pendingInteraction = currentSnapshot.pendingInteraction;
  const pendingResponderId = pendingInteraction && "currentResponderPlayerId" in pendingInteraction
    ? pendingInteraction.currentResponderPlayerId
    : null;
  const viewerIsResponder = pendingResponderId === currentSnapshot.viewer.playerId &&
    pendingInteraction?.kind !== "progress" && pendingInteraction !== null;
  const canAct = currentSnapshot.status === "playing" && activeViewer && viewerIsTurnOwner &&
    !pendingInteraction && !busy && !activePendingCommand && !needsRefresh;

  async function refreshProjection(forMatchId: string): Promise<void> {
    const response = await transport.syncMatch(forMatchId);
    if (response.matchId !== forMatchId) throw new Error("Match sync returned a different match.");
    if (currentMatchIdRef.current !== forMatchId) return;
    const incoming = projectionFromSync(response);
    setSyncedProjection((current) => current?.matchId === forMatchId && current.version > incoming.version
      ? current
      : { ...incoming, matchId: forMatchId });
    setNeedsRefresh(false);
  }

  async function send(command: MatchCommand): Promise<void> {
    if (busyRef.current || command.matchId !== currentMatchIdRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setPendingCommand(command);
    setNotice("");

    try {
      const result = await sendAndRefreshAction(transport, command);
      if (currentMatchIdRef.current !== command.matchId) return;
      setSelection(null);
      setNoHealBeerConfirmation(null);
      setSidAbilitySelection(null);
      if (result.projection) setPendingCommand(null);

      if (result.projection) {
        const incomingProjection = result.projection;
        setSyncedProjection((current) => current?.matchId === command.matchId && current.version > incomingProjection.version
          ? current
          : { ...incomingProjection, matchId: command.matchId });
        setNeedsRefresh(false);
      } else {
        setNeedsRefresh(true);
      }

      if (result.acknowledgement.status === "rejected") {
        setNotice(result.projection
          ? rejectionMessage(result.acknowledgement.error.code)
          : "지금은 사용할 수 없어요. 다시 골라 주세요.");
      } else {
        setAbilityOpen(false);
        setNotice("");
      }
    } catch {
      if (currentMatchIdRef.current !== command.matchId) return;
      setNeedsRefresh(true);
      setNotice("");
      try {
        await refreshProjection(command.matchId);
      } catch {
        // The room frame provides one delayed connection notice.
      }
    } finally {
      if (currentMatchIdRef.current === command.matchId) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  function submitProposal(proposalIndex: number): void {
    if (!canAct) return;
    let proposal = actions[proposalIndex];
    if (!proposal) return;
    if (proposal.type === "USE_ABILITY" && proposal.costSelection) {
      const resolved = resolveSidAbilityProposal(proposal,
        visibleSidAbilitySelection?.firstCardInstanceId ?? null, visibleSidAbilitySelection?.secondCardInstanceId ?? null);
      if (!resolved) return;
      proposal = resolved;
    }
    if (proposal.type === "PLAY_CARD" &&
        noHealBeerReasons(currentSnapshot, proposal.payload.cardInstanceId).length > 0) {
      const confirmed = visibleSelection?.kind === "card" &&
        visibleSelection.proposalIndex === proposalIndex &&
        visibleSelection.cardInstanceId === proposal.payload.cardInstanceId &&
        noHealBeerConfirmation?.matchId === matchId &&
        noHealBeerConfirmation?.version === projection.version &&
        noHealBeerConfirmation?.cardInstanceId === visibleSelection.cardInstanceId &&
        noHealBeerConfirmation?.proposalIndex === proposalIndex;
      if (!confirmed) return;
    }
    const command = createActionCommand(
      matchId,
      projection.version,
      createCommandId(),
      proposal,
    );
    void send(command);
  }

  function chooseCard(cardInstanceId: string): void {
    if (!canAct) return;
    setNoHealBeerConfirmation(null);
    setSidAbilitySelection(null);
    const indexes = getCardProposalIndexes(actions, cardInstanceId);
    setSelection({
      version: projection.version,
      matchId,
      kind: "card",
      cardInstanceId,
      proposalIndex: indexes.length === 1 ? indexes[0]! : null,
    });
  }

  function chooseProposal(proposalIndex: number): void {
    if (!canAct) return;
    if (visibleSelection?.kind === "card") {
      const validIndexes = getCardProposalIndexes(actions, visibleSelection.cardInstanceId);
      if (!validIndexes.includes(proposalIndex)) return;
      setNoHealBeerConfirmation(null);
      setSelection({ ...visibleSelection, proposalIndex });
    }
  }

  function chooseSidAbilityCard(which: "first" | "second", cardInstanceId: string | null): void {
    if (!canAct) return;
    const current = visibleSidAbilitySelection ?? {
      matchId,
      version: projection.version,
      firstCardInstanceId: null,
      secondCardInstanceId: null,
    };
    let firstCardInstanceId = which === "first" ? cardInstanceId : current.firstCardInstanceId;
    let secondCardInstanceId = which === "second" ? cardInstanceId : current.secondCardInstanceId;
    if (firstCardInstanceId && firstCardInstanceId === secondCardInstanceId) {
      if (which === "first") secondCardInstanceId = null;
      else firstCardInstanceId = null;
    }
    setSelection(null);
    setNoHealBeerConfirmation(null);
    setSidAbilitySelection({ matchId, version: projection.version, firstCardInstanceId, secondCardInstanceId });
  }

  const activeCardIndexes = visibleSelection?.kind === "card"
    ? proposalIndexesByCardId.get(visibleSelection.cardInstanceId) ?? []
    : [];
  const activeTargetOptions = useMemo(
    () => visibleSelection?.kind === "card"
      ? getTargetOptions(currentSnapshot, actions, activeCardIndexes)
      : [],
    [currentSnapshot, actions, activeCardIndexes, visibleSelection?.kind, visibleSelection?.kind === "card" ? visibleSelection.cardInstanceId : null],
  );
  const setTableTargeting = experience?.setTargeting;
  useEffect(() => {
    if (!setTableTargeting) return;
    const indexes = visibleSelection?.kind === "card" && canAct
      ? getCardProposalIndexes(actions, visibleSelection.cardInstanceId) : [];
    const grouped = new Map<string, number[]>();
    indexes.forEach(index => {
      const proposal = actions[index];
      if (proposal?.type === "PLAY_CARD" && proposal.payload.targetPlayerId) {
        const id = proposal.payload.targetPlayerId;
        grouped.set(id, [...(grouped.get(id) ?? []), index]);
      }
    });
    // A seat shortcut is offered only when it maps to one exact server proposal.
    const unique = new Map([...grouped].filter(([, candidates]) => candidates.length === 1));
    setTableTargeting(unique.size ? {
      version: projection.version, playerIds: [...unique.keys()],
      selectedPlayerId: selectedProposal?.type === "PLAY_CARD" ? selectedProposal.payload.targetPlayerId : undefined,
      choosePlayer: id => { const index = unique.get(id)?.[0]; if (index !== undefined) chooseProposal(index); },
    } : null);
    return () => setTableTargeting(null);
  }, [setTableTargeting, projection.version, visibleSelection?.kind, visibleSelection?.kind === "card" ? visibleSelection.cardInstanceId : null, visibleSelection?.kind === "card" ? visibleSelection.proposalIndex : null, canAct]);
  const endTurnIndexes = useMemo(
    () => actions.flatMap((action, index) => action.type === "END_TURN" ? [index] : []),
    [actions],
  );
  const abilityIndexes = useMemo(
    () => actions.flatMap((action, index) => action.type === "USE_ABILITY" ? [index] : []),
    [actions],
  );
  const visibleSidAbilitySelection = sidAbilitySelection?.matchId === matchId &&
      sidAbilitySelection?.version === projection.version
    ? sidAbilitySelection
    : null;
  const selectedSidAbilityProposalIndex = useMemo(
    () => findSidAbilityProposalIndex(
      actions,
      visibleSidAbilitySelection?.firstCardInstanceId ?? null,
      visibleSidAbilitySelection?.secondCardInstanceId ?? null,
    ),
    [actions, visibleSidAbilitySelection?.firstCardInstanceId, visibleSidAbilitySelection?.secondCardInstanceId],
  );

  return (
    <section className={`game-actions${variant === "scene" ? " game-actions--scene" : ""}`} aria-labelledby="game-actions-title" aria-busy={busy}>
      <header className="game-actions__header">
        <div>
          <h2 id="game-actions-title">내 손패</h2>
        </div>
        <span className="game-actions__version">손패 {hand.length}장</span>
      </header>

      {notice ? <p className="game-actions__notice" role="status" aria-live="polite">{notice}</p> : null}
      {selectionExpired && variant !== "scene" ? (
        <p className="game-actions__notice" role="status" aria-live="polite">
          판이 업데이트되어 이전 선택을 지웠어요. 최신 선택지에서 다시 골라 주세요.
        </p>
      ) : null}

      {currentSnapshot.status !== "playing" ? (
        <p className="game-actions__empty" role="status">지금은 행동을 고를 수 없어요.</p>
      ) : !activeViewer ? (
        <p className="game-actions__empty" role="status">탈락한 플레이어는 공개 테이블만 볼 수 있습니다.</p>
      ) : needsRefresh ? (
        <div className="game-actions__recovery">
          <button
            className="game-actions__button game-actions__button--secondary"
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              busyRef.current = true;
              void refreshProjection(matchId)
                .then(() => setNotice(""))
                .catch(() => undefined)
                .finally(() => {
                  if (currentMatchIdRef.current === matchId) {
                    busyRef.current = false;
                    setBusy(false);
                  }
                });
            }}
          >
            다시 확인
          </button>
        </div>
      ) : null}

      {currentSnapshot.status === "playing" && activeViewer && !needsRefresh ? (
        <>
          {activePendingCommand && !busy ? (
            <div className="game-actions__pending" role="status">
              <button
                className="game-actions__button game-actions__button--primary"
                type="button"
                disabled={busy}
                onClick={() => void send(activePendingCommand)}
              >
                {busy ? "확인 중…" : "다시 확인"}
              </button>
            </div>
          ) : null}

          <fieldset className="game-actions__fieldset">
            <legend className="sr-only">손패 카드</legend>
            {hand.length > 0 ? (
              <ul className="game-actions__cards" data-card-anchor={variant === "scene" ? "hand" : undefined} aria-label="내 손패에서 카드 선택">
                {hand.map((card, handIndex) => {
                  const indexes = proposalIndexesByCardId.get(card.cardInstanceId) ?? [];
                  const selected = visibleSelection?.kind === "card" && visibleSelection.cardInstanceId === card.cardInstanceId;
                  const isLegal = indexes.length > 0;
                  const canUseCard = isLegal && viewerIsTurnOwner && !pendingInteraction;
                  const disabledReason = pendingInteraction
                    ? "응답이 끝나면 선택할 수 있어요"
                    : !viewerIsTurnOwner
                      ? `${turnOwner?.displayName ?? "다른 참가자"} 님 차례예요`
                      : currentSnapshot.publicTable.turn.phase === "discard"
                        ? "손패를 버리는 단계예요"
                        : "지금 가능한 사용 방법이 없어요";
                  const actionDetails = canUseCard
                    ? getTargetOptions(currentSnapshot, actions, indexes).map((option) => option.label).filter(Boolean)
                    : [disabledReason];
                  return (
                    <li key={card.cardInstanceId} className={selected ? "is-selected" : ""} style={variant === "scene" ? { "--card-angle": `${Math.max(-14, Math.min(14, (handIndex - (hand.length - 1) / 2) * 3))}deg` } as import("react").CSSProperties : undefined}>
                      <div className="game-actions__card-entry">
                        <PlayingCardZoomButton card={card} details={actionDetails} detailHeading={canUseCard ? "사용 대상과 방식" : "카드 사용 상태"} triggerClassName="game-actions__card-zoom-trigger" triggerLabel={variant === "scene" ? `${cardName(card.typeId)}${selected ? " 상세 보기" : canAct && isLegal ? " 선택" : " 상세 보기"}` : undefined} onInspect={variant === "scene" ? () => { if (canAct && isLegal && !selected) { chooseCard(card.cardInstanceId); return false; } return true; } : undefined} />
                        {variant === "scene" ? <span className="game-actions__card-name">{cardName(card.typeId)}</span> : <button
                          className={`game-actions__card${selected ? " is-selected" : ""}`}
                          type="button"
                          aria-pressed={selected}
                          aria-label={`${cardName(card.typeId)} ${card.rank} ${suitName(card.suit)}, ${canUseCard ? "사용 가능" : disabledReason}`}
                          disabled={!canAct || !isLegal}
                          onClick={() => chooseCard(card.cardInstanceId)}
                        >
                          <span className="game-actions__card-name">{cardName(card.typeId)}</span>
                          <span className="game-actions__card-state">{canUseCard ? "사용" : pendingInteraction ? "응답 대기" : !viewerIsTurnOwner ? "상대 차례" : currentSnapshot.publicTable.turn.phase === "discard" ? "카드 버리기" : "사용 불가"}</span>
                        </button>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="game-actions__empty game-actions__empty-hand">손패가 없어요</p>
            )}
          </fieldset>

          {visibleSelection?.kind === "card" ? (
            <section className="game-actions__choice" aria-labelledby="game-actions-choice-title">
              <div>
                <p className="game-actions__eyebrow">선택한 카드</p>
                <h3 id="game-actions-choice-title">
                  {cardName(selectedCard?.typeId ?? "")}
                </h3>
              </div>
              {selectedCard ? (
                <p className="game-actions__card-description">{getPlayingCardDescription(selectedCard.typeId)}</p>
              ) : null}
              {activeTargetOptions.length > 1 ? (
                <TargetChoices scene={variant === "scene"} hasSelection={visibleSelection.proposalIndex !== null}><fieldset className="game-actions__targets" disabled={!canAct}>
                <legend>사용할 대상과 방식을 선택하세요</legend>
                  {activeTargetOptions.map((option) => (
                    <button
                      className={`game-actions__target${visibleSelection.proposalIndex === option.index ? " is-selected" : ""}`}
                      type="button"
                      key={option.index}
                      aria-pressed={visibleSelection.proposalIndex === option.index}
                      onClick={() => chooseProposal(option.index)}
                    >
                      {option.label || "카드 사용"}
                    </button>
                  ))}
                </fieldset></TargetChoices>
              ) : activeTargetOptions.length === 0 || activeTargetOptions[0]?.label ? (
                <p className="game-actions__selected-target">
                  {activeTargetOptions[0]?.label ?? "지금은 선택할 수 있는 행동이 없어요."}
                </p>
              ) : null}
              {selectedBeerReasons.length > 0 ? (
                <div className="game-actions__beer-confirmation">
                  <p>맥주를 사용해도 생명력은 회복되지 않아요.</p>
                  <ul>
                    {selectedBeerReasons.map((reason) => <li key={reason}>{reason}</li>)}
                  </ul>
                  <label>
                    <input
                      type="checkbox"
                      checked={beerConfirmationMatches}
                      disabled={!canAct}
                      onChange={(event) => {
                        if (!visibleSelection || visibleSelection.kind !== "card" || visibleSelection.proposalIndex === null) return;
                        setNoHealBeerConfirmation(event.currentTarget.checked
                          ? {
                              matchId,
                              version: projection.version,
                              cardInstanceId: visibleSelection.cardInstanceId,
                              proposalIndex: visibleSelection.proposalIndex,
                            }
                          : null);
                      }}
                    />
                    회복 0을 확인하고 맥주를 사용합니다.
                  </label>
                </div>
              ) : null}
              <div className="game-actions__controls">
                <button className="game-actions__button game-actions__button--secondary" type="button" disabled={!canAct} onClick={() => { setSelection(null); setNoHealBeerConfirmation(null); }}>
                  취소
                </button>
                <button
                  className="game-actions__button game-actions__button--primary"
                  type="button"
                  disabled={!canAct || !selectedProposal || (selectedBeerReasons.length > 0 && !beerConfirmationMatches)}
                  onClick={() => {
                    if (visibleSelection.proposalIndex !== null) submitProposal(visibleSelection.proposalIndex);
                  }}
                >
                  {busy ? "처리 중…" : selectedBeerReasons.length > 0 ? "확인하고 맥주 사용" : "카드 사용"}
                </button>
              </div>
            </section>
          ) : null}

          {abilityIndexes.length > 0 && viewerIsTurnOwner && !pendingInteraction ? (
            <><button className="scene-ability-trigger" type="button" disabled={!canAct} onClick={() => setAbilityOpen(true)} hidden={variant !== "scene"}>인물 능력</button>{variant !== "scene" || abilityOpen ? <AbilityStage scene={variant === "scene"} close={() => setAbilityOpen(false)}>
            <fieldset className="game-actions__abilities" disabled={!canAct}>
              <legend>시드 케첨 · 손패 카드 2장 사용</legend>
              <p className="game-actions__sid-hint" id="sid-ability-cost-help">
                서로 다른 손패 카드 2장을 골라 능력을 사용하세요.
              </p>
              <div className="game-actions__sid-costs">
                <label>
                  <span>첫 번째 비용 카드</span>
                  <select
                    aria-label="첫 번째 능력 비용 카드"
                    aria-describedby="sid-ability-cost-help"
                    value={visibleSidAbilitySelection?.firstCardInstanceId
                      ? String(handIndexById.get(visibleSidAbilitySelection.firstCardInstanceId) ?? "")
                      : ""}
                    onChange={(event) => {
                      const selectedIndex = event.currentTarget.value === "" ? undefined : Number(event.currentTarget.value);
                      chooseSidAbilityCard("first", selectedIndex === undefined ? null : hand[selectedIndex]?.cardInstanceId ?? null);
                    }}
                  >
                    <option value="">카드 선택</option>
                    {hand.map((card, index) => (
                      <option
                        key={card.cardInstanceId}
                        value={index}
                        disabled={card.cardInstanceId === visibleSidAbilitySelection?.secondCardInstanceId}
                      >
                        {cardName(card.typeId)} {card.rank} {suitName(card.suit)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>두 번째 비용 카드</span>
                  <select
                    aria-label="두 번째 능력 비용 카드"
                    aria-describedby="sid-ability-cost-help"
                    value={visibleSidAbilitySelection?.secondCardInstanceId
                      ? String(handIndexById.get(visibleSidAbilitySelection.secondCardInstanceId) ?? "")
                      : ""}
                    onChange={(event) => {
                      const selectedIndex = event.currentTarget.value === "" ? undefined : Number(event.currentTarget.value);
                      chooseSidAbilityCard("second", selectedIndex === undefined ? null : hand[selectedIndex]?.cardInstanceId ?? null);
                    }}
                  >
                    <option value="">카드 선택</option>
                    {hand.map((card, index) => (
                      <option
                        key={card.cardInstanceId}
                        value={index}
                        disabled={card.cardInstanceId === visibleSidAbilitySelection?.firstCardInstanceId}
                      >
                        {cardName(card.typeId)} {card.rank} {suitName(card.suit)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {visibleSidAbilitySelection?.firstCardInstanceId && visibleSidAbilitySelection.secondCardInstanceId
                ? selectedSidAbilityProposalIndex === null
                  ? <p className="game-actions__sid-feedback" role="status">지금 사용할 수 없는 조합이에요. 다른 카드를 골라 주세요.</p>
                  : (() => {
                      const candidate = actions[selectedSidAbilityProposalIndex];
                      const proposal = candidate ? resolveSidAbilityProposal(candidate,
                        visibleSidAbilitySelection.firstCardInstanceId, visibleSidAbilitySelection.secondCardInstanceId) : null;
                      const costCards = proposal?.type === "USE_ABILITY"
                        ? proposal.payload.cardInstanceIds.map((id) => handById.get(id))
                        : [];
                      return costCards.length === 2 && costCards.every((card) => card !== undefined) ? (
                        <p className="game-actions__sid-feedback" role="status">
                          선택한 비용: {costCards.map((card) => `${cardName(card!.typeId)} ${card!.rank} ${suitName(card!.suit)}`).join(" + ")}
                        </p>
                      ) : <p className="game-actions__sid-feedback" role="status">선택한 카드 정보를 확인할 수 없어요.</p>;
                    })()
                : <p className="game-actions__sid-feedback" role="status">능력 비용으로 사용할 서로 다른 카드 두 장을 선택하세요.</p>}
              <button
                className="game-actions__button game-actions__button--primary"
                type="button"
                disabled={!canAct || selectedSidAbilityProposalIndex === null}
                onClick={() => {
                  if (selectedSidAbilityProposalIndex !== null) submitProposal(selectedSidAbilityProposalIndex);
                }}
              >
                능력 사용
              </button>
            </fieldset>
            </AbilityStage> : null}</>
          ) : null}

          {endTurnIndexes.length > 0 && viewerIsTurnOwner && !pendingInteraction ? (
            <div className="game-actions__end-turn">
              {endTurnIndexes.map((index) => (
                <button
                  className="game-actions__button game-actions__button--secondary"
                  key={index}
                  type="button"
                  disabled={!canAct}
                  onClick={() => submitProposal(index)}
                >
                  {busy ? "처리 중…" : variant === "scene" ? "차례 마치기" : "턴 종료"}
                </button>
              ))}
            </div>
          ) : null}

          {actions.length === 0 && viewerIsTurnOwner && !pendingInteraction ? (
            <p className="game-actions__empty" role="status">선택을 불러오지 못했어요. 최신 게임 정보를 다시 불러와 주세요.</p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function rejectionMessage(code: string): string {
  if (code === "STALE_VERSION") return "진행 상황이 바뀌었어요. 다시 골라 주세요.";
  if (code === "ILLEGAL_ACTION" || code === "INVALID_CHOICE") return "지금은 사용할 수 없어요. 다시 골라 주세요.";
  return "사용하지 못했어요. 다시 시도해 주세요.";
}

function suitName(suit: CardSuit): string {
  switch (suit) {
    case "SPADES": return "스페이드";
    case "HEARTS": return "하트";
    case "DIAMONDS": return "다이아몬드";
    case "CLUBS": return "클럽";
  }
}


function AbilityStage({scene,close,children}:{scene:boolean;close:()=>void;children:import("react").ReactNode}) { return scene ? <ChoiceStage presentation="table" interactionId="sid-ability" title="시드 케첨 · 생명력 회복">{children}<button type="button" onClick={close}>취소</button></ChoiceStage> : <>{children}</>; }

function TargetChoices({scene,hasSelection,children}:{scene:boolean;hasSelection:boolean;children:import("react").ReactNode}) { return scene ? <details className="scene-target-menu"><summary>{hasSelection ? "대상 변경" : "대상 선택"}</summary>{children}</details> : <>{children}</>; }
