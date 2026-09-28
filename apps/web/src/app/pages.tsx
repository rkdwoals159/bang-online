import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MatchSnapshotView, RoomView, PublicMatchEvent } from "../../../../packages/contracts/src/protocol.js";
import { ActionsPanel } from "../features/actions/ActionsPanel.js";
import { CharacterCardFace, RoleCardFace } from "../features/cards/CardFaces.js";
import { GameTable } from "../features/game-table/GameTable.js";
import { Lobby } from "../features/lobby/Lobby.js";
import { ReactionPrompt } from "../features/reactions/ReactionPrompt.js";
import { MatchInputGate, StatusPanel } from "../features/status/StatusPanel.js";
import { RoomEntry } from "../features/room-entry/RoomEntry.js";
import type { BrowserTransportState, MatchProjectionState, TransportConnectionState } from "../transport/types.js";
import { AppLink, navigateTo, replaceTo, type AppRoute } from "./router.js";
import { useAppState, type SessionRecovery } from "./app-state.js";
import { ErrorFrame, LoadingFrame } from "./app-frames.js";

type RoomSurface =
  | { kind: "lobby" }
  | { kind: "starting" }
  | { kind: "syncing-match"; matchId: string }
  | { kind: "role-reveal"; matchId: string }
  | { kind: "game"; matchId: string }
  | { kind: "result"; matchId: string }
  | { kind: "closed" }
  | { kind: "invalid"; message: string };

type RoomScreen = RoomSurface["kind"] | "role-reveal";

/** Selects a screen only from the authoritative room and match projections. */
export function roomSurface(
  room: RoomView,
  match: MatchProjectionState | undefined,
): RoomSurface {
  if (room.status === "waiting") {
    return room.activeMatchId === null
      ? { kind: "lobby" }
      : { kind: "invalid", message: "방 상태와 활성 매치 정보가 일치하지 않아요." };
  }
  if (room.status === "starting") return { kind: "starting" };
  if (room.status === "closed") return { kind: "closed" };
  if (!room.activeMatchId) {
    return { kind: "invalid", message: "활성 매치 정보를 불러오지 못했어요." };
  }
  if (!match) {
    return { kind: "syncing-match", matchId: room.activeMatchId };
  }
  if (room.status === "completed" && match.snapshot.status !== "completed") {
    return { kind: "syncing-match", matchId: room.activeMatchId };
  }
  return match.snapshot.status === "completed"
    ? { kind: "result", matchId: room.activeMatchId }
    : { kind: "game", matchId: room.activeMatchId };
}

export function roomConnectionStatusMessage(
  connection: TransportConnectionState,
  lastError: BrowserTransportState["lastError"],
  awaitingAuthoritativeSync: boolean,
  connectionWasLost: boolean,
): string | null {
  if (connection === "disconnected" || lastError === "CONNECTION" || connectionWasLost) {
    return "연결 끊김 · 재접속 시 현재 판을 복구합니다";
  }
  if (connection === "connecting" && awaitingAuthoritativeSync) {
    return "보안 세션으로 서버에 연결하고 있어요.";
  }
  if (connection === "connected" && awaitingAuthoritativeSync) {
    return "현재 판을 서버와 동기화하고 있어요.";
  }
  return null;
}

export function isRoomProjectionInputEnabled(
  connection: TransportConnectionState,
  lastError: BrowserTransportState["lastError"],
  awaitingAuthoritativeSync: boolean,
): boolean {
  return connection === "connected" && lastError !== "CONNECTION" && !awaitingAuthoritativeSync;
}

export function shouldRetryConnectionSync(
  connection: TransportConnectionState,
  lastError: BrowserTransportState["lastError"],
  alreadyAttempted: boolean,
): boolean {
  return connection === "connected" && lastError === "CONNECTION" && !alreadyAttempted;
}

export async function syncRoomAndActiveMatch(
  transport: Pick<ReturnType<typeof useAppState>["transport"], "syncRoom" | "syncMatch">,
  roomId: string,
): Promise<void> {
  const roomSync = await transport.syncRoom(roomId);
  if (roomSync.room.activeMatchId) await transport.syncMatch(roomSync.room.activeMatchId);
}

export function RoomConnectionNotice({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <aside className="placeholder-note" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </aside>
  );
}

export function RoomProjectionFrame({
  message,
  inputEnabled,
  children,
}: {
  message: string | null;
  inputEnabled: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <RoomConnectionNotice message={message} />
      <fieldset
        className="room-projection-input"
        disabled={!inputEnabled}
        aria-disabled={!inputEnabled}
        aria-label={inputEnabled ? "방 화면 입력" : "서버 동기화 후 방 화면 입력 가능"}
        style={{ border: 0, margin: 0, minWidth: 0, padding: 0, width: "100%" }}
      >
        {children}
      </fieldset>
    </>
  );
}

const inMemoryRoleConfirmations = new Set<string>();

export const roleDescriptions: Readonly<Record<string, string>> = Object.freeze({
  sheriff: "보안관은 무법자와 배신자를 모두 제거하면 승리.",
  deputy: "부관은 보안관을 돕고 같은 진영으로 승리.",
  outlaw: "무법자는 보안관을 제거하면 승리.",
  renegade: "배신자는 자신만 살아남아야 승리.",
});

/** Presentation copy transcribed from 01_RULES.md C01–C16. It never drives game logic. */
export const characterDescriptions: Readonly<Record<string, string>> = Object.freeze({
  bart_cassidy: "생존한 채 잃은 HP당 덱1장. 치명상일 때 이 능력으로 먼저 Beer를 찾아 구제할 수 없음. Dynamite 생존이면3장",
  black_jack: "뽑기 단계 두 번째 카드를 공개, Heart/Diamond이면 추가1장(추가 카드는 비공개). Draw!가 아님",
  calamity_janet: "BANG을 Missed로, Missed를 BANG으로 사용/대응 가능. 공격 변환이면 BANG quota 적용. Duel/Indians도 변환 BANG 허용",
  el_gringo: "다른 플레이어가 사용한 카드로 HP를 잃고 생존하면 HP당 그 사용자 손패 무작위1장. 상대 손패 없으면 없음. Dynamite 없음, 자신이 연 Duel에서 자신이 지면 없음",
  jesse_jones: "뽑기 단계 첫1장을 덱 대신 다른 생존자 손패에서 무작위로 가져올 수 있음. 두 번째는 덱",
  jourdonnais: "가상 Barrel 능력. 실제 Barrel도 있으면 각각1회 판정 가능",
  kit_carlson: "뽑기 단계 덱3장을 혼자 보고2장 획득, 나머지1장을 덱 맨 위로 비공개 반환",
  lucky_duke: "Draw!마다 2장 공개→원하는1장으로 판정→둘 다 버림. 일반 뽑기/Black Jack에는 적용 안 됨",
  paul_regret: "상대가 보는 자기 거리+1; Mustang과 누적",
  pedro_ramirez: "뽑기 단계 첫1장을 버림더미 top으로 대체 가능. 두 번째 덱. 버림더미 비었으면 대체 불가",
  rose_doolan: "자기가 보는 상대 거리−1, Scope와 누적, 최소1",
  sid_ketchum: "손패 정확히2장 버려 HP+1, 반복 가능, 최대HP까지. 자기 사용 단계 또는 치명상 구제. 다른 카드 해결 중 임의 끼어들기는 불가. 2명에서도 능력 회복 유효라는 제품 해석은 D02 참고",
  slab_the_killer: "자기 BANG 카드 공격만 Missed2개 필요. Barrel 성공1개 인정. Gatling 강화 안 됨",
  suzy_lafayette: "손패가 0이면 덱1장. 자신이 사용한 카드의 효과 해결을 먼저 마친 뒤 빈 손패를 확인하므로 마지막 Stagecoach/Wells Fargo/General Store로 카드를 얻었다면 능력 추가 뽑기 없음. Duel은 종료까지 기다림. Slab 대응 마지막 Missed 후에는 즉시 뽑고 새 Missed로 두 번째 대응 가능",
  vulture_sam: "타인 탈락시 그 손패+장착 전부 자기 손패로 회수. 자동 장착 아님. 폭발한 Dynamite는 이미 버려져 제외",
  willy_the_kid: "자기 턴 BANG 무제한. 사거리/대상 제한은 그대로",
});

export function hasRoleRevealConfirmation(matchId: string): boolean {
  try {
    return typeof window !== "undefined" && window.sessionStorage.getItem(`bang:role-confirmed:${matchId}`) === "yes";
  } catch {
    return inMemoryRoleConfirmations.has(matchId);
  }
}

export function rememberRoleRevealConfirmation(matchId: string): void {
  try {
    if (typeof window !== "undefined") window.sessionStorage.setItem(`bang:role-confirmed:${matchId}`, "yes");
  } catch {
    // The in-memory tab marker still allows this confirmation navigation.
    inMemoryRoleConfirmations.add(matchId);
  }
}

export function roomScreenForRoute(
  surface: RoomSurface,
  requestedKind: AppRoute["kind"],
  snapshot: MatchSnapshotView | undefined,
  roleConfirmed: boolean,
): RoomScreen {
  const hasPrivateRole = snapshot?.viewer.mode === "active" && snapshot.selfPrivate !== null;
  if (surface.kind === "game" && hasPrivateRole &&
      (requestedKind === "role-reveal" || !roleConfirmed)) return "role-reveal";
  return surface.kind;
}

function canonicalRoomSegment(visibleSurface: RoomScreen): string {
  return visibleSurface === "role-reveal" ? "role" : visibleSurface;
}

export function canonicalRoomPath(roomId: string, visibleSurface: RoomScreen): string {
  const roomPath = `/rooms/${encodeURIComponent(roomId)}`;
  if (visibleSurface === "lobby") return roomPath;

  return `${roomPath}/${canonicalRoomSegment(visibleSurface)}`;
}

export function RoutePage({ route }: { route: AppRoute }) {
  if (route.kind === "home") return <HomePage />;
  if (route.kind === "not-found") return <NotFoundPage pathname={route.pathname} />;
  if (route.kind === "room-create" || route.kind === "room-join") {
    return <RoomEntryPage initialMode={route.kind === "room-create" ? "create" : "join"} />;
  }
  return <RoomRoutePage route={route} />;
}

function RoomEntryPage({ initialMode }: { initialMode: "create" | "join" }) {
  const {
    roomEntryTransport,
    rememberCreatedRoom,
    lastCreatedRoomId,
    clearCreatedRoom,
  } = useAppState();

  useEffect(() => {
    clearCreatedRoom();
  }, [clearCreatedRoom]);

  return (
    <>
      <RoomEntry
        transport={roomEntryTransport}
        initialMode={initialMode}
        onRoomCreated={rememberCreatedRoom}
        onRoomReady={(room) => navigateTo(`/rooms/${encodeURIComponent(room.roomId)}`)}
      />
      {initialMode === "create" && lastCreatedRoomId ? (
        <section className="page-card room-entry-next" aria-label="대기실 이동">
          <p className="eyebrow">방 준비 완료</p>
          <h2>이제 대기실에서 참가자를 기다릴 수 있어요.</h2>
          <AppLink
            className="button button-primary"
            to={`/rooms/${encodeURIComponent(lastCreatedRoomId)}`}
            ariaLabel="만든 방 대기실 열기"
          >
            대기실 열기
          </AppLink>
        </section>
      ) : null}
    </>
  );
}

function RoomRoutePage({ route }: { route: Exclude<AppRoute, { kind: "home" | "not-found" | "room-create" | "room-join" }> }) {
  const {
    transport,
    transportState,
    sessionRecovery,
    retrySessionRecovery,
    inviteCodeForRoom,
  } = useAppState();
  const roomId = route.roomId;
  const roomProjection = transportState.rooms[roomId];
  const room = roomProjection?.room;
  const matchId = room?.activeMatchId ?? null;
  const matchProjection = matchId ? transportState.matches[matchId] : undefined;
  const surface = room ? roomSurface(room, matchProjection) : null;
  const [awaitingAuthoritativeSync, setAwaitingAuthoritativeSync] = useState(true);
  const [connectionWasLost, setConnectionWasLost] = useState(false);
  const [connectionErrorSyncRecovered, setConnectionErrorSyncRecovered] = useState(false);
  const connectionErrorSyncAttempted = useRef(false);
  const connectionErrorSyncInFlight = useRef(false);
  const currentRoomId = useRef(roomId);
  const isMounted = useRef(true);
  currentRoomId.current = roomId;
  const connectionErrorWasAcknowledged = transportState.lastError === "CONNECTION" &&
    connectionErrorSyncRecovered && connectionErrorSyncAttempted.current;
  const routeLastError = connectionErrorWasAcknowledged ? null : transportState.lastError;
  const connectionMessage = roomConnectionStatusMessage(
    transportState.connection,
    routeLastError,
    awaitingAuthoritativeSync,
    connectionWasLost,
  );
  const inputEnabled = isRoomProjectionInputEnabled(
    transportState.connection,
    routeLastError,
    awaitingAuthoritativeSync,
  );

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  useEffect(() => {
    if (transportState.connection !== "connected") {
      setAwaitingAuthoritativeSync(true);
      setConnectionErrorSyncRecovered(false);
      if (transportState.connection === "disconnected") setConnectionWasLost(true);
      return;
    }
    if (sessionRecovery.kind !== "ready" || !sessionRecovery.guest) return;

    let active = true;
    void syncRoomAndActiveMatch(transport, roomId).then(() => {
      if (!active) return;
      setAwaitingAuthoritativeSync(false);
      setConnectionWasLost(false);
      setConnectionErrorSyncRecovered(false);
    }).catch(() => {
      // Keep the cached server projection visible and input locked until a sync succeeds.
    });
    return () => { active = false; };
  }, [roomId, sessionRecovery, transport, transportState.connection]);

  useEffect(() => {
    if (transportState.lastError !== "CONNECTION") {
      if (!connectionErrorSyncInFlight.current) {
        connectionErrorSyncAttempted.current = false;
        setConnectionErrorSyncRecovered(false);
      }
      return;
    }

    setAwaitingAuthoritativeSync(true);
    setConnectionWasLost(true);
    setConnectionErrorSyncRecovered(false);
    if (sessionRecovery.kind !== "ready" || !sessionRecovery.guest ||
        !shouldRetryConnectionSync(
          transportState.connection,
          transportState.lastError,
          connectionErrorSyncAttempted.current,
        ) || connectionErrorSyncInFlight.current) return;

    connectionErrorSyncAttempted.current = true;
    connectionErrorSyncInFlight.current = true;
    void syncRoomAndActiveMatch(transport, roomId).then(() => {
      if (!isMounted.current || currentRoomId.current !== roomId ||
          transport.getSnapshot().connection !== "connected") return;
      setAwaitingAuthoritativeSync(false);
      setConnectionWasLost(false);
      setConnectionErrorSyncRecovered(true);
    }).catch(() => {
      // A failed retry remains locked; the attempt guard prevents an automatic retry loop.
    }).finally(() => {
      connectionErrorSyncInFlight.current = false;
      if (transport.getSnapshot().lastError !== "CONNECTION") {
        connectionErrorSyncAttempted.current = false;
      }
    });
  }, [roomId, sessionRecovery, transport, transportState.connection, transportState.lastError]);

  if (sessionRecovery.kind === "loading") {
    return <LoadingFrame message="게스트 세션과 참여 중인 방을 확인하고 있어요." />;
  }
  if (sessionRecovery.kind === "error") {
    return <SessionRecoveryError recovery={sessionRecovery} retry={retrySessionRecovery} />;
  }
  if (!sessionRecovery.guest) return <GuestRequiredPage />;
  if (transportState.connection === "expired") {
    return <SessionRecoveryError
      recovery={{ kind: "error", expired: true, message: "게스트 세션이 만료됐어요. 초대 코드로 다시 참가하거나 새 세션을 시작해 주세요." }}
      retry={retrySessionRecovery}
    />;
  }
  if (!room) {
    if (transportState.lastError === "SYNC_REJECTED") return <RoomUnavailablePage />;
    if (transportState.connection === "disconnected" || transportState.lastError === "CONNECTION") {
      return <>
        <RoomConnectionNotice message={connectionMessage} />
        <ErrorFrame message="방에 연결하지 못했어요. 네트워크를 확인한 뒤 다시 불러와 주세요." />
      </>;
    }
    return <>
      <RoomConnectionNotice message={connectionMessage} />
      <LoadingFrame message={transportState.connection === "connected"
        ? "방의 최신 서버 상태를 확인하고 있어요."
        : "보안 세션으로 서버에 연결하고 있어요."} />
    </>;
  }
  if (!surface) return <>
    <RoomConnectionNotice message={connectionMessage} />
    <LoadingFrame message="방 상태를 확인하고 있어요." />
  </>;

  if (surface.kind === "invalid") return <>
    <RoomConnectionNotice message={connectionMessage} />
    <ErrorFrame message={surface.message} />
  </>;
  if (surface.kind === "starting" || surface.kind === "syncing-match") {
    return <>
      <RoomConnectionNotice message={connectionMessage} />
      <LoadingFrame message={surface.kind === "starting"
        ? "서버가 매치를 준비하고 있어요."
        : "활성 매치의 비공개 서버 스냅샷을 동기화하고 있어요."} />
    </>;
  }
  if (surface.kind === "closed") return <>
    <RoomConnectionNotice message={connectionMessage} />
    <ClosedRoomPage />
  </>;

  const visibleSurface = roomScreenForRoute(
    surface,
    route.kind,
    matchProjection?.snapshot,
    surface.kind === "game" ? hasRoleRevealConfirmation(surface.matchId) : false,
  );

  const canonicalPath = canonicalRoomPath(roomId, visibleSurface);
  const requestedSegment = route.kind === "lobby" ? "lobby"
    : route.kind === "role-reveal" ? "role"
      : route.kind;
  const canonicalSegment = canonicalRoomSegment(visibleSurface);
  if (requestedSegment !== canonicalSegment && inputEnabled) {
    return <RouteRedirect to={canonicalPath} />;
  }

  if (surface.kind === "lobby") {
    return (
      <RoomProjectionFrame message={connectionMessage} inputEnabled={inputEnabled}>
        <Lobby
          room={room}
          roomVersion={roomProjection?.version ?? 0}
          inviteCode={inviteCodeForRoom(roomId)}
          onCommand={async (command) => {
            await transport.sendRoomCommand(command);
            await transport.syncRoom(roomId);
          }}
        />
      </RoomProjectionFrame>
    );
  }

  if (!matchProjection) return <>
    <RoomConnectionNotice message={connectionMessage} />
    <LoadingFrame message="매치 스냅샷을 불러오고 있어요." />
  </>;
  if (visibleSurface === "role-reveal") {
    return <RoomProjectionFrame message={connectionMessage} inputEnabled={inputEnabled}>
      <RoleRevealPage
        snapshot={matchProjection.snapshot}
        onContinue={() => {
          rememberRoleRevealConfirmation(surface.matchId);
          navigateTo(`/rooms/${encodeURIComponent(roomId)}/game`);
        }}
      />
    </RoomProjectionFrame>;
  }
  return <RoomProjectionFrame message={connectionMessage} inputEnabled={inputEnabled}>
    <MatchPage
      matchId={surface.matchId}
      version={matchProjection.version}
      snapshot={matchProjection.snapshot}
      visibleEvents={matchProjection.visibleEvents}
      room={room}
      roomVersion={roomProjection?.version ?? 0}
      transport={transport}
      showActions={visibleSurface === "game"}
    />
  </RoomProjectionFrame>;
}

export function RoleRevealPage({ snapshot, onContinue }: { snapshot: MatchSnapshotView; onContinue: () => void }) {
  const ownPlayer = snapshot.publicTable.players.find(({ playerId }) => playerId === snapshot.viewer.playerId);
  const role = snapshot.viewer.mode === "active" ? snapshot.selfPrivate?.role : undefined;

  if (!role || !ownPlayer) {
    return <ErrorFrame message="본인에게 배정된 비공개 역할 정보를 확인할 수 없어요." />;
  }

  return (
    <section className="page-card role-reveal-page" aria-labelledby="role-reveal-title">
      <p className="eyebrow">서버가 확인한 비공개 배정</p>
      <h1 id="role-reveal-title">역할과 인물을 확인해 주세요</h1>
      <p className="page-description">이 화면에는 현재 게스트에게 허용된 자기 역할과 인물 정보만 표시됩니다.</p>
      <div className="role-reveal-page__cards">
        <RoleCardFace roleId={role} description={roleDescriptions[role] ?? "역할 설명을 확인할 수 없습니다."} />
        <CharacterCardFace
          characterId={ownPlayer.characterId}
          description={characterDescriptions[ownPlayer.characterId] ?? "인물 설명을 확인할 수 없습니다."}
        />
      </div>
      <button className="button button-primary" type="button" onClick={onContinue}>
        확인하고 게임판으로
      </button>
    </section>
  );
}

function RouteRedirect({ to }: { to: string }) {
  useEffect(() => replaceTo(to), [to]);
  return <LoadingFrame message="현재 방 상태에 맞는 화면으로 이동하고 있어요." />;
}

export function MatchPage({
  matchId,
  version,
  snapshot,
  visibleEvents,
  room,
  roomVersion,
  transport,
  showActions,
}: {
  matchId: string;
  version: number;
  snapshot: MatchSnapshotView;
  visibleEvents: readonly PublicMatchEvent[];
  room: RoomView;
  roomVersion: number;
  transport: ReturnType<typeof useAppState>["transport"];
  showActions: boolean;
}) {
  const statusSync = { version, snapshot, visibleEvents };
  return (
    <div className="match-page">
      <GameTable snapshot={snapshot} />
      <StatusPanel
        sync={statusSync}
        room={room}
        roomVersion={roomVersion}
        matchId={matchId}
        transport={transport}
      />
      {showActions ? (
        <MatchInputGate status={snapshot.status}>
          <ActionsPanel matchId={matchId} version={version} snapshot={snapshot} transport={transport} />
          <ReactionPrompt matchId={matchId} version={version} snapshot={snapshot} transport={transport} />
        </MatchInputGate>
      ) : null}
    </div>
  );
}

function SessionRecoveryError({ recovery, retry }: { recovery: Extract<SessionRecovery, { kind: "error" }>; retry: () => Promise<void> }) {
  return (
    <section className="state-frame" role="alert">
      <span className="state-icon state-icon-error" aria-hidden="true">!</span>
      <h1>{recovery.expired ? "세션이 만료됐어요" : "세션을 복구하지 못했어요"}</h1>
      <p>{recovery.message}</p>
      <div className="state-actions">
        <button className="button button-primary" onClick={() => void retry()}>다시 확인</button>
        <AppLink className="button button-secondary" to="/rooms/join">초대 코드로 참가</AppLink>
        <AppLink className="button button-secondary" to="/rooms/new">새 세션 시작</AppLink>
      </div>
    </section>
  );
}

function GuestRequiredPage() {
  return (
    <section className="state-frame" role="status">
      <span className="state-icon" aria-hidden="true">?</span>
      <h1>게스트 세션이 필요해요</h1>
      <p>이 방은 브라우저의 참여 좌석으로 동기화할 수 없어요. 새 세션을 만들거나 초대 코드로 참가해 주세요.</p>
      <div className="state-actions">
        <AppLink className="button button-primary" to="/rooms/join">초대 코드로 참가</AppLink>
        <AppLink className="button button-secondary" to="/rooms/new">새 세션 시작</AppLink>
      </div>
    </section>
  );
}

function RoomUnavailablePage() {
  return (
    <section className="state-frame" role="alert">
      <span className="state-icon state-icon-error" aria-hidden="true">!</span>
      <h1>방을 불러올 수 없어요</h1>
      <p>이 브라우저의 참여 좌석을 확인할 수 없거나 방이 더 이상 열려 있지 않아요.</p>
      <div className="state-actions">
        <AppLink className="button button-primary" to="/rooms/join">초대 코드로 참가</AppLink>
        <AppLink className="button button-secondary" to="/">첫 화면으로</AppLink>
      </div>
    </section>
  );
}

function ClosedRoomPage() {
  return (
    <section className="state-frame" role="status">
      <span className="state-icon" aria-hidden="true">✓</span>
      <h1>닫힌 방이에요</h1>
      <p>이 방은 더 이상 입장하거나 게임을 진행할 수 없어요.</p>
      <AppLink className="button button-primary" to="/">첫 화면으로</AppLink>
    </section>
  );
}

function HomePage() {
  return (
    <section className="home-card" aria-labelledby="page-title">
      <div className="home-copy">
        <p className="eyebrow">기본판 · 4–7명</p>
        <h1 id="page-title">친구들과 시작하는 뱅!</h1>
        <p className="page-description">
          초대 링크로 모여 역할을 숨기고, 서버가 판정하는 한 판을 함께 즐겨 보세요.
        </p>
        <div className="home-actions">
          <AppLink className="button button-primary" to="/rooms/new">새 방 만들기</AppLink>
          <AppLink className="button button-secondary" to="/rooms/join">초대 링크로 참가</AppLink>
        </div>
      </div>
      <div className="table-art" aria-hidden="true">
        <div className="table-ring">
          <span className="table-seat seat-top" />
          <span className="table-seat seat-right" />
          <span className="table-seat seat-bottom" />
          <span className="table-seat seat-left" />
          <span className="table-center">BANG!</span>
        </div>
        <span className="art-star art-star-one">✦</span>
        <span className="art-star art-star-two">✦</span>
      </div>
    </section>
  );
}

function NotFoundPage({ pathname }: { pathname: string }) {
  return (
    <section className="page-card not-found-card" aria-labelledby="page-title">
      <span className="state-icon" aria-hidden="true">?</span>
      <p className="eyebrow">주소 확인</p>
      <h1 id="page-title">페이지를 찾을 수 없어요</h1>
      <p className="page-description">
        <code>{pathname}</code>에 해당하는 화면이 없습니다. 주소를 확인하거나 첫 화면으로 이동해 주세요.
      </p>
      <AppLink className="button button-primary" to="/">첫 화면으로 이동</AppLink>
    </section>
  );
}
