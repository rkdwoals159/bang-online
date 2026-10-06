import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { GuestSessionResponse, RoomView } from "../../../../../packages/contracts/src/protocol.js";
import {
  CONNECTION_ERROR_MESSAGE,
  INVALID_INVITE_MESSAGE,
  makeCreateRoomCommand,
  makeGuestSessionRequest,
  makeInviteUrl,
  createInviteJoiner,
  type RoomCapacity,
  type RoomEntryCreateResult,
  type RoomEntryTransport,
} from "./model";
import "./room-entry.css";

export interface RoomEntryProps {
  transport: RoomEntryTransport;
  initialMode?: "choose" | "create" | "join";
  initialInviteCode?: string;
  createCommandId?: () => string;
  onRoomReady?: (room: RoomView) => void;
  onRoomCreated?: (room: RoomEntryCreateResult) => void;
}

type EntryMode = "choose" | "create" | "join";
type BusyOperation = "session" | "create" | "join" | null;

const capacityOptions: readonly RoomCapacity[] = [4, 5, 6, 7];
const statusLabels: Record<RoomView["status"], string> = {
  waiting: "대기 중",
  starting: "게임을 준비 중",
  in_game: "게임 진행 중",
  paused: "게임 일시 정지",
  completed: "게임 종료",
  closed: "닫힌 방",
};

function commandId(): string {
  return globalThis.crypto.randomUUID();
}

function initialCode(initialInviteCode?: string): string {
  if (initialInviteCode !== undefined) return initialInviteCode;
  return typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("code")?.trim() ?? "";
}

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function RoomEntry({
  transport,
  initialMode = "choose",
  initialInviteCode,
  createCommandId = commandId,
  onRoomReady,
  onRoomCreated,
}: RoomEntryProps) {
  const [guest, setGuest] = useState<GuestSessionResponse | null>(null);
  const [assignedRooms, setAssignedRooms] = useState<readonly RoomView[]>([]);
  const [restoringSession, setRestoringSession] = useState(true);
  const [mode, setMode] = useState<EntryMode>(initialMode);
  const [displayName, setDisplayName] = useState("");
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);
  const [capacity, setCapacity] = useState<RoomCapacity>(4);
  const linkedInviteCode = useRef(initialCode(initialInviteCode));
  const [inviteInput, setInviteInput] = useState(() => linkedInviteCode.current && typeof window !== "undefined"
    ? makeInviteUrl(linkedInviteCode.current, window.location.origin) : "");
  const [createdRoom, setCreatedRoom] = useState<RoomEntryCreateResult | null>(null);
  const [joinedRoom, setJoinedRoom] = useState<RoomView | null>(null);
  const [busy, setBusy] = useState<BusyOperation>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const createIntent = useRef<{ capacity: RoomCapacity; commandId: string } | null>(null);
  const autoJoinAttempted = useRef(false);
  const joinBusy = useRef(false);
  const mounted = useRef(true);
  const joinInvite = useMemo(() => createInviteJoiner(transport, createCommandId), [transport, createCommandId]);

  const enterRoom = useCallback(async (input: string) => {
    if (joinBusy.current) return;
    joinBusy.current = true;
    setJoinedRoom(null);
    setErrorMessage(null);
    setNotice(null);
    setBusy("join");
    try {
      const room = await joinInvite(input, typeof window === "undefined" ? undefined : window.location.origin);
      if (!mounted.current) return;
      setJoinedRoom(room);
      setNotice("대기실에 입장했어요.");
      onRoomReady?.(room);
    } catch (error) {
      if (mounted.current) setErrorMessage(messageFrom(error, INVALID_INVITE_MESSAGE));
    } finally {
      joinBusy.current = false;
      if (mounted.current) setBusy(null);
    }
  }, [joinInvite, onRoomReady]);

  useEffect(() => {
    let active = true;
    mounted.current = true;
    async function restore() {
      try {
        const restored = await transport.restoreGuestSession();
        if (!active) return;
        setGuest(restored);
        if (restored && !(initialMode === "join" && linkedInviteCode.current)) {
          try {
            const rooms = await transport.recoverAssignedSeats();
            if (active) setAssignedRooms(rooms);
          } catch {
            if (active) setErrorMessage("이전 방의 좌석을 불러오지 못했어요. 다시 시도해 주세요.");
          }
        }
      } catch {
        if (active) setErrorMessage(CONNECTION_ERROR_MESSAGE);
      } finally {
        if (active) setRestoringSession(false);
      }
    }
    void restore();
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [transport, initialMode]);

  useEffect(() => {
    if (guest && !restoringSession && mode === "join" && busy === null && linkedInviteCode.current && !autoJoinAttempted.current) {
      autoJoinAttempted.current = true;
      void enterRoom(linkedInviteCode.current);
    }
  }, [guest, restoringSession, mode, busy, enterRoom]);

  async function handleGuestSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setNotice(null);
    let request;
    try {
      request = makeGuestSessionRequest(displayName);
    } catch (error) {
      setDisplayNameError(messageFrom(error, "이름을 확인해 주세요."));
      return;
    }
    setDisplayNameError(null);
    setBusy("session");
    try {
      const created = await transport.createGuestSession(request);
      const shouldJoin = mode === "join" && (linkedInviteCode.current || inviteInput.trim());
      if (shouldJoin) autoJoinAttempted.current = true;
      setGuest(created);
      setAssignedRooms([]);
      setErrorMessage(null);
      if (shouldJoin) await enterRoom(linkedInviteCode.current || inviteInput);
      else setNotice("참여 준비가 됐어요. 방을 만들거나 초대 링크로 참가할 수 있어요.");
    } catch (error) {
      setErrorMessage(messageFrom(error, CONNECTION_ERROR_MESSAGE));
    } finally {
      setBusy(null);
    }
  }

  async function handleCreateRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!guest) return;
    setErrorMessage(null);
    setNotice(null);
    setCreatedRoom(null);
    setBusy("create");
    const currentIntent = createIntent.current;
    const intent = currentIntent?.capacity === capacity
      ? currentIntent
      : { capacity, commandId: createCommandId() };
    createIntent.current = intent;
    try {
      const created = await transport.createRoom(makeCreateRoomCommand(guest.player, capacity, intent.commandId));
      const safeResult = created.duplicate
        ? { ...created, inviteCode: null }
        : created;
      setCreatedRoom(safeResult);
      createIntent.current = null;
      if (safeResult.inviteCode === null) {
        setNotice("대기실에서 초대 링크를 발급할 수 있어요.");
      } else {
        setNotice("방이 만들어졌어요. 초대 링크를 친구에게 공유해 주세요.");
      }
      onRoomCreated?.(safeResult);
    } catch (error) {
      setErrorMessage(messageFrom(error, CONNECTION_ERROR_MESSAGE));
    } finally {
      setBusy(null);
    }
  }

  async function handleJoinSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!guest) return;
    autoJoinAttempted.current = true;
    await enterRoom(inviteInput);
  }

  async function copyInviteLink() {
    if (!createdRoom?.inviteCode) return;
    const link = makeInviteUrl(createdRoom.inviteCode, window.location.origin);
    try {
      await navigator.clipboard.writeText(link);
      setNotice("초대 링크를 복사했어요.");
    } catch {
      setNotice("초대 링크를 복사하지 못했어요. 링크를 선택해 직접 복사해 주세요.");
    }
  }

  function selectMode(nextMode: EntryMode) {
    setMode(nextMode);
    setErrorMessage(null);
    setNotice(null);
    setCreatedRoom(null);
    setJoinedRoom(null);
  }

  return (
    <section className="room-entry" aria-labelledby="room-entry-title">
      <header className="room-entry__header">
        <p className="room-entry__eyebrow">기본판 · 4–7명</p>
        <h1 id="room-entry-title">친구와 뱅! 시작하기</h1>
        <p>이름을 정한 뒤 방을 만들거나 초대 링크로 바로 참가하세요.</p>
      </header>

      {errorMessage && <p className="room-entry__message room-entry__message--error" role="alert">{errorMessage}</p>}
      {notice && <p className="room-entry__message room-entry__message--notice" role="status" aria-live="polite">{notice}</p>}

      {restoringSession ? (
        <section className="room-entry__panel" role="status" aria-live="polite">
          <span className="room-entry__spinner" aria-hidden="true" />
          <p>이 브라우저의 참여 정보를 확인하고 있어요.</p>
        </section>
      ) : guest ? (
        <>
          <section className="room-entry__identity" aria-label="내 참여 정보">
            <span className="room-entry__identity-mark" aria-hidden="true">{guest.player.displayName.slice(0, 1)}</span>
            <div>
              <p className="room-entry__identity-label">현재 게스트</p>
              <p className="room-entry__identity-name">{guest.player.displayName}</p>
            </div>
            <p className="room-entry__cookie-note">이 브라우저의 참여 정보로 다시 들어올 수 있어요.</p>
          </section>

          {assignedRooms.length > 0 && (
            <section className="room-entry__panel" aria-labelledby="room-entry-rejoin-title">
              <div className="room-entry__section-heading">
                <div>
                  <p className="room-entry__eyebrow">이어서 참가</p>
                  <h2 id="room-entry-rejoin-title">내가 참여 중인 방</h2>
                </div>
              </div>
              <ul className="room-entry__assigned-list">
                {assignedRooms.map((room) => (
                  <li key={room.roomId}>
                    <span>
                      <strong>{room.roomId}</strong>
                      <small>{statusLabels[room.status]} · {room.members.length}명</small>
                    </span>
                    <button className="room-entry__button room-entry__button--secondary" onClick={() => onRoomReady?.(room)}>
                      좌석으로 돌아가기
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {mode === "choose" ? (
            <section className="room-entry__choices" aria-label="방 선택">
              <button className="room-entry__choice" onClick={() => selectMode("create")}>
                <span className="room-entry__choice-icon" aria-hidden="true">＋</span>
                <span><strong>새 비공개 방 만들기</strong><small>방을 만들고 초대 링크를 공유합니다.</small></span>
                <span className="room-entry__choice-arrow" aria-hidden="true">→</span>
              </button>
              <button className="room-entry__choice" onClick={() => selectMode("join")}>
                <span className="room-entry__choice-icon" aria-hidden="true">↗</span>
                <span><strong>초대 링크로 참가</strong><small>링크를 열면 대기실로 바로 입장합니다.</small></span>
                <span className="room-entry__choice-arrow" aria-hidden="true">→</span>
              </button>
            </section>
          ) : mode === "create" ? (
            <section className="room-entry__panel" aria-labelledby="room-entry-create-title">
              <div className="room-entry__section-heading">
                <div>
                  <p className="room-entry__eyebrow">새 게임</p>
                  <h2 id="room-entry-create-title">새 비공개 방 만들기</h2>
                </div>
                <button className="room-entry__text-button" onClick={() => selectMode("choose")}>뒤로</button>
              </div>
              <form className="room-entry__form" onSubmit={handleCreateRoom}>
                <label htmlFor="room-entry-capacity">방 인원</label>
                <select
                  id="room-entry-capacity"
                  value={capacity}
                  onChange={(event) => setCapacity(Number(event.currentTarget.value) as RoomCapacity)}
                  disabled={busy !== null}
                >
                  {capacityOptions.map((option) => <option key={option} value={option}>{option}명</option>)}
                </select>
                <p className="room-entry__hint">정원은 4명부터 7명까지 선택할 수 있어요.</p>
                <button className="room-entry__button room-entry__button--primary" disabled={busy !== null}>
                  {busy === "create" ? "방을 만들고 있어요…" : "비공개 방 만들기"}
                </button>
              </form>

              {createdRoom?.inviteCode ? (
                <div className="room-entry__invite-result" aria-live="polite">
                  <p className="room-entry__eyebrow">친구 초대</p>
                  <h3>친구를 초대하세요</h3>
                  <label htmlFor="room-entry-invite-link">초대 링크</label>
                  <input id="room-entry-invite-link" value={makeInviteUrl(createdRoom.inviteCode, window.location.origin)} readOnly />
                  <button type="button" className="room-entry__button room-entry__button--secondary" onClick={() => void copyInviteLink()}>
                    초대 링크 복사
                  </button>
                </div>
              ) : createdRoom?.duplicate ? (
                <div className="room-entry__invite-result" role="status">
                  <h3>생성 결과를 다시 확인했어요</h3>
                  <p>방은 이미 만들어졌어요. 초대 링크를 다시 표시할 수 없으니 새 초대가 필요하면 새 방을 만들어 주세요.</p>
                </div>
              ) : null}
            </section>
          ) : (
            <section className="room-entry__panel" aria-labelledby="room-entry-join-title">
              <div className="room-entry__section-heading">
                <div>
                  <p className="room-entry__eyebrow">초대받으셨나요?</p>
                  <h2 id="room-entry-join-title">초대 링크로 참가</h2>
                </div>
                <button className="room-entry__text-button" onClick={() => selectMode("choose")}>뒤로</button>
              </div>
              <form className="room-entry__form" onSubmit={handleJoinSubmit}>
                <label htmlFor="room-entry-link">초대 링크</label>
                <input
                  id="room-entry-link"
                  type="url"
                  required
                  autoComplete="off"
                  value={inviteInput}
                  onChange={(event) => {
                    setInviteInput(event.currentTarget.value);
                    setErrorMessage(null);
                  }}
                  placeholder="친구에게 받은 초대 링크를 붙여 넣으세요"
                  disabled={busy !== null}
                />
                <button className="room-entry__button room-entry__button--primary" disabled={busy !== null || inviteInput.trim().length === 0}>
                  {busy === "join" ? "입장하고 있어요…" : "대기실 입장"}
                </button>
              </form>
            </section>
          )}

          {joinedRoom && (
            <section className="room-entry__joined" role="status">
              <p className="room-entry__eyebrow">참가 완료</p>
              <h2>{joinedRoom.roomId}</h2>
              <p>{joinedRoom.members.length}명이 있는 방에 참가했습니다.</p>
            </section>
          )}
        </>
      ) : (
        <section className="room-entry__panel" aria-labelledby="room-entry-guest-title">
          <div className="room-entry__section-heading">
            <div>
              <p className="room-entry__eyebrow">계정 없이 시작</p>
              <h2 id="room-entry-guest-title">게스트 이름을 정해 주세요</h2>
            </div>
          </div>
          <form className="room-entry__form" onSubmit={handleGuestSubmit}>
            <label htmlFor="room-entry-name">표시 이름</label>
            <input
              id="room-entry-name"
              autoComplete="nickname"
              value={displayName}
              onChange={(event) => {
                setDisplayName(event.currentTarget.value);
                setDisplayNameError(null);
              }}
              aria-invalid={displayNameError !== null}
              aria-describedby={displayNameError ? "room-entry-name-help room-entry-name-error" : "room-entry-name-help"}
              placeholder="방에서 사용할 이름"
              disabled={busy !== null}
            />
            <p id="room-entry-name-help" className="room-entry__hint">앞뒤 공백을 뺀 1–20자예요. 같은 이름도 사용할 수 있어요.</p>
            {displayNameError && <p id="room-entry-name-error" className="room-entry__field-error" role="alert">{displayNameError}</p>}
            {mode === "join" && !linkedInviteCode.current ? <>
              <label htmlFor="room-entry-guest-link">초대 링크</label>
              <input id="room-entry-guest-link" type="url" required value={inviteInput} onChange={event => setInviteInput(event.currentTarget.value)} placeholder="친구에게 받은 초대 링크를 붙여 넣으세요" disabled={busy !== null} />
            </> : null}
            <button className="room-entry__button room-entry__button--primary" disabled={busy !== null}>
              {busy === "session" ? "참여 준비 중…" : busy === "join" ? "입장하고 있어요…" : mode === "join" ? "대기실 입장" : "게스트로 계속"}
            </button>
          </form>
        </section>
      )}
    </section>
  );
}
