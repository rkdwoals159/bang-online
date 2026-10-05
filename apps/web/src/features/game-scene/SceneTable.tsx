import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { MatchSnapshotView, PublicPlayerView } from "../../../../../packages/contracts/src/protocol.js";
import { CharacterPortrait, PlayingCardZoomButton } from "../cards/CardFaces.js";
import { getCharacterCardPresentation } from "../cards/assets.js";
import { cardName } from "../actions/model.js";
import { useGameExperience } from "../experience/GameExperience.js";
import { ChoiceStage } from "../experience/ChoiceStage.js";
import { playSeatMotion } from "../experience/motion.js";
import { viewerDistance } from "../game-table/layout.js";
import { sceneSeatPosition } from "./layout.js";

export function SceneTable({ snapshot }: { snapshot: MatchSnapshotView }) {
  const all = [...snapshot.publicTable.players].sort((a,b) => a.seatIndex-b.seatIndex);
  const origin = snapshot.viewer.seatIndex;
  const ordered = [...all].sort((a,b) => ((a.seatIndex-origin+all.length)%all.length)-((b.seatIndex-origin+all.length)%all.length));
  const game = useGameExperience();
  // Keep the last occupied positions while outcomes are presented. Dead seats remain
  // visible for the hit/elimination cue; their HP and target legality update immediately.
  const [seatIds,setSeatIds] = useState(() => ordered.filter(p=>!p.eliminated).map(p=>p.playerId));
  const pending = snapshot.pendingInteraction;
  useEffect(() => {
    if (pending || game?.cue) return;
    const next = ordered.filter(p=>!p.eliminated).map(p=>p.playerId);
    const timer = window.setTimeout(() => setSeatIds(current => current.length===next.length && current.every((id,index)=>id===next[index]) ? current : next),120);
    return () => window.clearTimeout(timer);
  },[snapshot.publicTable.players,snapshot.viewer.seatIndex,pending,game?.cue]);
  const seats = seatIds.flatMap(id=>ordered.filter(p=>p.playerId===id));
  const removed = ordered.filter(p => p.eliminated && !seats.includes(p));
  const top = snapshot.publicTable.publicDiscard.topCard;
  return <section className="scene-board" aria-label="시계 방향 게임 테이블">
    <div className="scene-rail" aria-hidden="true" /><div className="scene-felt" aria-hidden="true" />
    <div className="scene-mark" aria-hidden="true"><strong>BANG!</strong><span>THE SALOON</span></div>
    <div className="scene-piles"><div className="scene-deck" data-card-anchor="deck" aria-label="카드 뽑기 더미"><span aria-hidden="true">B!</span></div><div data-card-anchor="discard" className="scene-discard">{top ? <PlayingCardZoomButton card={top} /> : <span aria-hidden="true" />}</div></div>
    <ol className="scene-seats" data-seat-count={seats.length} aria-label="플레이어 좌석">{seats.map((player,index) => <SceneSeat key={player.playerId} player={player} snapshot={snapshot} position={sceneSeatPosition(index,seats.length)} />)}</ol>
    {removed.length ? <details className="scene-observers"><summary>탈락 {removed.length}명</summary><ul>{removed.map(p => <li key={p.playerId}>{p.displayName} · {p.role ? roleName(p.role) : "역할 비공개"}</li>)}</ul></details> : null}
  </section>;
}

export function roleName(role: string) { return ({ sheriff:"보안관",deputy:"부관",outlaw:"무법자",renegade:"배신자" } as Record<string,string>)[role] ?? role; }
export function HealthHearts({ hp, maxHp }: { hp: number; maxHp: number }) {
  return <span className="scene-hearts" role="img" aria-label={`생명력 ${hp}/${maxHp}`}>{Array.from({length:maxHp},(_,i) => <i key={i} aria-hidden="true" className={i<hp ? "" : "is-empty"}>♥</i>)}</span>;
}
function SceneSeat({player,snapshot,position}: {player:PublicPlayerView;snapshot:MatchSnapshotView;position:CSSProperties}) {
  const game = useGameExperience(), cue = game?.cue;
  const seat = useRef<HTMLElement>(null);
  const [equipmentOpen,setEquipmentOpen] = useState(false);
  const effect = cue?.targetIds.includes(player.playerId) ? cue.kind : cue?.actorId===player.playerId ? "source" : undefined;
  useEffect(() => { if (seat.current) return playSeatMotion(seat.current,effect,game?.motionAllowed ?? false); },[cue?.id,effect,game?.motionAllowed]);
  const mine=player.playerId===snapshot.viewer.playerId, turn=player.playerId===snapshot.publicTable.turn.currentPlayerId;
  const role=player.role ?? (mine && snapshot.viewer.mode==="active" ? snapshot.selfPrivate?.role : undefined);
  const character=getCharacterCardPresentation(player.characterId).name;
  const distance=viewerDistance(snapshot,player);
  const targeting=game?.targeting, available=targeting?.playerIds.includes(player.playerId), selected=available&&targeting?.selectedPlayerId===player.playerId;
  return <li style={{...position,"--seat-top":position.top} as CSSProperties} className={`scene-seat${mine?" scene-seat--self":""}${turn?" scene-seat--turn":""}${player.eliminated?" scene-seat--eliminated":""}`}>
    <article ref={seat} data-player-seat={player.playerId} data-effect={effect} data-target={available ? selected?"selected":"available":undefined} aria-label={`${mine?"내 자리":player.displayName}, ${character}, 생명력 ${player.hp}/${player.maxHp}, ${role?roleName(role):"역할 비공개"}, 손패 ${player.handCount}장${turn?", 현재 차례":""}`}>
      <CharacterPortrait characterId={player.characterId} />
      <strong className="scene-seat__name" title={player.displayName}>{mine?"나":player.displayName}</strong>
      <span className="scene-seat__role">{role?roleName(role):character}</span>
      <HealthHearts hp={player.hp} maxHp={player.maxHp} />
      <span className="scene-seat__hand" role="img" aria-label={`손패 ${player.handCount}장`} style={{"--hand-count":Math.max(1,player.handCount)} as CSSProperties}>{Array.from({length:player.handCount},(_,i)=><i key={i} aria-hidden="true" />)}</span>
      {distance!==null?<span className="scene-seat__distance" aria-label={`나에게서 거리 ${distance}`}>{distance}</span>:null}
      {player.inPlay.length?<button className="scene-seat__equipment" onClick={()=>setEquipmentOpen(true)} aria-label={`${player.displayName}의 장착 카드 ${player.inPlay.length}장 보기`}>장착 {player.inPlay.length}</button>:null}
      {available?<button className="scene-seat__target" type="button" aria-pressed={selected} aria-label={`${player.displayName} 대상 선택`} onClick={()=>targeting?.choosePlayer(player.playerId)}>{selected?"선택됨":"조준"}</button>:null}
      {player.eliminated?<span className="scene-seat__out">탈락</span>:null}
    </article>
    {equipmentOpen?<ChoiceStage interactionId={`equipment:${player.playerId}`} title={`${player.displayName} · 장착 카드`} onDismiss={()=>setEquipmentOpen(false)}><div className="scene-equipment">{player.inPlay.map(card=><div key={card.cardInstanceId}><PlayingCardZoomButton card={card} /><strong>{cardName(card.typeId)}</strong></div>)}</div></ChoiceStage>:null}
  </li>;
}
