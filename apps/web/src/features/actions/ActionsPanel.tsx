import { useEffect, useRef, useState } from "react";
import type {
  CommandAck,
  MatchCommand,
  MatchSnapshotView,
  MatchSyncResponse,
} from "../../../../../packages/contracts/src/protocol.js";
import { PlayingCardFace, PlayingCardZoomButton } from "../cards/CardFaces.js";
import {
  cardName,
  createActionCommand,
  getCardProposalIndexes,
  getTargetOptions,
  projectionFromSync,
  sendAndRefreshAction,
  type ActionsProjection,
} from "./model.js";
import "./actions.css";

export interface ActionTransport {
  sendMatchCommand(command: MatchCommand): Promise<CommandAck>;
  syncMatch(matchId: string): Promise<MatchSyncResponse>;
}

export interface ActionsPanelProps {
  readonly matchId: string;
  /** Version accompanying the supplied server projection. */
  readonly version: number;
  readonly snapshot: MatchSnapshotView;
  readonly transport: ActionTransport;
  /** Injectable to keep envelope/idempotency behavior deterministic in tests. */
  readonly createCommandId?: () => string;
}

type ActionSelection =
  | { readonly matchId: string; readonly version: number; readonly kind: "card"; readonly cardInstanceId: string; readonly proposalIndex: number | null }
  | { readonly matchId: string; readonly version: number; readonly kind: "ability"; readonly proposalIndex: number };
type CardSuit = MatchSnapshotView["publicTable"]["players"][number]["inPlay"][number]["suit"];

const createDefaultCommandId = (): string => globalThis.crypto.randomUUID();

/** A command surface driven entirely by the authenticated viewer's projection. */
export function ActionsPanel({
  matchId,
  version,
  snapshot,
  transport,
  createCommandId = createDefaultCommandId,
}: ActionsPanelProps) {
  const [syncedProjection, setSyncedProjection] = useState<(ActionsProjection & { readonly matchId: string }) | null>(null);
  const [selection, setSelection] = useState<ActionSelection | null>(null);
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
  const selectedProposal = visibleSelection && visibleSelection.kind === "ability"
    ? actions[visibleSelection.proposalIndex]
    : visibleSelection?.kind === "card" && visibleSelection.proposalIndex !== null
      ? actions[visibleSelection.proposalIndex]
      : undefined;
  const hand = currentSnapshot.selfPrivate?.hand ?? [];
  const activeViewer = currentSnapshot.viewer.mode === "active" && currentSnapshot.selfPrivate !== null;
  const canAct = currentSnapshot.status === "playing" && activeViewer && !busy && !activePendingCommand && !needsRefresh;

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
    setNotice("서버에 행동을 보내고 있어요.");

    try {
      const result = await sendAndRefreshAction(transport, command);
      if (currentMatchIdRef.current !== command.matchId) return;
      setSelection(null);
      setPendingCommand(null);

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
          : "서버가 행동을 거절했어요. 최신 판 정보를 불러오지 못해 입력을 잠갔습니다.");
      } else {
        setNotice(result.projection
          ? "서버가 행동을 접수하고 최신 판 정보를 반영했어요."
          : "행동은 접수됐어요. 최신 판 정보를 불러오지 못해 입력을 잠갔습니다.");
      }
    } catch {
      if (currentMatchIdRef.current !== command.matchId) return;
      setNeedsRefresh(true);
      setNotice("명령 응답을 확인하지 못했어요. 같은 명령으로 다시 확인할 수 있습니다.");
      try {
        await refreshProjection(command.matchId);
      } catch {
        setNotice("명령 응답과 최신 판 정보를 확인하지 못했어요. 같은 명령을 보관했습니다.");
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
    const proposal = actions[proposalIndex];
    if (!proposal) return;
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
      setSelection({ ...visibleSelection, proposalIndex });
      return;
    }
    const proposal = actions[proposalIndex];
    if (proposal?.type === "USE_ABILITY") {
      setSelection({ matchId, version: projection.version, kind: "ability", proposalIndex });
    }
  }

  const activeCardIndexes = visibleSelection?.kind === "card"
    ? getCardProposalIndexes(actions, visibleSelection.cardInstanceId)
    : [];
  const activeTargetOptions = visibleSelection?.kind === "card"
    ? getTargetOptions(currentSnapshot, actions, activeCardIndexes)
    : [];
  const endTurnIndexes = actions.flatMap((action, index) => action.type === "END_TURN" ? [index] : []);
  const abilityIndexes = actions.flatMap((action, index) => action.type === "USE_ABILITY" ? [index] : []);

  return (
    <section className="game-actions" aria-labelledby="game-actions-title">
      <header className="game-actions__header">
        <div>
          <p className="game-actions__eyebrow">서버가 허용한 행동</p>
          <h2 id="game-actions-title">내 행동</h2>
        </div>
        <span className="game-actions__version">판 버전 {projection.version}</span>
      </header>

      {notice ? <p className="game-actions__notice" role="status" aria-live="polite">{notice}</p> : null}
      {selectionExpired ? (
        <p className="game-actions__notice" role="status" aria-live="polite">
          판이 업데이트되어 이전 선택을 지웠어요. 최신 선택지에서 다시 골라 주세요.
        </p>
      ) : null}

      {currentSnapshot.status !== "playing" ? (
        <p className="game-actions__empty" role="status">현재 게임 상태에서는 행동을 입력할 수 없습니다.</p>
      ) : !activeViewer ? (
        <p className="game-actions__empty" role="status">탈락한 플레이어는 공개 테이블만 볼 수 있습니다.</p>
      ) : needsRefresh ? (
        <div className="game-actions__recovery">
          <p>최신 서버 상태를 확인한 뒤 행동을 다시 선택할 수 있어요.</p>
          <button
            className="game-actions__button game-actions__button--secondary"
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              busyRef.current = true;
              void refreshProjection(matchId)
                .then(() => setNotice("최신 판 정보를 불러왔어요."))
                .catch(() => setNotice("최신 판 정보를 불러오지 못했어요. 다시 시도해 주세요."))
                .finally(() => {
                  if (currentMatchIdRef.current === matchId) {
                    busyRef.current = false;
                    setBusy(false);
                  }
                });
            }}
          >
            최신 판 다시 불러오기
          </button>
        </div>
      ) : null}

      {currentSnapshot.status === "playing" && activeViewer && !needsRefresh ? (
        <>
          {activePendingCommand ? (
            <div className="game-actions__pending" role="status">
              <p>이전 명령의 결과를 기다리고 있어요. 같은 명령 ID로 확인하면 중복 실행되지 않습니다.</p>
              <button
                className="game-actions__button game-actions__button--primary"
                type="button"
                disabled={busy}
                onClick={() => void send(activePendingCommand)}
              >
                {busy ? "확인 중…" : "같은 명령 다시 확인"}
              </button>
            </div>
          ) : null}

          <fieldset className="game-actions__fieldset">
            <legend>손패 카드</legend>
            {hand.length > 0 ? (
              <ul className="game-actions__cards" aria-label="내 손패에서 카드 선택">
                {hand.map((card) => {
                  const indexes = getCardProposalIndexes(actions, card.cardInstanceId);
                  const selected = visibleSelection?.kind === "card" && visibleSelection.cardInstanceId === card.cardInstanceId;
                  const isLegal = indexes.length > 0;
                  const actionDetails = isLegal
                    ? getTargetOptions(currentSnapshot, actions, indexes).map((option) => option.label)
                    : ["지금은 사용 불가"];
                  return (
                    <li key={card.cardInstanceId}>
                      <div className="game-actions__card-entry">
                        <button
                          className={`game-actions__card${selected ? " is-selected" : ""}`}
                          type="button"
                          aria-pressed={selected}
                          aria-label={`${cardName(card.typeId)} ${card.rank} ${suitName(card.suit)}, ${isLegal ? "합법 행동 선택 가능" : "지금 선택할 수 없음"}`}
                          disabled={!canAct || !isLegal}
                          onClick={() => chooseCard(card.cardInstanceId)}
                        >
                          <PlayingCardFace card={card} />
                          <span className="game-actions__card-name">{cardName(card.typeId)}</span>
                          <span className="game-actions__card-state">{isLegal ? "사용 가능" : "지금은 사용 불가"}</span>
                        </button>
                        <PlayingCardZoomButton
                          card={card}
                          details={actionDetails}
                          detailHeading={isLegal ? "서버가 허용한 대상과 사용 방식" : "사용 상태"}
                          triggerClassName="game-actions__card-zoom-trigger"
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="game-actions__empty">선택할 손패가 없습니다.</p>
            )}
          </fieldset>

          {visibleSelection?.kind === "card" ? (
            <section className="game-actions__choice" aria-labelledby="game-actions-choice-title">
              <div>
                <p className="game-actions__eyebrow">선택한 카드</p>
                <h3 id="game-actions-choice-title">
                  {cardName(hand.find((card) => card.cardInstanceId === visibleSelection.cardInstanceId)?.typeId ?? "")}
                </h3>
              </div>
              {activeTargetOptions.length > 1 ? (
                <fieldset className="game-actions__targets" disabled={!canAct}>
                  <legend>합법 대상과 사용 방식을 선택하세요</legend>
                  {activeTargetOptions.map((option) => (
                    <button
                      className={`game-actions__target${visibleSelection.proposalIndex === option.index ? " is-selected" : ""}`}
                      type="button"
                      key={option.index}
                      aria-pressed={visibleSelection.proposalIndex === option.index}
                      onClick={() => chooseProposal(option.index)}
                    >
                      {option.label}
                    </button>
                  ))}
                </fieldset>
              ) : (
                <p className="game-actions__selected-target">
                  {activeTargetOptions[0]?.label ?? "합법 행동을 선택할 수 없습니다."}
                </p>
              )}
              <div className="game-actions__controls">
                <button className="game-actions__button game-actions__button--secondary" type="button" disabled={!canAct} onClick={() => setSelection(null)}>
                  취소
                </button>
                <button
                  className="game-actions__button game-actions__button--primary"
                  type="button"
                  disabled={!canAct || !selectedProposal}
                  onClick={() => {
                    if (visibleSelection.proposalIndex !== null) submitProposal(visibleSelection.proposalIndex);
                  }}
                >
                  선택한 행동 제출
                </button>
              </div>
            </section>
          ) : null}

          {abilityIndexes.length > 0 ? (
            <fieldset className="game-actions__abilities" disabled={!canAct}>
              <legend>인물 능력</legend>
              {abilityIndexes.map((index) => {
                const action = actions[index];
                if (!action || action.type !== "USE_ABILITY") return null;
                const cards = action.payload.cardInstanceIds.map((id) => hand.find((card) => card.cardInstanceId === id));
                const canShowCost = cards.every((card) => card !== undefined);
                const isSelected = visibleSelection?.kind === "ability" && visibleSelection.proposalIndex === index;
                return (
                  <button
                    className={`game-actions__ability${isSelected ? " is-selected" : ""}`}
                    type="button"
                    key={index}
                    aria-pressed={isSelected}
                    disabled={!canAct || !canShowCost}
                    onClick={() => chooseProposal(index)}
                  >
                    <strong>시드 케첨 · 손패 2장 버리기</strong>
                    <span>{canShowCost ? cards.map((card) => `${cardName(card!.typeId)} ${card!.rank}`).join(" + ") : "선택할 손패 정보를 불러오지 못했어요."}</span>
                  </button>
                );
              })}
              {visibleSelection?.kind === "ability" ? (
                <button
                  className="game-actions__button game-actions__button--primary"
                  type="button"
                  disabled={!canAct || !selectedProposal}
                  onClick={() => submitProposal(visibleSelection.proposalIndex)}
                >
                  선택한 능력 제출
                </button>
              ) : null}
            </fieldset>
          ) : null}

          {endTurnIndexes.length > 0 ? (
            <div className="game-actions__end-turn">
              {endTurnIndexes.map((index) => (
                <button
                  className="game-actions__button game-actions__button--secondary"
                  key={index}
                  type="button"
                  disabled={!canAct}
                  onClick={() => submitProposal(index)}
                >
                  턴 종료
                </button>
              ))}
            </div>
          ) : null}

          {actions.length === 0 ? (
            <p className="game-actions__empty" role="status">서버가 허용한 행동을 아직 받지 못했습니다.</p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function rejectionMessage(code: string): string {
  if (code === "STALE_VERSION") return "판이 업데이트되어 선택을 취소하고 최신 상태를 불러옵니다.";
  if (code === "ILLEGAL_ACTION" || code === "INVALID_CHOICE") return "서버가 행동을 거절했어요. 최신 선택지를 불러옵니다.";
  return "서버가 행동을 거절했어요. 최신 판 정보를 확인합니다.";
}

function suitName(suit: CardSuit): string {
  switch (suit) {
    case "SPADES": return "스페이드";
    case "HEARTS": return "하트";
    case "DIAMONDS": return "다이아몬드";
    case "CLUBS": return "클럽";
  }
}

