import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  PROTOCOL_VERSION,
  type MatchStatus,
  type RoomCommand,
  type RoomSyncResponse,
  type RoomView,
} from "../../../../../packages/contracts/src/protocol.js";
import { parseRoomView } from "../../../../../packages/contracts/src/validation.js";
import type { MatchStatusSync } from "./model.js";
import {
  buildMatchStatusViewModel,
  formatLogTime,
  isMatchActionInputEnabled,
  mergeMatchStatusProjection,
} from "./model.js";
import "./status.css";

export interface StatusPanelProps {
  /** A server-authenticated match sync projection. */
  sync: MatchStatusSync;
  /** The latest server RoomSyncResponse projection for the current route. */
  room?: RoomView;
  roomVersion?: number;
  matchId?: string;
  transport?: ResultRoomTransport;
  createCommandId?: () => string;
}

export interface ResultRoomTransport {
  sendRoomCommand(command: RoomCommand): Promise<unknown>;
  syncRoom(roomId: string): Promise<RoomSyncResponse>;
}

export const RETURN_TO_LOBBY_ERROR_MESSAGE =
  "대기실로 돌아가지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.";

export function canReturnToLobbyFromResult(
  matchId: string | undefined,
  matchStatus: MatchStatus,
  matchViewerPlayerId: string,
  room: RoomView | undefined,
): room is RoomView {
  return matchId !== undefined && matchStatus === "completed" && room !== undefined &&
    room.status === "in_game" && room.activeMatchId === matchId &&
    room.viewer.isOwner && room.viewer.playerId === room.ownerPlayerId &&
    room.viewer.playerId === matchViewerPlayerId;
}

export function buildReturnToLobbyCommand(
  roomId: string,
  roomVersion: number,
  commandId: string,
): Extract<RoomCommand, { type: "RETURN_TO_LOBBY" }> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    commandId,
    expectedVersion: roomVersion,
    type: "RETURN_TO_LOBBY",
    roomId,
    payload: {},
  };
}

function preservesCompletedRoomSeats(previous: RoomView, next: RoomView): boolean {
  if (next.roomId !== previous.roomId || next.status !== "waiting" || next.activeMatchId !== null ||
      next.ownerPlayerId !== previous.ownerPlayerId || next.viewer.playerId !== previous.viewer.playerId ||
      next.viewer.isOwner !== previous.viewer.isOwner || next.members.length !== previous.members.length) return false;

  const previousSeats = new Map(previous.members.map((member) => [member.seatIndex, member.playerId]));
  return next.members.every((member) => previousSeats.get(member.seatIndex) === member.playerId);
}

/** Sends the exact owner command, validates its room projection, then waits for a newer room sync. */
export async function returnToLobbyFromResult({
  room,
  roomVersion,
  matchId,
  matchStatus,
  matchViewerPlayerId,
  transport,
  commandId,
}: {
  room: RoomView;
  roomVersion: number;
  matchId: string;
  matchStatus: MatchStatus;
  matchViewerPlayerId: string;
  transport: ResultRoomTransport;
  commandId: string;
}): Promise<void> {
  if (!canReturnToLobbyFromResult(matchId, matchStatus, matchViewerPlayerId, room)) {
    throw new Error("The latest room and completed match projections are inconsistent.");
  }

  const command = buildReturnToLobbyCommand(room.roomId, roomVersion, commandId);
  const acknowledgement = await transport.sendRoomCommand(command);
  const ackRoom = parseRoomView(acknowledgement);
  if (!ackRoom.ok || !preservesCompletedRoomSeats(room, ackRoom.value)) {
    throw new Error("The server did not confirm the room return.");
  }
  if (typeof ackRoom.value.version === "number" && ackRoom.value.version > roomVersion) return;

  const sync = await transport.syncRoom(room.roomId);
  if (sync.roomId !== room.roomId || sync.version <= roomVersion ||
      !preservesCompletedRoomSeats(room, sync.room)) {
    throw new Error("The latest room sync did not confirm the waiting room.");
  }
}

export function createSingleFlightRunner() {
  let inFlight = false;
  return async function run(
    action: () => Promise<void>,
    onStart: () => void,
    onFinish: () => void,
  ): Promise<boolean> {
    if (inFlight) return false;
    inFlight = true;
    try {
      onStart();
      await action();
      return true;
    } finally {
      inFlight = false;
      onFinish();
    }
  };
}

export async function attemptReturnToLobby(
  action: () => Promise<void>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await action();
    return { ok: true };
  } catch {
    return { ok: false, message: RETURN_TO_LOBBY_ERROR_MESSAGE };
  }
}

function defaultCommandId(): string {
  return crypto.randomUUID();
}

export function MatchInputGate({
  status,
  children,
}: {
  status: MatchStatus;
  children: ReactNode;
}) {
  const inputEnabled = isMatchActionInputEnabled(status);

  return (
    <fieldset
      className="match-status__input-gate"
      disabled={!inputEnabled}
      aria-disabled={!inputEnabled}
      data-input-enabled={inputEnabled ? "true" : "false"}
    >
      <legend className="sr-only">행동 입력</legend>
      {inputEnabled ? children : (
        <p role="status" aria-live="polite">
          지금은 행동을 고를 수 없어요.
        </p>
      )}
    </fieldset>
  );
}

export function StatusPanel({
  sync,
  room,
  roomVersion,
  matchId,
  transport,
  createCommandId = defaultCommandId,
}: StatusPanelProps) {
  const [returnBusy, setReturnBusy] = useState(false);
  const [returnFeedback, setReturnFeedback] = useState("");
  const [logOpen, setLogOpen] = useState(false);
  const [logNow, setLogNow] = useState(() => Date.now());
  useEffect(() => {
    if (!logOpen) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const update = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (!document.hidden) {
        setLogNow(Date.now());
        timer = setInterval(() => setLogNow(Date.now()), 1000);
      }
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => { if (timer) clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, [logOpen]);
  const singleFlight = useRef(createSingleFlightRunner()).current;

  const projection = useMemo(
    () => mergeMatchStatusProjection(null, sync),
    [sync.version, sync.snapshot, sync.visibleEvents],
  );
  const view = useMemo(() => buildMatchStatusViewModel(projection), [projection]);
  const canReturn = canReturnToLobbyFromResult(
    matchId,
    projection.status,
    sync.snapshot.viewer.playerId,
    room,
  ) && roomVersion !== undefined && transport !== undefined;
  const waitingForOwner = projection.status === "completed" && room?.status === "in_game" &&
    room.activeMatchId === matchId && room.viewer.playerId === sync.snapshot.viewer.playerId &&
    !room.viewer.isOwner && !canReturn;

  async function submitReturnToLobby() {
    if (!canReturn || !room || roomVersion === undefined || !matchId || !transport) return;
    const started = await singleFlight(async () => {
      const result = await attemptReturnToLobby(() => returnToLobbyFromResult({
        room,
        roomVersion,
        matchId,
        matchStatus: projection.status,
        matchViewerPlayerId: sync.snapshot.viewer.playerId,
        transport,
        commandId: createCommandId(),
      }));
      if (!result.ok) setReturnFeedback(result.message);
    }, () => {
      setReturnBusy(true);
      setReturnFeedback("");
    }, () => setReturnBusy(false));
    if (!started) return;
  }

  return (
    <section
      className={`match-status match-status--${view.status}`}
      aria-label="게임 진행 상태"
      data-match-version={projection.version}
      data-input-enabled={view.inputEnabled ? "true" : "false"}
    >
      {projection.status !== "completed" ? (
        <>
          <header className="match-status__header">
            <div>
              <p className="match-status__eyebrow">현재 판</p>
              <h2>게임 진행</h2>
            </div>
            <span className="match-status__badge">{view.statusLabel}</span>
          </header>

          <section className="match-status__turn" aria-label="현재 차례와 단계">
            <div>
              <span className="match-status__label">현재 차례</span>
              <strong>{view.currentPlayerName}</strong>
            </div>
            <div>
              <span className="match-status__label">진행 단계</span>
              <strong>{view.phaseLabel}</strong>
            </div>
          </section>

          <p className="match-status__message" role="status" aria-live="polite">
            {view.statusMessage}
          </p>
        </>
      ) : null}

      {view.resultTitle ? (
        <section className="match-status__result" aria-labelledby="match-result-title" aria-live="polite">
          <p className="match-status__eyebrow">이번 판</p>
          <h1 id="match-result-title">{view.resultTitle}</h1>
          {view.winningFactionLabel ? (
            <p className="match-status__result-faction">
              <span>승리 진영</span>
              <strong>{view.winningFactionLabel}</strong>
            </p>
          ) : (
            <p>승리 정보를 확인할 수 없어요.</p>
          )}
          {view.winningPlayerNames.length > 0 ? (
            <div className="match-status__result-group">
              <h4>승리 플레이어</h4>
              <ul>
                {view.winningPlayerNames.map((name, index) => (
                  <li key={`${index}-${name}`}>{name}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {view.revealedRoles.length > 0 ? (
            <div className="match-status__result-group">
              <h4>공개된 역할</h4>
              <ul>
                {view.revealedRoles.map(({ playerName, roleLabel }, index) => (
                  <li key={`${index}-${playerName}`}>
                    <span>{playerName}</span>
                    <span>{roleLabel}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="match-status__result-message">{view.resultMessage}</p>
          {canReturn ? (
            <div className="match-status__return-lobby" aria-busy={returnBusy}>
              <button
                type="button"
                className="button button-primary"
                disabled={returnBusy}
                onClick={() => void submitReturnToLobby()}
              >
                {returnBusy ? "대기실로 돌아가는 중…" : "대기실로 돌아가기"}
              </button>
              {returnFeedback ? (
                <p className="match-status__return-lobby-error" role="alert" aria-live="assertive">
                  {returnFeedback}
                </p>
              ) : null}
            </div>
          ) : null}
          {waitingForOwner ? (
            <p className="match-status__waiting-owner" role="status">
              대기실로 돌아가는 일은 방장이 진행해요. 결과를 확인하며 잠시 기다려 주세요.
            </p>
          ) : null}
        </section>
      ) : null}

      <details className="match-status__log" onToggle={(event) => setLogOpen(event.currentTarget.open)}>
        <summary className="match-status__log-summary" id="match-public-log-title">
          게임 기록
        </summary>
        {logOpen && view.publicLog.length > 0 ? (
          <ol className="match-status__events" aria-label="공개 게임 이벤트">
            {view.publicLog.map((entry) => (
              <li key={entry.eventSeq} data-event-seq={entry.eventSeq}>
                <span><time dateTime={entry.occurredAt}>{formatLogTime(entry.occurredAt, logNow)}</time> - {entry.message}</span>
              </li>
            ))}
          </ol>
        ) : logOpen ? (
          <p className="match-status__empty-log">아직 표시할 공개 기록이 없어요.</p>
        ) : null}
      </details>
    </section>
  );
}
