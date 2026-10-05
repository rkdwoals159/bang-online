import { ChoiceStage, GeneralStoreStage } from "../experience/ChoiceStage.js";
import { useEffect, useRef, useState } from "react";
import type {
  CardFaceView,
  CommandAck,
  MatchCommand,
  MatchSnapshotView,
  MatchSyncResponse,
  PendingRespondOption,
} from "../../../../../packages/contracts/src/protocol.js";
import { getPlayingCardPresentation } from "../cards/assets.js";
import { PlayingCardZoomButton } from "../cards/CardFaces.js";
import { cardName } from "../actions/model.js";
import {
  cardFaceLabel,
  createRespondCommand,
  interactionLabel,
  isCompleteDiscardOrder,
  presentOption,
  projectionFromSync,
  responderName,
  responderPromptFor,
  responseVisibleCards,
  sendAndRefreshResponse,
  type ReactionProjection,
} from "./model.js";
import "./reactions.css";

export interface ReactionTransport {
  sendMatchCommand(command: MatchCommand): Promise<CommandAck>;
  syncMatch(matchId: string): Promise<MatchSyncResponse>;
}

export interface ReactionPromptProps {
  readonly variant?: "panel" | "scene";
  readonly matchId: string;
  /** Version accompanying the supplied server projection. */
  readonly version: number;
  readonly snapshot: MatchSnapshotView;
  readonly transport: ReactionTransport;
  /** Injectable to keep the canonical command envelope deterministic in tests. */
  readonly createCommandId?: () => string;
}

const createDefaultCommandId = (): string => globalThis.crypto.randomUUID();

/** Presents only the response options or progress signal included in this viewer's projection. */
export function ReactionPrompt({
  matchId,
  version,
  snapshot,
  transport,
  createCommandId = createDefaultCommandId,
  variant = "panel",
}: ReactionPromptProps) {
  const [syncedProjection, setSyncedProjection] = useState<(ReactionProjection & { readonly matchId: string }) | null>(null);
  const [pendingCommand, setPendingCommand] = useState<MatchCommand | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<{
    readonly matchId: string;
    readonly version: number;
    readonly interactionId: string;
    readonly cardInstanceIds: readonly string[];
  } | null>(null);
  const [eliminationConfirmation, setEliminationConfirmation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const busyRef = useRef(false);
  const currentMatchIdRef = useRef(matchId);

  useEffect(() => {
    currentMatchIdRef.current = matchId;
    setSyncedProjection(null);
    setPendingCommand(null);
    setSelectedOrder(null);
    setBusy(false);
    setNotice("");
    busyRef.current = false;
  }, [matchId]);

  const projection = syncedProjection?.matchId === matchId && syncedProjection.version >= version
    ? syncedProjection
    : { version, snapshot };
  const currentSnapshot = projection.snapshot;
  const pending = currentSnapshot.pendingInteraction;
  const pendingInteractionId = pending?.interactionId ?? null;
  useEffect(() => {
    setPendingCommand((current) => current && current.type === "RESPOND" &&
      current.payload.interactionId !== pendingInteractionId ? null : current);
  }, [matchId, pendingInteractionId]);
  useEffect(() => {
    setSelectedOrder(null);
    setEliminationConfirmation(null);
  }, [matchId, projection.version, pendingInteractionId]);
  if (!pending) return null;

  const responderPrompt = responderPromptFor(currentSnapshot);
  const isResponder = responderPrompt !== null;
  const activePendingCommand = pendingCommand?.matchId === matchId ? pendingCommand : null;
  const canRespond = currentSnapshot.status === "playing" &&
    (currentSnapshot.viewer.mode === "active" || pending.kind === "DISCARDS_ORDER") &&
    isResponder && !busy && activePendingCommand === null;
  const responderHand = responseVisibleCards(currentSnapshot);
  const responderPlayerId = "currentResponderPlayerId" in pending
    ? pending.currentResponderPlayerId
    : null;
  const orderTemplate = responderPrompt?.responseOptions.find((option) =>
    option.choice === "ORDER_CARDS" && !("orderedCardInstanceIds" in option),
  );
  const discardOrder = responderPrompt?.discardOrder;
  const selectableOptions = responderPrompt?.responseOptions.filter(option =>
    option.choice !== "ORDER_CARDS" || "orderedCardInstanceIds" in option,
  ) ?? [];
  const visibleOrder = selectedOrder?.matchId === matchId &&
    selectedOrder.version === projection.version &&
    selectedOrder.interactionId === pending.interactionId
    ? selectedOrder.cardInstanceIds
    : [];

  async function refreshProjection(forMatchId: string): Promise<void> {
    const response = await transport.syncMatch(forMatchId);
    if (response.matchId !== forMatchId || currentMatchIdRef.current !== forMatchId) return;
    const incoming = projectionFromSync(response);
    setSyncedProjection((current) => current?.matchId === forMatchId && current.version > incoming.version
      ? current
      : { ...incoming, matchId: forMatchId });
  }

  async function send(command: MatchCommand): Promise<void> {
    if (busyRef.current || command.matchId !== currentMatchIdRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setPendingCommand(command);
    setNotice("");

    try {
      const result = await sendAndRefreshResponse(transport, command);
      if (currentMatchIdRef.current !== command.matchId) return;

      if (result.projection) {
        const incoming = result.projection;
        setSyncedProjection((current) => current?.matchId === command.matchId && current.version > incoming.version
          ? current
          : { ...incoming, matchId: command.matchId });
        setPendingCommand(null);
        setNotice(result.acknowledgement.status === "rejected"
          ? rejectionMessage(result.acknowledgement.error.code)
          : "");
      } else {
        setNotice("연결이 지연되고 있어요. 잠시 후 다시 확인해 주세요.");
      }
    } catch {
      if (currentMatchIdRef.current !== command.matchId) return;
      setNotice("연결이 지연되고 있어요. 잠시 후 다시 확인해 주세요.");
      try {
        await refreshProjection(command.matchId);
      } catch {
        setNotice("연결 상태를 확인하고 다시 시도해 주세요.");
      }
    } finally {
      if (currentMatchIdRef.current === command.matchId) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  function submitOption(option: PendingRespondOption, orderedCardInstanceIds?: readonly string[]): void {
    if (!canRespond || !responderPrompt || !responderPrompt.responseOptions.includes(option)) return;
    if (option.choice === "ACCEPT_ELIMINATION" && eliminationConfirmation !== pendingInteractionId) {
      setEliminationConfirmation(pendingInteractionId); return;
    }
    const command = createRespondCommand(
      matchId,
      projection.version,
      createCommandId(),
      option,
      orderedCardInstanceIds,
    );
    if (command) void send(command);
  }

  function toggleOrderCard(cardInstanceId: string): void {
    if (!pendingInteractionId || !canRespond || !discardOrder ||
        !discardOrder.allowedCards.some((card) => card.cardInstanceId === cardInstanceId)) return;
    const current = [...visibleOrder];
    const existingIndex = current.indexOf(cardInstanceId);
    if (existingIndex >= 0) current.splice(existingIndex, 1);
    else if (current.length < discardOrder.requiredCount) current.push(cardInstanceId);
    setSelectedOrder({ matchId, version: projection.version, interactionId: pendingInteractionId, cardInstanceIds: current });
  }

  function submitDiscardOrder(): void {
    if (!orderTemplate || !discardOrder || !isCompleteDiscardOrder(discardOrder, visibleOrder)) return;
    submitOption(orderTemplate, visibleOrder);
  }

  function clearDiscardOrder(): void {
    if (!pendingInteractionId) return;
    setSelectedOrder({ matchId, version: projection.version, interactionId: pendingInteractionId, cardInstanceIds: [] });
  }

  function retryPending(): void {
    if (activePendingCommand) void send(activePendingCommand);
  }

  const currentResponderName = responderPlayerId
    ? responderName(currentSnapshot, responderPlayerId)
    : null;

  if (pending.kind === "GENERAL_STORE_PICK") return <GeneralStoreStage presentation={variant === "scene" ? "table" : "modal"} imagePick={variant === "scene"} snapshot={currentSnapshot} canRespond={canRespond} isResponder={isResponder} busy={busy} notice={notice} onChoose={submitOption} retry={activePendingCommand && !busy ? retryPending : undefined} />;

  const content = (
    <section className={`reaction-prompt reaction-prompt--${pending.kind.toLowerCase()}`} aria-labelledby="reaction-prompt-title" aria-busy={busy}>
      <header className="reaction-prompt__header">
        <div>
          <h2 id="reaction-prompt-title">{pending.kind === "DISCARDS_ORDER" && currentSnapshot.publicTable.turn.phase === "discard" ? "초과 카드 버리기" : interactionLabel(pending.kind)}</h2>
        </div>
        {busy ? <span className="game-processing" role="status">처리 중…</span> : null}
        {"step" in pending && pending.step.total > 1 ? (
          <span className="reaction-prompt__step" aria-label={`응답 단계 ${pending.step.current}/${pending.step.total}`}>
            {pending.step.current}/{pending.step.total}
          </span>
        ) : null}
      </header>

      {notice ? <p className="reaction-prompt__notice" role="status" aria-live="polite">{notice}</p> : null}

      {currentSnapshot.publicTable.luckyJudgment ? (
        <div className="reaction-prompt__judgment" aria-label="공개 판정 카드">
          <p>{({ jail: "감옥: 하트이면 턴 진행", dynamite: "다이너마이트: 스페이드 2–9이면 폭발",
            barrel: "술통: 하트이면 방어", jourdonnais_virtual_barrel: "주르도네: 하트이면 방어" })[currentSnapshot.publicTable.luckyJudgment.sourceKind]}</p>
          {currentSnapshot.publicTable.luckyJudgment.cards.map(card => <div key={card.cardInstanceId}>
            <PlayingCardZoomButton card={card} /><span>{cardFaceLabel(card)}</span>
          </div>)}
        </div>
      ) : null}
      {isResponder && responderPrompt ? (
        <>
          <p className="reaction-prompt__instruction">
            {discardOrder && currentSnapshot.publicTable.turn.phase === "discard"
              ? `${currentResponderName ?? "현재 참가자"} 님의 턴을 마치려면 ${discardOrder.requiredCount}장을 버려야 해요. 남은 체력만큼만 손패를 남길 수 있어요.`
              : `${currentResponderName ?? "현재 참가자"} 님이 선택해 주세요.`}
          </p>
          {orderTemplate ? (
            discardOrder ? (
              <fieldset className="reaction-prompt__discard-order">
                <legend>버릴 카드 · {visibleOrder.length}/{discardOrder.requiredCount}장 선택</legend>
                <ul className="reaction-prompt__discard-candidates" aria-label="버릴 카드 후보">
                  {discardOrder.allowedCards.map((card) => {
                    const orderIndex = visibleOrder.indexOf(card.cardInstanceId);
                    const selected = orderIndex >= 0;
                    return (
                      <li key={card.cardInstanceId}>
                        <div className="reaction-prompt__discard-candidate">
                          <PlayingCardZoomButton card={card} triggerClassName="reaction-prompt__discard-zoom-trigger" triggerLabel={variant === "scene" ? `${cardName(card.typeId)}${selected ? ` · 선택 ${orderIndex+1} 제외` : " · 버리기 선택"}` : undefined} onInspect={variant === "scene" ? () => { if (canRespond && (selected || visibleOrder.length < discardOrder.requiredCount)) { toggleOrderCard(card.cardInstanceId); return false; } return true; } : undefined} />
                          <button
                            className="reaction-prompt__discard-card-choice"
                            type="button"
                            aria-pressed={selected}
                            aria-label={`${getPlayingCardPresentation(card).accessibleLabel}${selected ? `, 선택 ${orderIndex + 1}, 다시 누르면 제외` : ", 버릴 순서에 추가"}`}
                            disabled={!canRespond || (!selected && visibleOrder.length >= discardOrder.requiredCount)}
                            onClick={() => toggleOrderCard(card.cardInstanceId)}
                          >
                            {selected ? <span className="reaction-prompt__discard-position">{orderIndex + 1}</span> : null}
                            <span>{variant === "scene" ? cardName(card.typeId) : cardFaceLabel(card)}</span>
                            <span>{selected ? "선택됨" : "버리기"}</span>
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {visibleOrder.length > 0 ? (
                  <ol className="reaction-prompt__discard-sequence" aria-label="현재 버릴 순서">
                    {visibleOrder.map((cardId) => {
                      const card = discardOrder.allowedCards.find((candidate) => candidate.cardInstanceId === cardId);
                      return card ? <li key={cardId}>{cardFaceLabel(card)}</li> : null;
                    })}
                  </ol>
                ) : null}
                <div className="reaction-prompt__discard-controls">
                  <button
                    className="reaction-prompt__discard-submit"
                    type="button"
                    disabled={!canRespond || visibleOrder.length !== discardOrder.requiredCount}
                    onClick={submitDiscardOrder}
                  >
                    {busy ? "처리 중…" : "선택한 카드 버리기"}
                  </button>
                  <button
                    type="button"
                    disabled={!canRespond || visibleOrder.length === 0}
                    onClick={clearDiscardOrder}
                  >
                    선택 지우기
                  </button>
                </div>
              </fieldset>
            ) : (
              <p className="reaction-prompt__pending-order" role="status">
                카드 후보를 확인하지 못했어요. 잠시 후 다시 확인해 주세요.
              </p>
            )
          ) : null}
          {selectableOptions.length > 0 ? (
            <ul className="reaction-prompt__options" aria-label="응답 선택지">
              {selectableOptions.map((option, index) => {
                const presentation = presentOption(option, currentSnapshot, index, selectableOptions.length);
                const cardFaces = responseCardFaces(option, responderHand);
                const isOrderTemplate = option.choice === "ORDER_CARDS" && !("orderedCardInstanceIds" in option);
                return (
                  <li key={`${option.choice}-${index}`}>
                    <div className="reaction-prompt__option-row">
                      <button
                        className={`reaction-prompt__option${["TAKE_HIT", "YIELD", "ACCEPT_ELIMINATION"].includes(option.choice) ? " reaction-prompt__option--danger" : ""}`}
                        type="button"
                        disabled={!canRespond || isOrderTemplate}
                        onClick={() => submitOption(option)}
                      >
                        <strong>{option.choice === "ACCEPT_ELIMINATION" && eliminationConfirmation === pendingInteractionId ? "확인 · 탈락하고 관전하기" : presentation.label}</strong>
                        {presentation.detail ? <span>{presentation.detail}</span> : null}
                      </button>
                      {cardFaces.map((card) => (
                        <PlayingCardZoomButton
                          key={card.cardInstanceId}
                          card={card}
                          details={[presentation.label, ...(presentation.detail ? [presentation.detail] : [])]}
                          detailHeading="카드 응답"
                          triggerClassName="reaction-prompt__option-zoom-trigger"
                        />
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : !discardOrder ? (
            <p className="reaction-prompt__empty" role="status">선택할 수 있는 응답이 없어요.</p>
          ) : null}
          {activePendingCommand && !busy ? (
            <div className="reaction-prompt__retry">
              <button type="button" disabled={busy} onClick={retryPending}>
                {busy ? "확인 중…" : "다시 확인"}
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <>
          {pending.kind === "GENERAL_STORE_PICK" && currentSnapshot.publicTable.generalStoreCards ? (
            <ul className="reaction-prompt__store-pool" aria-label="잡화점에 남은 공개 카드">
              {currentSnapshot.publicTable.generalStoreCards.map(card => (
                <li key={card.cardInstanceId}>
                  <PlayingCardZoomButton card={card} />
                  <span>{cardFaceLabel(card)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="reaction-prompt__progress" role="status" aria-live="polite">
          {currentResponderName
            ? pending.kind === "GENERAL_STORE_PICK"
              ? `${currentResponderName} 님이 잡화점 카드를 고르고 있어요.`
              : `${currentResponderName} 님이 응답 중이에요.`
            : "다른 참가자의 응답을 기다리고 있어요."}
          </p>
        </>
      )}
    </section>
  );
  const usesStage = variant === "scene" || pending.kind === "LUCKY_DRAW" || (pending.kind === "KIT_CARLSON_PICK" && isResponder);
  const attack = currentSnapshot.publicTable.tablewideAttack;
  if (attack) return <ChoiceStage presentation={variant === "scene" ? "table" : "modal"} interactionId={attack.attackId} title={attack.kind === "gatling" ? "개틀링! 모두 대응하세요" : "인디언! 모두 대응하세요"} attentionKey={isResponder ? pending.interactionId : undefined} dockLabel="대응 보기">
    <p className="tablewide-stage__hint">각자 대응을 선택하세요. 모든 플레이어의 진행 상황이 함께 표시돼요.</p>
    <ul className="tablewide-stage__players" aria-label="광역 공격 대응 상황" aria-live="polite">
      {attack.targets.map(target => {
        const player = currentSnapshot.publicTable.players.find(player => player.playerId === target.playerId);
        const labels = { waiting: "대응 대기", submitted: "제출 완료", responding: "대응 중", resolved: "처리 완료", eliminated: "탈락" };
        return <li key={target.playerId} data-response-status={target.status}><strong>{target.playerId === currentSnapshot.viewer.playerId ? "나" : player?.displayName ?? "플레이어"}</strong><span>{labels[target.status]}</span><span>체력 {player?.hp ?? 0}</span></li>;
      })}
    </ul>
    {content}
  </ChoiceStage>;
  return usesStage ? <ChoiceStage presentation={variant === "scene" ? "table" : "modal"} interactionId={pending.interactionId} title={interactionLabel(pending.kind)}>{content}</ChoiceStage> : content;
}

function rejectionMessage(code: string): string {
  if (code === "STALE_VERSION") return "진행 상황이 바뀌었어요. 다시 골라 주세요.";
  if (code === "INVALID_CHOICE" || code === "ILLEGAL_ACTION") return "지금은 선택할 수 없어요. 다시 골라 주세요.";
  return "선택하지 못했어요. 다시 시도해 주세요.";
}

function responseCardFaces(
  option: PendingRespondOption,
  hand: readonly CardFaceView[],
): CardFaceView[] {
  const cardInstanceIds = new Set<string>();
  if ("cardInstanceId" in option) cardInstanceIds.add(option.cardInstanceId);
  if ("cardInstanceIds" in option) option.cardInstanceIds.forEach((id) => cardInstanceIds.add(id));
  if ("selectedCardInstanceId" in option) cardInstanceIds.add(option.selectedCardInstanceId);
  if ("selectedCardInstanceIds" in option) option.selectedCardInstanceIds.forEach((id) => cardInstanceIds.add(id));
  return [...cardInstanceIds].flatMap((cardInstanceId) => {
    const card = hand.find((candidate) => candidate.cardInstanceId === cardInstanceId);
    return card ? [card] : [];
  });
}
