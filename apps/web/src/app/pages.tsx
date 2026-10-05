import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MatchSnapshotView, RoomView, PublicMatchEvent } from "../../../../packages/contracts/src/protocol.js";
import { ActionsPanel } from "../features/actions/ActionsPanel.js";
import { CharacterCardFace, RoleCardFace } from "../features/cards/CardFaces.js";
import { GameTable } from "../features/game-table/GameTable.js";
import { Lobby } from "../features/lobby/Lobby.js";
import { ReactionPrompt } from "../features/reactions/ReactionPrompt.js";
import { interactionLabel } from "../features/reactions/model.js";
import { MatchInputGate, StatusPanel } from "../features/status/StatusPanel.js";
import { RoomEntry } from "../features/room-entry/RoomEntry.js";
import type { BrowserTransportState, MatchProjectionState, TransportConnectionState } from "../transport/types.js";
import { AppLink, navigateTo, replaceTo, type AppRoute } from "./router.js";
import { useAppState, type SessionRecovery } from "./app-state.js";
import { ErrorFrame, LoadingFrame } from "./app-frames.js";
import { AppIcon } from "../components/AppIcon.js";

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
    return "연결이 끊겼어요. 다시 연결하면 게임을 이어갈 수 있어요.";
  }
  if (connection === "connecting" && awaitingAuthoritativeSync) {
    return "게임에 연결하고 있어요.";
  }
  if (connection === "connected" && awaitingAuthoritativeSync) {
    return "최신 게임 정보를 불러오고 있어요.";
  }
  return null;
}

export function isRoomProjectionInputEnabled(
  connection: TransportConnectionState,
  lastError: BrowserTransportState["lastError"],
  awaitingAuthoritativeSync: boolean,
  writesAvailableWhileDisconnected = false,
): boolean {
  const usableTransport = connection === "connected" ||
    (writesAvailableWhileDisconnected && connection === "disconnected");
  const connectionErrorAcknowledged = lastError !== "CONNECTION";
  return usableTransport && connectionErrorAcknowledged && !awaitingAuthoritativeSync;
}

export function shouldRetryConnectionSync(
  connection: TransportConnectionState,
  lastError: BrowserTransportState["lastError"],
  alreadyAttempted: boolean,
  writesAvailableWhileDisconnected = false,
): boolean {
  const usableTransport = connection === "connected" ||
    (writesAvailableWhileDisconnected && connection === "disconnected");
  return usableTransport && lastError === "CONNECTION" && !alreadyAttempted;
}

export async function syncRoomAndActiveMatch(
  transport: Pick<ReturnType<typeof useAppState>["transport"], "syncRoom" | "syncMatch">,
  roomId: string,
): Promise<void> {
  const roomSync = await transport.syncRoom(roomId);
  if (roomSync.room.activeMatchId) await transport.syncMatch(roomSync.room.activeMatchId);
}

function isVersionedRoomView(value: unknown, roomId: string): value is RoomView {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RoomView>;
  return candidate.roomId === roomId && typeof candidate.version === "number" &&
    Number.isSafeInteger(candidate.version) && Array.isArray(candidate.members);
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
        aria-label={inputEnabled ? "방 화면 입력" : "연결 확인 후 방 화면 입력 가능"}
        style={{ border: 0, margin: 0, minWidth: 0, padding: 0, width: "100%" }}
      >
        {children}
      </fieldset>
    </>
  );
}

const inMemoryRoleConfirmations = new Set<string>();

export const roleDescriptions: Readonly<Record<string, string>> = Object.freeze({
  sheriff: "승리 목표: 무법자와 배신자를 모두 제거하세요.",
  deputy: "승리 목표: 보안관을 도와 보안관 진영과 함께 승리하세요.",
  outlaw: "승리 목표: 보안관을 제거하세요.",
  renegade: "승리 목표: 마지막까지 혼자 살아남으세요.",
});

/** Presentation copy transcribed from 01_RULES.md C01–C16. It never drives game logic. */
export const characterDescriptions: Readonly<Record<string, string>> = Object.freeze({
  bart_cassidy: "능력: 피해를 입고 살아남으면 잃은 생명력 1당 카드 1장을 뽑아요.\n주의: 다이너마이트 피해를 받고 살아남으면 카드 3장을 뽑아요. 치명상 구제에 이 능력으로 맥주를 찾아 쓸 수는 없어요.",
  black_jack: "능력: 카드 뽑기 단계의 두 번째 카드를 공개해요. 하트나 다이아몬드라면 카드 1장을 더 비공개로 뽑아요.\n주의: 일반 판정(Draw!)에는 적용되지 않아요.",
  calamity_janet: "능력: 빗나감!을 뱅!처럼, 뱅!을 빗나감!처럼 낼 수 있어요.\n주의: 공격 카드로 바꾸어 내면 뱅! 사용 횟수 제한을 따라요. 결투와 인디언!에서도 바꾸어 낼 수 있어요.",
  el_gringo: "능력: 다른 플레이어가 사용한 카드로 피해를 입고 살아남으면, 잃은 생명력 1당 그 플레이어의 손패에서 카드 1장을 무작위로 가져와요.\n주의: 상대 손패가 없으면 가져오지 않아요. 다이너마이트와 자신이 시작한 결투에서 진 경우에는 발동하지 않아요.",
  jesse_jones: "능력: 카드 뽑기 단계의 첫 카드 1장을 덱 대신 다른 생존자의 손패에서 무작위로 가져올 수 있어요.\n그 단계의 두 번째 카드는 덱에서 뽑아요.",
  jourdonnais: "능력: 가상 술통이 있어요. 뱅! 또는 개틀링 공격을 받을 때 하트 판정으로 빗나감! 1개처럼 방어할 수 있어요.\n술통을 장착하고 있다면 두 번 따로 판정할 수 있어요.",
  kit_carlson: "능력: 카드 뽑기 단계에 덱 맨 위 3장을 혼자 보고 2장을 손패에 넣어요.\n남은 1장은 덱 맨 위에 비공개로 돌려놔요.",
  lucky_duke: "능력: 판정(Draw!)마다 카드 2장을 공개해요. 둘 중 원하는 카드로 판정한 뒤 두 장 모두 버려요.\n주의: 일반 카드 뽑기와 블랙 잭의 추가 뽑기에는 적용되지 않아요.",
  paul_regret: "능력: 다른 플레이어가 보는 나와의 거리가 1 늘어나요.\n머스탱 효과와 함께 적용돼요.",
  pedro_ramirez: "능력: 카드 뽑기 단계의 첫 카드 1장을 덱 대신 버림더미 맨 위에서 가져올 수 있어요.\n버림더미가 비어 있으면 덱에서 뽑아요. 두 번째 카드는 덱에서 뽑아요.",
  rose_doolan: "능력: 내가 보는 다른 플레이어와의 거리가 1 줄어요.\n조준경 효과와 함께 적용되며 거리는 1보다 작아지지 않아요.",
  sid_ketchum: "능력: 손패 2장을 버리고 생명력 1을 회복할 수 있어요. 최대 생명력까지 반복할 수 있어요.\n사용 시점: 내 카드 사용 단계 또는 생명력 구제 때예요. 다른 카드 효과가 해결되는 중에는 사용할 수 없어요.",
  slab_the_killer: "능력: 내가 뱅!으로 공격하면 상대는 빗나감! 2장이 필요해요.\n술통 판정에 성공하면 빗나감! 1장으로 인정해요. 개틀링 공격에는 이 능력이 적용되지 않아요.",
  suzy_lafayette: "능력: 손패가 비면 카드 1장을 뽑아요.\n시점: 내가 낸 카드의 효과가 모두 끝난 뒤 확인해요. 슬랩의 공격에 마지막 빗나감!을 내면 즉시 뽑고, 새로 뽑은 빗나감!으로 한 번 더 대응할 수 있어요.",
  vulture_sam: "능력: 다른 플레이어가 탈락하면 그 사람의 손패와 장착 카드를 모두 내 손패로 가져와요.\n가져온 카드는 자동으로 장착되지 않아요. 이미 버린 다이너마이트는 가져오지 않아요.",
  willy_the_kid: "능력: 내 차례에는 뱅!을 원하는 만큼 낼 수 있어요.\n각 공격의 거리와 대상 제한은 그대로예요.",
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
        onRoomCreated={(room) => {
          rememberCreatedRoom(room);
          navigateTo(`/rooms/${encodeURIComponent(room.roomId)}`);
        }}
        onRoomReady={(room) => navigateTo(`/rooms/${encodeURIComponent(room.roomId)}`)}
      />
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
  const writesAvailableWhileDisconnected = transport.writesAvailableWhileDisconnected === true;
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
  const authoritativeSyncGeneration = useRef(0);
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
    writesAvailableWhileDisconnected,
  );

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  useEffect(() => {
    const generation = ++authoritativeSyncGeneration.current;
    const canSync = transportState.connection === "connected" ||
      (writesAvailableWhileDisconnected && transportState.connection === "disconnected");
    if (!canSync) {
      setAwaitingAuthoritativeSync(true);
      setConnectionErrorSyncRecovered(false);
      if (transportState.connection === "disconnected") setConnectionWasLost(true);
      return;
    }
    if (sessionRecovery.kind !== "ready" || !sessionRecovery.guest) return;
    if (transportState.lastError === "CONNECTION") return;

    void syncRoomAndActiveMatch(transport, roomId).then(() => {
      if (!isMounted.current || currentRoomId.current !== roomId ||
          authoritativeSyncGeneration.current !== generation) return;
      setAwaitingAuthoritativeSync(false);
      const latest = transport.getSnapshot();
      if (latest.lastError === "CONNECTION") connectionErrorSyncAttempted.current = true;
      setConnectionWasLost(latest.connection === "disconnected" || latest.lastError === "CONNECTION");
      setConnectionErrorSyncRecovered(latest.lastError === "CONNECTION");
    }).catch(() => {
      // Keep the cached server projection visible and input locked until a sync succeeds.
    });
  }, [roomId, sessionRecovery, transport, transportState.connection, writesAvailableWhileDisconnected]);

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
          writesAvailableWhileDisconnected,
        ) || connectionErrorSyncInFlight.current) return;

    connectionErrorSyncAttempted.current = true;
    connectionErrorSyncInFlight.current = true;
    const generation = ++authoritativeSyncGeneration.current;
    void syncRoomAndActiveMatch(transport, roomId).then(() => {
      const latest = transport.getSnapshot();
      const transportUsable = latest.connection === "connected" ||
        (writesAvailableWhileDisconnected && latest.connection === "disconnected");
      if (!isMounted.current || currentRoomId.current !== roomId || !transportUsable) return;
      if (authoritativeSyncGeneration.current !== generation) return;
      setAwaitingAuthoritativeSync(false);
      setConnectionWasLost(latest.connection === "disconnected" || latest.lastError === "CONNECTION");
      setConnectionErrorSyncRecovered(true);
    }).catch(() => {
      // A failed retry remains locked; the attempt guard prevents an automatic retry loop.
    }).finally(() => {
      connectionErrorSyncInFlight.current = false;
      if (transport.getSnapshot().lastError !== "CONNECTION") {
        connectionErrorSyncAttempted.current = false;
      }
    });
  }, [roomId, sessionRecovery, transport, transportState.connection, transportState.lastError, writesAvailableWhileDisconnected]);

  if (sessionRecovery.kind === "loading") {
    return <LoadingFrame message="이 브라우저의 게임 참여 정보를 확인하고 있어요." />;
  }
  if (sessionRecovery.kind === "error") {
    return <SessionRecoveryError recovery={sessionRecovery} retry={retrySessionRecovery} />;
  }
  if (!sessionRecovery.guest) return <GuestRequiredPage />;
  if (transportState.connection === "expired") {
    return <SessionRecoveryError
      recovery={{ kind: "error", expired: true, message: "참여 정보가 만료됐어요. 초대 링크로 다시 참가하거나 새 방을 만들어 주세요." }}
      retry={retrySessionRecovery}
    />;
  }
  if (!room) {
    if (transportState.lastError === "SYNC_REJECTED") return <RoomUnavailablePage />;
    if ((transportState.connection === "disconnected" || transportState.lastError === "CONNECTION") &&
        !writesAvailableWhileDisconnected) {
      return <>
        <RoomConnectionNotice message={connectionMessage} />
        <ErrorFrame message="방에 연결하지 못했어요. 네트워크를 확인한 뒤 다시 불러와 주세요." />
      </>;
    }
    return <>
      <RoomConnectionNotice message={connectionMessage} />
      <LoadingFrame message={transportState.connection === "connected"
        ? "방 상태를 확인하고 있어요."
        : "방에 연결하고 있어요."} />
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
        ? "게임을 준비하고 있어요."
        : "현재 게임 정보를 불러오고 있어요."} />
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
          viewerConnectionState={transportState.connection}
          onCommand={async (command) => {
            const response = await transport.sendRoomCommand(command);
            if (!isVersionedRoomView(response, roomId)) await transport.syncRoom(roomId);
          }}
        />
      </RoomProjectionFrame>
    );
  }

  if (!matchProjection) return <>
    <RoomConnectionNotice message={connectionMessage} />
    <LoadingFrame message="현재 게임 정보를 불러오고 있어요." />
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
      <p className="eyebrow">내 역할과 인물</p>
      <h1 id="role-reveal-title">역할과 인물을 확인해 주세요</h1>
      <p className="page-description">내 역할의 승리 조건과 인물 능력을 확인한 뒤 게임을 시작하세요.</p>
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
  const completed = snapshot.status === "completed";
  return (
    <div className={`match-page${completed ? " match-page--result" : " match-page--playing"}`}>
      {!completed ? <MatchRequestBanner snapshot={snapshot} /> : null}
      {completed ? (
        <StatusPanel
          sync={statusSync}
          room={room}
          roomVersion={roomVersion}
          matchId={matchId}
          transport={transport}
        />
      ) : null}
      {showActions && !completed ? (
        <MatchInputGate status={snapshot.status}>
          <ReactionPrompt matchId={matchId} version={version} snapshot={snapshot} transport={transport} />
          <ActionsPanel matchId={matchId} version={version} snapshot={snapshot} transport={transport} />
        </MatchInputGate>
      ) : null}
      {completed ? (
        <details className="match-page__history">
          <summary>게임판과 진행 기록 보기</summary>
          <GameTable snapshot={snapshot} />
        </details>
      ) : (
        <>
          <GameTable snapshot={snapshot} />
          <StatusPanel
            sync={statusSync}
            room={room}
            roomVersion={roomVersion}
            matchId={matchId}
            transport={transport}
          />
        </>
      )}
    </div>
  );
}

const requestPhaseLabels: Readonly<Record<string, string>> = {
  start: "턴 시작",
  draw: "카드 뽑기",
  play: "카드 사용",
  discard: "손패 정리",
};

function MatchRequestBanner({ snapshot }: { snapshot: MatchSnapshotView }) {
  const turnOwner = snapshot.publicTable.players.find(
    (player) => player.playerId === snapshot.publicTable.turn.currentPlayerId,
  );
  const pending = snapshot.pendingInteraction;
  const responderId = pending && "currentResponderPlayerId" in pending
    ? pending.currentResponderPlayerId
    : null;
  const responder = responderId
    ? snapshot.publicTable.players.find((player) => player.playerId === responderId)
    : undefined;
  const myTurn = turnOwner?.playerId === snapshot.viewer.playerId;
  const myResponse = responderId === snapshot.viewer.playerId && pending !== null && pending !== undefined &&
    "responseOptions" in pending && pending.responseOptions.length > 0;
  const phase = requestPhaseLabels[snapshot.publicTable.turn.phase] ?? "진행 중";
  const request = pending ? interactionLabel(pending.kind) : null;
  const instruction = snapshot.status === "paused"
    ? "게임이 잠시 멈춰 있어요. 다시 진행되면 행동을 고를 수 있어요."
    : snapshot.status === "recovery_required"
      ? "게임 정보를 확인하고 있어요. 최신 상태를 기다려 주세요."
      : snapshot.viewer.mode !== "active"
        ? "탈락한 상태예요. 공개된 진행을 볼 수 있어요."
        : myTurn
          ? "내 차례예요. 아래에서 카드를 고를 수 있어요."
          : turnOwner ? `${turnOwner.displayName} 님 차례예요.` : "현재 차례를 확인하고 있어요.";
  const responseInstruction = snapshot.status === "paused"
    ? "게임이 잠시 멈춰 있어요. 다시 진행되면 응답할 수 있어요."
    : snapshot.status === "recovery_required"
      ? "게임 정보를 확인하고 있어요. 최신 상태를 기다려 주세요."
      : myResponse
        ? "내 응답 차례예요. 아래에서 선택해 주세요."
        : responder ? `${responder.displayName} 님이 응답 중이에요.` : "응답이 끝나면 다음 행동을 고를 수 있어요.";

  return (
    <section className="match-request" aria-label="현재 차례와 응답" role="status" aria-live="polite">
      <div className="match-request__turn">
        <span>차례</span>
        <strong>{turnOwner?.displayName ?? "확인 중"}</strong>
        <span>{phase}</span>
      </div>
      {pending ? (
        <div className="match-request__response">
          <span>{request}</span>
          <strong>{responder?.displayName ?? (responderId ? "응답자 확인 중" : "응답 처리 중")}</strong>
          {"step" in pending ? <span>{pending.step.current}/{pending.step.total}</span> : null}
          <p>{responseInstruction}</p>
        </div>
      ) : (
        <p className="match-request__instruction">{instruction}</p>
      )}
    </section>
  );
}

function SessionRecoveryError({ recovery, retry }: { recovery: Extract<SessionRecovery, { kind: "error" }>; retry: () => Promise<void> }) {
  return (
    <section className="state-frame" role="alert">
      <span className="state-icon state-icon-error" aria-hidden="true">!</span>
      <h1>{recovery.expired ? "참여 정보가 만료됐어요" : "참여 정보를 불러오지 못했어요"}</h1>
      <p>{recovery.message}</p>
      <div className="state-actions">
        <button className="button button-primary" onClick={() => void retry()}>다시 확인</button>
        <AppLink className="button button-secondary" to="/rooms/join">초대 링크로 참가</AppLink>
        <AppLink className="button button-secondary" to="/rooms/new">새 방 만들기</AppLink>
      </div>
    </section>
  );
}

function GuestRequiredPage() {
  return (
    <section className="state-frame" role="status">
      <span className="state-icon" aria-hidden="true">?</span>
      <h1>참여 정보가 필요해요</h1>
      <p>이 방에서 내 참여 정보를 찾을 수 없어요. 초대 링크로 다시 참가하거나 새 방을 만들어 주세요.</p>
      <div className="state-actions">
        <AppLink className="button button-primary" to="/rooms/join">초대 링크로 참가</AppLink>
        <AppLink className="button button-secondary" to="/rooms/new">새 방 만들기</AppLink>
      </div>
    </section>
  );
}

function RoomUnavailablePage() {
  return (
    <section className="state-frame" role="alert">
      <span className="state-icon state-icon-error" aria-hidden="true">!</span>
      <h1>방을 불러올 수 없어요</h1>
      <p>참가한 방을 찾을 수 없어요. 초대 링크를 확인하거나 첫 화면으로 돌아가 주세요.</p>
      <div className="state-actions">
        <AppLink className="button button-primary" to="/rooms/join">초대 링크로 참가</AppLink>
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
          초대 링크로 모여 역할을 숨기고 친구들과 전략을 겨뤄 보세요.
        </p>
        <div className="home-actions">
          <AppLink className="button button-primary" to="/rooms/new">새 방 만들기 <AppIcon name="arrow" /></AppLink>
          <AppLink className="button button-secondary" to="/rooms/join">초대 링크로 참가</AppLink>
        </div>
        <div className="home-meta">
          <span><AppIcon name="users" />4–7명</span>
          <span><AppIcon name="cards" />기본판</span>
          <span>계정 없이 시작</span>
        </div>
      </div>
      <div className="table-art" aria-hidden="true">
        <span className="table-art__wordmark">BANG!</span>
        <span className="table-art__caption">친구들과 함께하는 서부의 한 판</span>
        <div className="table-art__suits">♠ ♥ ♦ ♣</div>
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
