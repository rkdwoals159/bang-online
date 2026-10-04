import { useEffect, useRef, useState } from "react";
import type {
  CardFaceView,
  CommandAck,
  MatchCommand,
  MatchSnapshotView,
  MatchSyncResponse,
  PendingRespondOption,
} from "../../../../../packages/contracts/src/protocol.js";
import { PlayingCardFace, PlayingCardZoomButton } from "../cards/CardFaces.js";
import {
  cardFaceLabel,
  createRespondCommand,
  interactionLabel,
  isCompleteDiscardOrder,
  presentOption,
  projectionFromSync,
  responderName,
  responderPromptFor,
  sendAndRefreshResponse,
  type ReactionProjection,
} from "./model.js";
import "./reactions.css";

export interface ReactionTransport {
  sendMatchCommand(command: MatchCommand): Promise<CommandAck>;
  syncMatch(matchId: string): Promise<MatchSyncResponse>;
}

export interface ReactionPromptProps {
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
}: ReactionPromptProps) {
  const [syncedProjection, setSyncedProjection] = useState<(ReactionProjection & { readonly matchId: string }) | null>(null);
  const [pendingCommand, setPendingCommand] = useState<MatchCommand | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<{
    readonly matchId: string;
    readonly version: number;
    readonly interactionId: string;
    readonly cardInstanceIds: readonly string[];
  } | null>(null);
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
  }, [matchId, projection.version, pendingInteractionId]);
  if (!pending) return null;

  const responderPrompt = responderPromptFor(currentSnapshot);
  const isResponder = responderPrompt !== null;
  const activePendingCommand = pendingCommand?.matchId === matchId ? pendingCommand : null;
  const canRespond = isResponder && !busy && activePendingCommand === null;
  const responderHand = currentSnapshot.selfPrivate?.hand ?? [];
  const responderPlayerId = "currentResponderPlayerId" in pending
    ? pending.currentResponderPlayerId
    : null;
  const orderTemplate = responderPrompt?.responseOptions.find((option) =>
    option.choice === "ORDER_CARDS" && !("orderedCardInstanceIds" in option),
  );
  const discardOrder = responderPrompt?.discardOrder;
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
    setNotice("응답을 보내고 있어요.");

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
          : "응답을 반영하고 진행 상황을 새로 불러왔어요.");
      } else {
        setNotice("응답은 전송했지만 최신 진행 상태를 확인하지 못했어요. 같은 명령 ID로 다시 확인할 수 있습니다.");
      }
    } catch {
      if (currentMatchIdRef.current !== command.matchId) return;
      setNotice("응답 결과를 확인하지 못했어요. 같은 명령 ID로 다시 확인합니다.");
      try {
        await refreshProjection(command.matchId);
      } catch {
        setNotice("응답 결과와 최신 진행 상태를 확인하지 못했어요. 같은 명령을 보관했습니다.");
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

  return (
    <section className="reaction-prompt" aria-labelledby="reaction-prompt-title">
      <header className="reaction-prompt__header">
        <div>
          <p className="reaction-prompt__eyebrow">현재 응답</p>
          <h2 id="reaction-prompt-title">{interactionLabel(pending.kind)}</h2>
        </div>
        {"step" in pending ? (
          <span className="reaction-prompt__step" aria-label={`응답 단계 ${pending.step.current}/${pending.step.total}`}>
            {pending.step.current}/{pending.step.total}
          </span>
        ) : null}
      </header>

      {notice ? <p className="reaction-prompt__notice" role="status" aria-live="polite">{notice}</p> : null}

      {isResponder && responderPrompt ? (
        <>
          <p className="reaction-prompt__instruction">
            {currentResponderName ?? "현재 참가자"} 님 차례예요. 필요한 응답을 골라 주세요.
          </p>
          {orderTemplate ? (
            discardOrder ? (
              <fieldset className="reaction-prompt__discard-order">
                <legend>버릴 순서 선택 · {visibleOrder.length}/{discardOrder.requiredCount}장</legend>
                <p>선택한 순서대로 버려져요. 필요한 장수를 골라 주세요.</p>
                <ul className="reaction-prompt__discard-candidates" aria-label="버릴 카드 후보">
                  {discardOrder.allowedCards.map((card) => {
                    const orderIndex = visibleOrder.indexOf(card.cardInstanceId);
                    const selected = orderIndex >= 0;
                    return (
                      <li key={card.cardInstanceId}>
                        <div className="reaction-prompt__discard-candidate">
                          <button
                            className="reaction-prompt__discard-card-choice"
                            type="button"
                            aria-pressed={selected}
                            aria-label={`${cardFaceLabel(card)}${selected ? `, 선택 ${orderIndex + 1}, 다시 누르면 제외` : ", 버릴 순서에 추가"}`}
                            disabled={!canRespond || (!selected && visibleOrder.length >= discardOrder.requiredCount)}
                            onClick={() => toggleOrderCard(card.cardInstanceId)}
                          >
                            {selected ? <span className="reaction-prompt__discard-position">{orderIndex + 1}</span> : null}
                            <PlayingCardFace card={card} />
                            <span>{cardFaceLabel(card)}</span>
                          </button>
                          <PlayingCardZoomButton
                            card={card}
                            triggerClassName="reaction-prompt__discard-zoom-trigger"
                          />
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
                    선택한 순서 제출
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
          {responderPrompt.responseOptions.length > 0 ? (
            <ul className="reaction-prompt__options" aria-label="응답 선택지">
              {responderPrompt.responseOptions.map((option, index) => {
                const presentation = presentOption(option, currentSnapshot, index, responderPrompt.responseOptions.length);
                const isOrderTemplate = option.choice === "ORDER_CARDS" && !("orderedCardInstanceIds" in option);
                return (
                  <li key={`${option.choice}-${index}`}>
                    <div className="reaction-prompt__option-row">
                      <button
                        className="reaction-prompt__option"
                        type="button"
                        disabled={!canRespond || isOrderTemplate}
                        onClick={() => submitOption(option)}
                      >
                        <strong>{presentation.label}</strong>
                        {presentation.detail ? <span>{presentation.detail}</span> : null}
                      </button>
                      {responseCardFaces(option, responderHand).map((card) => (
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
          ) : (
            <p className="reaction-prompt__empty" role="status">현재 응답 선택지가 없습니다.</p>
          )}
          {activePendingCommand ? (
            <div className="reaction-prompt__retry">
              <p>이전 응답 결과를 기다리고 있어요. 같은 명령 ID로 다시 보내면 중복 실행되지 않습니다.</p>
              <button type="button" disabled={busy} onClick={retryPending}>
                {busy ? "확인 중…" : "같은 응답 다시 확인"}
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <p className="reaction-prompt__progress" role="status" aria-live="polite">
          {currentResponderName
            ? `${currentResponderName} 님이 응답 중이에요. 응답 내용은 다른 참가자에게 공개되지 않아요.`
            : "다른 좌석의 응답을 기다리고 있습니다. 진행 상황만 표시합니다."}
        </p>
      )}
    </section>
  );
}

function rejectionMessage(code: string): string {
  if (code === "STALE_VERSION") return "판이 업데이트되어 최신 진행 상태를 불러왔어요.";
  if (code === "INVALID_CHOICE" || code === "ILLEGAL_ACTION") return "응답을 반영하지 못했어요. 최신 선택지를 다시 확인해 주세요.";
  return "응답을 반영하지 못했어요. 최신 진행 상태를 다시 확인해 주세요.";
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
