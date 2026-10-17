import { useEffect, useId, useRef, useState } from "react";
import type { RoomView } from "../../../../../packages/contracts/src/protocol.js";
import { roomExitMessage, type RoomExitAction } from "./room-exit.js";
import "./room-exit.css";
import { BrowserTransportError } from "../../transport/errors.js";

export function RoomExitActions({ room, onAction, onExited }: {
  room: RoomView;
  onAction: (roomId: string, action: RoomExitAction) => Promise<void>;
  onExited: () => void;
}) {
  const [action, setAction] = useState<RoomExitAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  const owner = room.viewer.isOwner && room.viewer.playerId === room.ownerPlayerId;
  useEffect(() => { if (action) cancel.current?.focus(); }, [action]);
  if (room.status === "closed") return null;
  function dismiss() { if (locked.current) return; setAction(null); setError(""); trigger.current?.focus(); }
  async function submit() {
    if (!action || locked.current) return;
    locked.current = true; setBusy(true); setError("");
    try { await onAction(room.roomId, action); onExited(); }
    catch (failure) { setError(failure instanceof Error && !(failure instanceof BrowserTransportError) ? failure.message : "처리하지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요."); }
    finally { locked.current = false; setBusy(false); }
  }
  return <div className="room-exit" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); dismiss(); } }}>
    <div className="room-exit__buttons">
      <button type="button" disabled={busy} aria-expanded={action === "LEAVE_ROOM"} aria-controls={id}
        onClick={event => { trigger.current = event.currentTarget; setError(""); setAction("LEAVE_ROOM"); }}>방 나가기</button>
      {owner ? <button type="button" className="room-exit__danger" disabled={busy} aria-expanded={action === "CLOSE_ROOM"} aria-controls={id}
        onClick={event => { trigger.current = event.currentTarget; setError(""); setAction("CLOSE_ROOM"); }}>방 삭제하기</button> : null}
    </div>
    {action ? <section className="room-exit__confirmation" id={id} aria-label={action === "CLOSE_ROOM" ? "방 삭제 확인" : "방 나가기 확인"} aria-busy={busy}>
      <strong>{action === "CLOSE_ROOM" ? "이 방의 모두를 내보내고 삭제할까요?" : "이 방에서 나갈까요?"}</strong>
      <span className="room-exit__room-id">{room.roomId}</span>
      <p>{roomExitMessage(room, action)}</p>
      {error ? <p className="room-exit__error" role="alert">{error}</p> : null}
      <div className="room-exit__buttons">
        <button type="button" ref={cancel} onClick={dismiss} disabled={busy}>취소</button>
        <button type="button" className="room-exit__danger" onClick={() => void submit()} disabled={busy}>
          {busy ? "처리 중…" : action === "CLOSE_ROOM" ? "모두 내보내고 방 삭제" : "방 나가기 확인"}
        </button>
      </div>
    </section> : null}
  </div>;
}
