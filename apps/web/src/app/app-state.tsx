import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { GuestSessionResponse, RoomView } from "../../../../packages/contracts/src/protocol.js";
import { BrowserTransportError } from "../transport/errors.js";
import { createSitesGameTransport } from "../transport/sites-client.js";
import type { GameTransport } from "../transport/types.js";
import { useBrowserTransportState } from "../transport/use-transport.js";
import type { BrowserTransportState } from "../transport/types.js";
import type { RoomEntryCreateResult, RoomEntryTransport } from "../features/room-entry/model.js";
import { navigateTo } from "./router.js";
import { registerBangWebMcpTools, type BangWebMcpRuntime, type WebMcpDocument } from "./webmcp.js";

export type AppStatus =
  | { kind: "ready" }
  | { kind: "loading"; message?: string }
  | { kind: "error"; message: string };

export type SessionRecovery =
  | { kind: "loading" }
  | { kind: "ready"; guest: GuestSessionResponse | null; assignedRooms: readonly RoomView[] }
  | { kind: "error"; message: string; expired: boolean };

interface AppStateValue {
  status: AppStatus;
  setStatus: (status: AppStatus) => void;
  transport: GameTransport;
  transportState: BrowserTransportState;
  roomEntryTransport: RoomEntryTransport;
  sessionRecovery: SessionRecovery;
  retrySessionRecovery: () => Promise<void>;
  rememberCreatedRoom: (result: RoomEntryCreateResult) => void;
  lastCreatedRoomId: string | null;
  clearCreatedRoom: () => void;
  inviteCodeForRoom: (roomId: string) => string | null;
}

const AppStateContext = createContext<AppStateValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  // Sites creates its HTTP/SSE adapter synchronously. Local Vite loads the
  // Socket.IO module only in development, keeping it out of the Site bundle.
  const [transport, setTransport] = useState<GameTransport | null>(() =>
    import.meta.env.PROD ? createSitesGameTransport() : null);
  const [transportLoadFailed, setTransportLoadFailed] = useState(false);

  useEffect(() => {
    if (import.meta.env.PROD) return;
    let cancelled = false;
    void import("../transport/client.js")
      .then(({ createBrowserGameTransport }) => {
        if (!cancelled) setTransport(createBrowserGameTransport());
      })
      .catch(() => {
        if (!cancelled) setTransportLoadFailed(true);
      });
    return () => { cancelled = true; };
  }, []);

  if (!transport) {
    return (
      <div role={transportLoadFailed ? "alert" : "status"}>
        {transportLoadFailed ? "게임을 불러오지 못했어요. 새로고침해 주세요." : "게임을 준비하고 있어요."}
      </div>
    );
  }

  return <ReadyAppStateProvider transport={transport}>{children}</ReadyAppStateProvider>;
}

function ReadyAppStateProvider({ children, transport }: { children: ReactNode; transport: GameTransport }) {
  const transportState = useBrowserTransportState(transport);
  const [status, setStatus] = useState<AppStatus>({ kind: "ready" });
  const [sessionRecovery, setSessionRecovery] = useState<SessionRecovery>({ kind: "loading" });
  const [lastCreatedRoomId, setLastCreatedRoomId] = useState<string | null>(null);
  const [roomInviteCodes, setRoomInviteCodes] = useState<Readonly<Record<string, string>>>({});
  const roomWatchers = useRef<(() => void)[]>([]);

  const replaceAssignedRoomWatches = useCallback((rooms: readonly RoomView[]) => {
    roomWatchers.current.forEach((stop) => stop());
    roomWatchers.current = rooms.map((room) => transport.watchRoom(room.roomId));
  }, [transport]);

  const retrySessionRecovery = useCallback(async () => {
    setSessionRecovery({ kind: "loading" });
    try {
      const guest = await transport.restoreGuestSession();
      if (!guest) {
        replaceAssignedRoomWatches([]);
        setSessionRecovery({ kind: "ready", guest: null, assignedRooms: [] });
        return;
      }

      const assignedRooms = await transport.recoverAssignedSeats();
      replaceAssignedRoomWatches(assignedRooms);
      await waitForTransportConnection(transport);
      setSessionRecovery({ kind: "ready", guest, assignedRooms });
    } catch (error) {
      const expired = error instanceof BrowserTransportError && error.code === "SESSION_EXPIRED";
      replaceAssignedRoomWatches([]);
      setSessionRecovery({
        kind: "error",
        expired,
        message: expired
          ? "접속 정보가 만료됐어요. 이름을 입력한 뒤 초대 코드로 다시 참가해 주세요."
          : "참가 중인 방을 불러오지 못했어요. 연결을 확인하고 다시 시도해 주세요.",
      });
    }
  }, [replaceAssignedRoomWatches, transport]);

  useEffect(() => {
    void retrySessionRecovery();
    return () => {
      roomWatchers.current.forEach((stop) => stop());
      roomWatchers.current = [];
      transport.disconnect();
    };
  }, [retrySessionRecovery, transport]);

  useEffect(() => {
    if (transportState.connection !== "expired") return;
    setSessionRecovery((current) => ({
      kind: "error",
      expired: true,
      message: "접속 정보가 만료됐어요. 이름을 입력한 뒤 초대 코드로 다시 참가해 주세요.",
    }));
  }, [transportState.connection]);

  const adoptGuestSession = useCallback(async (guest: GuestSessionResponse) => {
    // A newly issued identity has no assigned seats. Existing identities use
    // retrySessionRecovery, which performs the authenticated recovery query.
    const assignedRooms: readonly RoomView[] = [];
    replaceAssignedRoomWatches(assignedRooms);
    setSessionRecovery({ kind: "ready", guest, assignedRooms });
  }, [replaceAssignedRoomWatches]);

  const roomEntryTransport = useState<RoomEntryTransport>(() => ({
    restoreGuestSession: () => transport.restoreGuestSession(),
    recoverAssignedSeats: () => transport.recoverAssignedSeats(),
    createGuestSession: async (request) => {
      const guest = await transport.createGuestSession(request);
      await adoptGuestSession(guest);
      return guest;
    },
    createRoom: async (command) => {
      await waitForTransportConnection(transport);
      return transport.createRoom(command);
    },
    previewInvite: async (inviteCode) => {
      await waitForTransportConnection(transport);
      return transport.previewInvite(inviteCode);
    },
    joinRoom: async (command) => {
      await waitForTransportConnection(transport);
      return transport.joinRoom(command);
    },
  }))[0];

  const rememberCreatedRoom = useCallback((result: RoomEntryCreateResult) => {
    setLastCreatedRoomId(result.roomId);
    if (result.inviteCode) {
      setRoomInviteCodes((current) => ({ ...current, [result.roomId]: result.inviteCode! }));
    }
  }, []);

  const clearCreatedRoom = useCallback(() => setLastCreatedRoomId(null), []);
  const inviteCodeForRoom = useCallback((roomId: string) => roomInviteCodes[roomId] ?? null, [roomInviteCodes]);
  const webMcpState = useRef({ sessionRecovery, transportState, roomInviteCodes });
  webMcpState.current = { sessionRecovery, transportState, roomInviteCodes };
  const webMcpRuntime = useMemo<BangWebMcpRuntime>(() => ({
    transport,
    roomEntryTransport,
    getSessionRecovery: () => webMcpState.current.sessionRecovery,
    getTransportState: () => webMcpState.current.transportState,
    getInviteCode: (roomId) => webMcpState.current.roomInviteCodes[roomId] ?? null,
    rememberCreatedRoom,
    waitForConnection: () => waitForTransportConnection(transport),
    getLocation: () => ({ pathname: window.location.pathname, origin: window.location.origin }),
    navigate: navigateTo,
  }), [rememberCreatedRoom, roomEntryTransport, transport]);

  useEffect(() => {
    const controller = new AbortController();
    void registerBangWebMcpTools(document as unknown as WebMcpDocument, webMcpRuntime, controller.signal);
    return () => controller.abort();
  }, [webMcpRuntime]);

  return (
    <AppStateContext.Provider value={{
      status,
      setStatus,
      transport,
      transportState,
      roomEntryTransport,
      sessionRecovery,
      retrySessionRecovery,
      rememberCreatedRoom,
      lastCreatedRoomId,
      clearCreatedRoom,
      inviteCodeForRoom,
    }}>
      {children}
    </AppStateContext.Provider>
  );
}

export function useAppState(): AppStateValue {
  const state = useContext(AppStateContext);

  if (!state) {
    throw new Error("useAppState must be used inside AppStateProvider.");
  }

  return state;
}

/** Waits for the selected cookie-authenticated transport before commands. */
export function waitForTransportConnection(
  transport: GameTransport,
  timeoutMs = 10_000,
): Promise<void> {
  const current = transport.getSnapshot();
  const writesAvailable = (state: BrowserTransportState) => state.connection === "connected" ||
    (state.connection === "disconnected" && transport.writesAvailableWhileDisconnected === true);
  if (current.connection === "expired") {
    return Promise.reject(new BrowserTransportError("SESSION_EXPIRED", "접속 정보가 만료됐어요."));
  }
  if (writesAvailable(current)) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = () => {};
    const timer = window.setTimeout(() => finish(new Error("서버에 연결하지 못했어요. 연결을 확인하고 다시 시도해 주세요.")), timeoutMs);

    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      unsubscribe();
      if (error) reject(error);
      else resolve();
    }

    unsubscribe = transport.subscribe(() => {
      const state = transport.getSnapshot();
      if (writesAvailable(state)) finish();
      else if (state.connection === "expired") {
        finish(new BrowserTransportError("SESSION_EXPIRED", "게스트 세션이 만료됐어요."));
      }
    });

    transport.connect();
    const latest = transport.getSnapshot();
    if (writesAvailable(latest)) finish();
    else if (latest.connection === "expired") {
      finish(new BrowserTransportError("SESSION_EXPIRED", "게스트 세션이 만료됐어요."));
    }
  });
}
