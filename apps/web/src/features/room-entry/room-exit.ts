import type { RoomCommand, RoomSyncResponse, RoomView } from "../../../../../packages/contracts/src/protocol.js";
import { parseCommandAck } from "../../../../../packages/contracts/src/validation.js";

export type RoomExitAction = "LEAVE_ROOM" | "CLOSE_ROOM";
export interface RoomExitTransport {
  syncRoom(roomId: string): Promise<RoomSyncResponse>;
  sendRoomCommand(command: RoomCommand): Promise<unknown>;
}

export async function exitRoom(transport: RoomExitTransport, roomId: string, action: RoomExitAction,
  newId: () => string = () => crypto.randomUUID()): Promise<void> {
  // The list can be hours old. Read current ownership and version before sending the mutation.
  for (let attempt = 0; attempt < 2; attempt++) {
    const latest = await transport.syncRoom(roomId);
    if (latest.room.status === "closed") throw new Error("이미 닫힌 방이에요. 방 목록을 새로 확인해 주세요.");
    if (action === "CLOSE_ROOM" && !latest.room.viewer.isOwner) throw new Error("방 삭제는 현재 방장만 할 수 있어요.");
    const command: RoomCommand = { protocolVersion: 1, commandId: newId(), expectedVersion: latest.version,
      roomId, type: action, payload: {} };
    const parsed = parseCommandAck(await transport.sendRoomCommand(command));
    if (!parsed.ok || parsed.value.commandId !== command.commandId) throw new Error("처리 결과를 확인하지 못했어요. 방 목록을 다시 확인해 주세요.");
    if (parsed.value.status === "accepted") return;
    if (parsed.value.error.code === "STALE_VERSION" && attempt === 0) continue;
    if (["NOT_ROOM_OWNER", "ROOM_FORBIDDEN"].includes(parsed.value.error.code)) throw new Error("방 삭제는 현재 방장만 할 수 있어요.");
    throw new Error("요청을 처리하지 못했어요. 방 목록을 새로 확인한 뒤 다시 시도해 주세요.");
  }
}

export function roomExitMessage(room: RoomView, action: RoomExitAction): string {
  if (action === "CLOSE_ROOM") return "참가자 모두가 내보내지고 초대 링크도 사용할 수 없게 됩니다. 진행 중인 게임도 더 이상 이어갈 수 없어요.";
  const playing = ["in_game", "starting", "paused"].includes(room.status);
  return [playing ? "진행 중인 게임에서는 탈락 처리됩니다. 다른 사람의 대응이 진행 중이면 그 효과를 마친 뒤 탈락이 확정돼요." : "내 좌석이 제거됩니다.",
    room.viewer.isOwner && room.members.length > 1 ? "방장은 먼저 입장한 남은 참가자에게 넘어갑니다." :
      room.members.length === 1 ? "마지막 참가자가 나가면 방이 닫힙니다." : "대기실에는 유효한 초대 링크로 다시 참가할 수 있어요."].join(" ");
}
