import { useMemo, useState } from "react";
import type { RoomCommand, RoomView } from "../../../../../packages/contracts/src/protocol.js";
import type { TransportConnectionState } from "../../transport/types.js";
import { makeInviteUrl } from "../room-entry/model.js";
import {
  buildRoomLobbyViewModel,
  makeKickMemberCommand,
  makeSetReadyCommand,
  makeStartMatchCommand,
  type LobbyRoomCommand,
} from "./model.js";
import "./lobby.css";

export interface LobbyProps {
  room: RoomView;
  /** Version from the latest server RoomSyncResponse. */
  roomVersion: number;
  /** The one-time room invite value from room creation; RoomView itself omits it. */
  inviteCode?: string | null;
  /** Local transport state can give the viewer a fresher reconnect hint than the room projection. */
  viewerConnectionState?: TransportConnectionState;
  /** Parent owns T58 transport, syncing and receipt handling. */
  onCommand: (command: LobbyRoomCommand) => void | Promise<void>;
  createCommandId?: () => string;
  origin?: string;
}

function commandId(): string {
  return crypto.randomUUID();
}

function browserOrigin(override?: string): string | null {
  if (override) return override;
  return typeof window === "undefined" ? null : window.location.origin;
}

function isLobbyCommand(command: RoomCommand): command is LobbyRoomCommand {
  return command.type === "SET_READY" || command.type === "START_MATCH" || command.type === "KICK_MEMBER";
}

export function Lobby({
  room,
  roomVersion,
  inviteCode = null,
  viewerConnectionState,
  onCommand,
  createCommandId = commandId,
  origin,
}: LobbyProps) {
  const view = useMemo(() => buildRoomLobbyViewModel(room), [room]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [inviteFeedback, setInviteFeedback] = useState("");
  const resolvedOrigin = browserOrigin(origin);
  const inviteUrl = inviteCode && view.canInvite && resolvedOrigin
    ? makeInviteUrl(inviteCode, resolvedOrigin)
    : null;

  async function submit(command: LobbyRoomCommand) {
    if (busy) return;
    setBusy(true);
    setFeedback("");
    try {
      await onCommand(command);
    } catch {
      setFeedback("요청을 반영하지 못했어요. 최신 방 상태를 불러온 뒤 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  async function copyInviteUrl() {
    if (!inviteUrl || !navigator.clipboard) {
      setInviteFeedback("초대 링크를 직접 선택해 복사해 주세요.");
      return;
    }
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setInviteFeedback("초대 링크를 복사했어요.");
    } catch {
      setInviteFeedback("복사할 수 없어요. 초대 링크를 직접 선택해 복사해 주세요.");
    }
  }

  function send(command: RoomCommand) {
    if (isLobbyCommand(command)) void submit(command);
  }

  return (
    <main className="room-lobby" aria-labelledby="room-lobby-title">
      <header className="room-lobby__header">
        <div>
          <p className="room-lobby__eyebrow">게임 준비 · 기본판</p>
          <h1 id="room-lobby-title">대기실</h1>
          <p className="room-lobby__room-id">방 ID <strong>{room.roomId}</strong></p>
        </div>
        <span className={`room-lobby__status room-lobby__status--${room.status}`}>
          {view.statusLabel}
        </span>
      </header>

      <section className="room-lobby__panel" aria-labelledby="room-lobby-members-title">
        <div className="room-lobby__section-heading">
          <div>
            <p className="room-lobby__eyebrow">참가자</p>
            <h2 id="room-lobby-members-title">좌석과 준비 상태</h2>
          </div>
          <p className="room-lobby__occupancy" aria-label={`현재 ${view.occupancy}명, 최대 ${view.capacity}명`}>
            {view.occupancy}<span> / {view.capacity}명</span>
          </p>
        </div>

        <ul className="room-lobby__seats" aria-label="방 좌석">
          {view.seats.map((seat) => (
            <li className={`room-lobby__seat${seat.member ? " room-lobby__seat--occupied" : " room-lobby__seat--empty"}`} key={seat.seatIndex}>
              <span className="room-lobby__seat-number">좌석 {seat.seatNumber}</span>
              {seat.member ? (
                <>
                  <div className="room-lobby__member">
                    <span className="room-lobby__avatar" aria-hidden="true">
                      {seat.member.displayName.slice(0, 1)}
                    </span>
                    <div className="room-lobby__member-copy">
                      <strong>{seat.member.displayName}</strong>
                      <span>{seat.isOwner ? "방장" : "게스트"}{seat.isViewer ? " · 나" : ""}</span>
                    </div>
                  </div>
                  <span className={`room-lobby__ready${seat.member.ready ? " room-lobby__ready--yes" : ""}`}>
                    <span aria-hidden="true">{seat.member.ready ? "✓" : "○"}</span>
                    {seat.readinessLabel}
                  </span>
                  <span
                    className={`room-lobby__connection room-lobby__connection--${connectionStateForSeat(seat.member, seat.isViewer, viewerConnectionState)}`}
                    role="status"
                  >
                    {connectionLabelForSeat(seat.member, seat.isViewer, viewerConnectionState)}
                  </span>
                  {seat.canKick && (
                    <button
                      type="button"
                      className="room-lobby__kick"
                      disabled={busy || room.status !== "waiting"}
                      aria-label={`${seat.member.displayName} 내보내기`}
                      onClick={() => send(makeKickMemberCommand(room.roomId, roomVersion, seat.member!.playerId, createCommandId()))}
                    >
                      내보내기
                    </button>
                  )}
                </>
              ) : (
                <div className="room-lobby__empty-seat">
                  <span className="room-lobby__empty-mark" aria-hidden="true">＋</span>
                  <span>초대를 기다리는 자리</span>
                </div>
              )}
            </li>
          ))}
        </ul>

        <p className="room-lobby__status-message" role="status" aria-live="polite">
          {view.statusMessage}
        </p>
        {room.members.some((member) => member.connectionState === "disconnected") ||
          viewerConnectionState === "connecting" || viewerConnectionState === "disconnected" ? (
          <p className="room-lobby__connection-hint" role="status" aria-live="polite">
            연결이 끊겨도 좌석은 유지돼요. 잠시 기다리거나 초대 링크로 다시 들어와 주세요.
          </p>
        ) : null}
      </section>

      <section className="room-lobby__actions" aria-label="대기실 작업">
        <div className="room-lobby__panel room-lobby__ready-panel">
          <div>
            <p className="room-lobby__eyebrow">내 상태</p>
            <h2>{view.viewerReady ? "준비 완료" : "아직 준비 전"}</h2>
            <p className="room-lobby__hint">
              {view.canSetReady
                ? "준비 상태는 서버 방 상태에 따라 다른 참가자에게 표시돼요."
                : "대기 중인 방에서만 준비 상태를 바꿀 수 있어요."}
            </p>
          </div>
          <button
            type="button"
            className="room-lobby__button room-lobby__button--secondary"
            disabled={!view.canSetReady || busy}
            onClick={() => send(makeSetReadyCommand(room.roomId, roomVersion, view.nextReadyValue, createCommandId()))}
          >
            {view.viewerReady ? "준비 취소" : "준비 완료"}
          </button>
        </div>

        <div className="room-lobby__panel room-lobby__start-panel">
          <div>
            <p className="room-lobby__eyebrow">게임 시작</p>
            <h2>{view.viewerIsOwner ? "방장" : "방장 대기 중"}</h2>
            <p className="room-lobby__hint">
              {view.startBlockedReason ?? "모두 준비했어요. 방장이 시작 명령을 보내면 게임이 시작됩니다."}
            </p>
          </div>
          <button
            type="button"
            className="room-lobby__button room-lobby__button--primary"
            disabled={!view.canStart || busy}
            onClick={() => send(makeStartMatchCommand(room.roomId, roomVersion, createCommandId()))}
          >
            게임 시작
          </button>
        </div>
      </section>

      <section className="room-lobby__panel room-lobby__invite-panel" aria-labelledby="room-lobby-invite-title">
        <div>
          <p className="room-lobby__eyebrow">친구 초대</p>
          <h2 id="room-lobby-invite-title">비공개 링크 공유</h2>
          <p className="room-lobby__hint">{view.inviteMessage}</p>
        </div>
        {inviteUrl ? (
          <div className="room-lobby__invite-controls">
            <label className="room-lobby__sr-only" htmlFor="room-lobby-invite-url">초대 링크</label>
            <input id="room-lobby-invite-url" value={inviteUrl} readOnly />
            <button type="button" className="room-lobby__button room-lobby__button--secondary" onClick={() => void copyInviteUrl()}>
              링크 복사
            </button>
            {inviteFeedback && <p className="room-lobby__hint" role="status" aria-live="polite">{inviteFeedback}</p>}
          </div>
        ) : (
          <p className="room-lobby__invite-locked" role="status">{view.inviteMessage}</p>
        )}
      </section>

      {feedback && <p className="room-lobby__error" role="alert">{feedback}</p>}
    </main>
  );
}

type LobbyConnectionLabel = "connected" | "disconnected" | "unknown" | "connecting" | "expired";

function connectionStateForSeat(
  member: RoomView["members"][number],
  isViewer: boolean,
  viewerConnectionState?: TransportConnectionState,
): LobbyConnectionLabel {
  if (isViewer) {
    if (viewerConnectionState === "connecting") return "connecting";
    if (viewerConnectionState === "disconnected") return "disconnected";
    if (viewerConnectionState === "expired") return "expired";
    if (viewerConnectionState === "connected") return "connected";
  }
  return member.connectionState === "connected" || member.connectionState === "disconnected"
    ? member.connectionState
    : "unknown";
}

function connectionLabelForSeat(
  member: RoomView["members"][number],
  isViewer: boolean,
  viewerConnectionState?: TransportConnectionState,
): string {
  const state = connectionStateForSeat(member, isViewer, viewerConnectionState);
  switch (state) {
    case "connected": return "연결됨";
    case "disconnected": return isViewer ? "연결 끊김 · 복구 중" : "연결 끊김 · 기다리는 중";
    case "connecting": return "다시 연결 중";
    case "expired": return "참여 정보 만료";
    case "unknown": return "연결 상태 확인 중";
  }
}
