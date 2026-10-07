import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { NicknameEditor } from "../src/features/profile/NicknameSettings.js";
import { GameExperience } from "../src/features/experience/GameExperience.js";
import { GameScene } from "../src/features/game-scene/GameScene.js";
import type { MatchSnapshotView, PublicMatchEvent, RoomView } from "../../../packages/contracts/src/protocol.js";
import type { GameSceneProps } from "../src/features/game-scene/GameScene.js";
import "../src/app/tokens.css";
import "../src/app/app.css";

const initial: MatchSnapshotView = { status: "playing", viewer: { playerId: "a", seatIndex: 0, mode: "active" },
  publicTable: { players: ["a", "b", "c", "d"].map((playerId,seatIndex) => ({ playerId, seatIndex, displayName: ["테스트", "보안관", "부관", "배신자"][seatIndex]!,
    characterId: ["bart_cassidy", "black_jack", "rose_doolan", "vulture_sam"][seatIndex]!, hp: 4, maxHp: 4, handCount: 4, eliminated: false,
    role: seatIndex === 1 ? "sheriff" as const : null, inPlay: [] })), turn: { currentPlayerId: "b", phase: "play" }, deckCount: 40,
    publicDiscard: { topCard: null, count: 0 } }, selfPrivate: { role: "outlaw", hand: [
      {cardInstanceId:"fixture-1",typeId:"bang",rank:"A",suit:"SPADES"},
      {cardInstanceId:"fixture-2",typeId:"missed",rank:"5",suit:"CLUBS"},
      {cardInstanceId:"fixture-3",typeId:"beer",rank:"6",suit:"HEARTS"},
      {cardInstanceId:"fixture-4",typeId:"dynamite",rank:"2",suit:"SPADES"},
    ] }, pendingInteraction: null };
const room: RoomView = { roomId: "effects-room", version: 1, status: "in_game", activeMatchId: "effects-match", ownerPlayerId: "a", capacity: 4,
  rulesetVersion: "base4-ko-online-1.0", members: initial.publicTable.players.map(p => ({ playerId:p.playerId,seatIndex:p.seatIndex,displayName:p.displayName,ready:true })), viewer: { playerId:"a",isOwner:true } };
const transport = { sendRoomCommand: async()=>{}, syncRoom: async()=>{throw new Error("Unused");}, sendMatchCommand: async()=>{throw new Error("Unused");},
  syncMatch:async()=>{throw new Error("Unused");} } as GameSceneProps["transport"];
function Fixture() {
  const [snapshot,setSnapshot] = useState(initial), [version,setVersion] = useState(1), [events,setEvents] = useState<PublicMatchEvent[]>([]);
  const seq=useRef(0);
  function effect(type:string) {
    setEvents(current=>[...current,{ eventSeq: ++seq.current, occurredAt:new Date().toISOString(),type,
      payload:{actorPlayerId:"a",targetPlayerId:"b",targetZone:"hand",fromZone:"hand",damage:3} }]); setVersion(v=>v+1);
  }
  return <><style>{`.fixture-tools button { min-height:44px; padding:8px 12px; } .fixture-tools output { color:#fff; }`}</style><div className="fixture-tools" style={{position:"fixed",left:16,top:72,zIndex:95,display:"flex",gap:8,alignItems:"end",flexWrap:"wrap",maxWidth:"calc(100vw - 32px)",padding:8,background:"#142d24"}}>
    <NicknameEditor displayName={snapshot.publicTable.players[0]!.displayName} onSave={async name=>{
      setSnapshot(current=>({...current,publicTable:{...current.publicTable,players:current.publicTable.players.map(p=>p.playerId==="a"?{...p,displayName:name}:p)}}));setVersion(v=>v+1);
    }}/><button onClick={()=>effect("DYNAMITE_EXPLODED")}>폭발 검증</button><button onClick={()=>effect("PUBLIC_CARD_TAKEN")}>탈취 검증</button><button onClick={()=>effect("PUBLIC_CARD_DISCARDED")}>강제 버림 검증</button><output>이벤트 {events.length} · 버전 {version}</output>
  </div><GameExperience scene version={version} snapshot={snapshot} visibleEvents={events}>
    <GameScene matchId="effects-match" version={version} snapshot={snapshot} visibleEvents={events} room={room} roomVersion={1} transport={transport} showActions/>
  </GameExperience></>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<Fixture/>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
