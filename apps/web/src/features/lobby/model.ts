import { PROTOCOL_VERSION, type RoomCommand, type RoomStatus, type RoomView } from "../../../../../packages/contracts/src/protocol.js";

export type LobbyRoomCommand = Extract<
  RoomCommand,
  { type: "SET_READY" | "START_MATCH" | "KICK_MEMBER" }
>;

export type LobbyMember = RoomView["members"][number];

export interface LobbySeatViewModel {
  seatIndex: number;
  seatNumber: number;
  member: LobbyMember | null;
  isOwner: boolean;
  isViewer: boolean;
  canKick: boolean;
}

export interface RoomLobbyViewModel {
  roomId: string;
  status: RoomStatus;
  statusLabel: string;
  statusMessage: string;
  occupancy: number;
  capacity: RoomView["capacity"];
  seats: readonly LobbySeatViewModel[];
  viewerIsOwner: boolean;
  canStart: boolean;
  startBlockedReason: string | null;
  canInvite: boolean;
  inviteMessage: string;
}

const statusLabels: Record<RoomStatus, string> = {
  waiting: "대기 중",
  starting: "게임 시작 준비 중",
  in_game: "게임 진행 중",
  paused: "일시 정지",
  completed: "게임 종료",
  closed: "방 닫힘",
};

function isTrustedOwner(room: RoomView): boolean {
  return room.viewer.isOwner && room.viewer.playerId === room.ownerPlayerId;
}

function statusLockMessage(status: RoomStatus): string {
  switch (status) {
    case "starting":
      return "게임을 준비 중이에요. 새 참가와 좌석 변경은 잠겨 있어요.";
    case "in_game":
      return "게임이 시작되어 새 참가와 강퇴를 할 수 없어요.";
    case "paused":
      return "방이 일시 정지되어 있어요. 새 참가와 좌석 변경은 잠겨 있어요.";
    case "completed":
      return "게임이 끝나 대기실 명령을 사용할 수 없어요.";
    case "closed":
      return "방이 닫혀 입장하거나 게임을 시작할 수 없어요.";
    case "waiting":
      return "";
  }
}

function startReason(room: RoomView, occupancy: number, viewerMemberExists: boolean): string | null {
  if (room.status !== "waiting") return statusLockMessage(room.status);
  if (!isTrustedOwner(room)) return "게임 시작은 방장만 할 수 있어요.";
  if (!viewerMemberExists) return "이 방에서 내 게스트 좌석을 확인할 수 없어요.";
  if (occupancy < 4) return `게임을 시작하려면 최소 4명이 필요해요. 현재 ${occupancy}명입니다.`;
  return null;
}

export function buildRoomLobbyViewModel(room: RoomView): RoomLobbyViewModel {
  const members = [...room.members].sort((left, right) => left.seatIndex - right.seatIndex);
  const viewerMatches = members.filter((member) => member.playerId === room.viewer.playerId);
  const viewerMember = viewerMatches.length === 1 ? viewerMatches[0] : undefined;
  const viewerMemberExists = viewerMember !== undefined;
  const viewerIsOwner = isTrustedOwner(room) && viewerMemberExists;
  const occupancy = members.length;
  const bySeat = new Map(members.map((member) => [member.seatIndex, member]));
  const seats = Array.from({ length: room.capacity }, (_, seatIndex) => {
    const member = bySeat.get(seatIndex) ?? null;
    return {
      seatIndex,
      seatNumber: seatIndex + 1,
      member,
      isOwner: member?.playerId === room.ownerPlayerId,
      isViewer: member?.playerId === room.viewer.playerId,
      canKick: room.status === "waiting" && isTrustedOwner(room) && member !== null &&
        member.playerId !== room.viewer.playerId,
    };
  });
  const blockedReason = startReason(room, occupancy, viewerMemberExists);
  const canInvite = room.status === "waiting" && occupancy < room.capacity;

  let inviteMessage: string;
  if (room.status !== "waiting") {
    inviteMessage = statusLockMessage(room.status);
  } else if (!canInvite) {
    inviteMessage = "방 정원이 찼어요. 추가 참가를 받을 수 없어요.";
  } else {
    inviteMessage = `초대 링크로 ${room.capacity}명까지 참가할 수 있어요.`;
  }

  let statusMessage: string;
  if (room.status !== "waiting") {
    statusMessage = statusLockMessage(room.status);
  } else if (occupancy >= room.capacity) {
    statusMessage = `현재 ${occupancy}/${room.capacity}명 · 방 정원이 찼어요.`;
  } else if (occupancy < 4) {
    statusMessage = `현재 ${occupancy}/${room.capacity}명 · 최소 4명이 모이면 시작할 수 있어요.`;
  } else {
    statusMessage = `현재 ${occupancy}/${room.capacity}명 · 방장이 게임을 시작할 수 있어요.`;
  }

  return {
    roomId: room.roomId,
    status: room.status,
    statusLabel: statusLabels[room.status],
    statusMessage,
    occupancy,
    capacity: room.capacity,
    seats,
    viewerIsOwner,
    canStart: blockedReason === null,
    startBlockedReason: blockedReason,
    canInvite,
    inviteMessage,
  };
}

/** Legacy protocol helper; the lobby has no manual readiness action. */
export function makeSetReadyCommand(
  roomId: string,
  expectedVersion: number,
  ready: boolean,
  commandId: string,
): Extract<RoomCommand, { type: "SET_READY" }> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    commandId,
    expectedVersion,
    type: "SET_READY",
    roomId,
    payload: { ready },
  };
}

export function makeStartMatchCommand(
  roomId: string,
  expectedVersion: number,
  commandId: string,
): Extract<RoomCommand, { type: "START_MATCH" }> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    commandId,
    expectedVersion,
    type: "START_MATCH",
    roomId,
    payload: {},
  };
}

export function makeKickMemberCommand(
  roomId: string,
  expectedVersion: number,
  targetPlayerId: string,
  commandId: string,
): Extract<RoomCommand, { type: "KICK_MEMBER" }> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    commandId,
    expectedVersion,
    type: "KICK_MEMBER",
    roomId,
    payload: { targetPlayerId },
  };
}
