import { useRef, useState } from "react";
import type { MatchSnapshotView, PublicMatchEvent, RoomView } from "../../../../../packages/contracts/src/protocol.js";
import { ActionsPanel, type ActionTransport } from "../actions/ActionsPanel.js";
import { CharacterPortrait } from "../cards/CardFaces.js";
import { getCharacterCardPresentation } from "../cards/assets.js";
import { ReactionPrompt } from "../reactions/ReactionPrompt.js";
import { interactionLabel } from "../reactions/model.js";
import { StatusPanel, type ResultRoomTransport } from "../status/StatusPanel.js";
import { ChoiceStage, TableStageHost } from "../experience/ChoiceStage.js";
import { GameExperienceControls, TableEffects } from "../experience/GameExperience.js";
import { HealthHearts, roleName, SceneTable } from "./SceneTable.js";
import "./scene.css";

export interface GameSceneProps {
  matchId: string; version: number; snapshot: MatchSnapshotView; visibleEvents: readonly PublicMatchEvent[];
  room: RoomView; roomVersion: number; transport: ActionTransport & ResultRoomTransport; showActions: boolean;
}
/** One persistent scene; commands and responses still use their authoritative controllers. */
export function GameScene({matchId,version,snapshot,visibleEvents,room,roomVersion,transport,showActions}:GameSceneProps) {
  const surface=useRef<HTMLDivElement>(null);
  const [centerHost,setCenterHost]=useState<HTMLDivElement|null>(null);
  const [logOpen,setLogOpen]=useState(false),[settingsOpen,setSettingsOpen]=useState(false),[fullscreenError,setFullscreenError]=useState("");
  const completed=snapshot.status==="completed", pending=snapshot.pendingInteraction;
  const self=snapshot.publicTable.players.find(p=>p.playerId===snapshot.viewer.playerId);
  const turn=snapshot.publicTable.players.find(p=>p.playerId===snapshot.publicTable.turn.currentPlayerId);
  const mine=turn?.playerId===snapshot.viewer.playerId;
  const sync={version,snapshot,visibleEvents};
  const statusProps={sync,room,roomVersion,matchId,transport};
  const caption=completed?"게임 종료":snapshot.status==="paused"?"잠시 멈춤":snapshot.status==="recovery_required"?"연결 확인 중":pending?interactionLabel(pending.kind):mine?"내 차례":`${turn?.displayName ?? "참가자"} 님 차례`;
  async function fullscreen() { try { setFullscreenError(""); if (document.fullscreenElement) await document.exitFullscreen(); else if (surface.current?.requestFullscreen) await surface.current.requestFullscreen(); else setFullscreenError("이 브라우저에서는 전체 화면을 지원하지 않아요."); } catch {setFullscreenError("전체 화면을 열지 못했어요.");} }
  return <TableStageHost.Provider value={centerHost}><div className="game-scene" ref={surface} data-match-id={matchId} data-viewer-id={snapshot.viewer.playerId}>
    <header className="scene-hud"><strong className="scene-brand" aria-label="뱅 온라인">BANG!</strong><span className={`scene-turn${mine&&!pending?" scene-turn--mine":""}`} role="status" aria-live="polite" title={caption}>{caption}</span><nav aria-label="경기 메뉴"><button type="button" aria-pressed={logOpen} onClick={()=>setLogOpen(!logOpen)}>기록</button><button type="button" onClick={()=>setSettingsOpen(true)}>설정</button><button className="scene-fullscreen" type="button" onClick={()=>void fullscreen()}>전체 화면</button></nav></header>
    <SceneTable snapshot={snapshot} />
    <div className="scene-center" ref={setCenterHost} data-card-anchor="choice">
      {!completed&&pending?<ReactionPrompt variant="scene" matchId={matchId} version={version} snapshot={snapshot} transport={transport}/>:null}
      {completed?<ChoiceStage presentation="table" interactionId={`result:${matchId}`} title="승부가 결정됐습니다"><div className="scene-result"><StatusPanel {...statusProps}/></div></ChoiceStage>:null}
    </div>
    <footer className="scene-hand-dock" data-card-anchor="hud">
      {self?<div className="scene-self"><CharacterPortrait characterId={self.characterId} /><div><strong title={self.displayName}>{self.displayName}</strong>{snapshot.viewer.mode==="active"&&snapshot.selfPrivate?<span className="scene-self__role">{roleName(snapshot.selfPrivate.role)}</span>:self.role?<span className="scene-self__role">{roleName(self.role)}</span>:null}<p>{getCharacterCardPresentation(self.characterId).name}</p><HealthHearts hp={self.hp} maxHp={self.maxHp}/></div></div>:null}
      {showActions&&!completed&&snapshot.viewer.mode==="active"?<ActionsPanel variant="scene" matchId={matchId} version={version} snapshot={snapshot} transport={transport}/>:<div className="scene-spectating">{completed?"이번 판이 끝났어요.":"탈락 · 경기를 지켜보고 있어요."}</div>}
    </footer>
    {logOpen?<aside className="scene-log" aria-label="게임 기록"><header><strong>게임 기록</strong><button type="button" onClick={()=>setLogOpen(false)}>닫기</button></header><StatusPanel {...statusProps} initialLogOpen/></aside>:null}
    {settingsOpen?<ChoiceStage interactionId="scene-settings" title="경기 설정" dockLabel="설정 열기"><GameExperienceControls/><p>효과음은 직접 켜면 재생돼요. 기기의 동작 줄이기 설정도 적용합니다.</p>{fullscreenError?<p role="alert">{fullscreenError}</p>:null}<button type="button" onClick={()=>setSettingsOpen(false)}>닫기</button></ChoiceStage>:null}
    {fullscreenError&&!settingsOpen?<p className="scene-error" role="alert">{fullscreenError}<button type="button" onClick={()=>setFullscreenError("")}>닫기</button></p>:null}
    <TableEffects surface={surface}/>
  </div></TableStageHost.Provider>;
}
