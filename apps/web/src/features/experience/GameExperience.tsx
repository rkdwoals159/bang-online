import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import type { MatchSnapshotView, PublicMatchEvent } from "../../../../../packages/contracts/src/protocol.js";
import { PlayingCardFace } from "../cards/CardFaces.js";
import { GameAudio } from "./audio.js";
import { planSounds } from "./sound-plan.js";
import { advancePresentation, boundCueQueue, cueDuration, type GameCue, type PresentationCursor } from "./model.js";
import "./animista.css";
import "./experience.css";

export interface TableTargeting { version: number; playerIds: readonly string[]; selectedPlayerId?: string; choosePlayer: (playerId: string) => void }
interface ExperienceValue {
  cue: GameCue | null;
  targeting: TableTargeting | null;
  setTargeting: (targeting: TableTargeting | null) => void;
  soundEnabled: boolean;
  soundVolume: number;
  changeSoundVolume: (value: number) => void;
  motionEnabled: boolean;
  motionAllowed: boolean;
  toggleSound: () => void;
  toggleMotion: () => void;
}
const ExperienceContext = createContext<ExperienceValue | null>(null);
export const useGameExperience = () => useContext(ExperienceContext);

export function GameExperience({ version, snapshot, visibleEvents, children, scene = false }: { version: number; snapshot: MatchSnapshotView; visibleEvents: readonly PublicMatchEvent[]; children: ReactNode; scene?: boolean }) {
  const cursor = useRef<PresentationCursor | null>(null);
  const audio = useRef<GameAudio | null>(null);
  const [lastSound, setLastSound] = useState("");
  const explosionSound = useRef("");
  const [queue, setQueue] = useState<GameCue[]>([]);
  const [targeting, setTargeting] = useState<TableTargeting | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [soundVolume, setSoundVolume] = useState(.7);
  const [motionEnabled, setMotionEnabled] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const motionAllowed = motionEnabled && !reducedMotion;
  const cue = queue[0] ?? null;
  const ownResponse = snapshot.pendingInteraction && "currentResponderPlayerId" in snapshot.pendingInteraction &&
    snapshot.pendingInteraction.currentResponderPlayerId === snapshot.viewer.playerId && snapshot.pendingInteraction.kind !== "GENERAL_STORE_PICK";
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(preference.matches);
    update(); preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const engine = new GameAudio(); audio.current = engine;
    engine.setEnabled(false);
    try { const sound = localStorage.getItem("bang:sound"), motion = localStorage.getItem("bang:motion"); setSoundEnabled(sound === "on"); setMotionEnabled(motion !== "off"); engine.setEnabled(sound === "on"); } catch { /* Preferences are optional. */ }
    try { const saved=localStorage.getItem("bang:sound-volume"); const volume=saved === null ? .7 : Number(saved); if(Number.isFinite(volume)&&volume>=0&&volume<=1){setSoundVolume(volume);engine.setVolume(volume);} } catch { /* Preferences are optional. */ }
    engine.setVisible(!document.hidden);
    const unlock = () => engine.unlock();
    const hide = () => { engine.setVisible(!document.hidden); if (document.hidden) setQueue([]); };
    window.addEventListener("pointerdown", unlock, { capture: true }); window.addEventListener("keydown", unlock, { capture: true }); document.addEventListener("visibilitychange", hide);
    return () => { window.removeEventListener("pointerdown", unlock, { capture: true }); window.removeEventListener("keydown", unlock, { capture: true }); document.removeEventListener("visibilitychange", hide); engine.dispose(); audio.current = null; };
  }, []);
  useEffect(() => {
    const next = advancePresentation(cursor.current, version, snapshot, visibleEvents, Date.now(), !document.hidden);
    cursor.current = next.cursor;
    if (next.cues.length) {
      for (const step of planSounds(next.cues.filter(c => c.kind !== "explosion"))) if (audio.current?.play(step.kind, step.offset, step.count)) setLastSound(step.id);
      setQueue(current => boundCueQueue([...current, ...next.cues]));
    }
  }, [version, snapshot, visibleEvents]);
  useEffect(() => {
    if (!cue) return;
    if (cue.kind === "explosion" && explosionSound.current !== cue.id) {
      explosionSound.current = cue.id;
      if (audio.current?.play("explosion")) setLastSound(cue.id);
    }
    const timer = window.setTimeout(() => setQueue(current => current.filter(c => c.id !== cue.id)), cueDuration(cue.kind));
    return () => window.clearTimeout(timer);
  }, [cue]);
  const toggleSound = useCallback(() => {
    const next = !soundEnabled; setSoundEnabled(next); audio.current?.setEnabled(next); if (next) audio.current?.unlock();
    try { localStorage.setItem("bang:sound", next ? "on" : "off"); } catch { /* Optional. */ }
  }, [soundEnabled]);
  const changeSoundVolume = useCallback((value: number) => {
    if(!Number.isFinite(value))return;
    const volume=Math.max(0,Math.min(1,value));setSoundVolume(volume);audio.current?.setVolume(volume);
    try{localStorage.setItem("bang:sound-volume",String(volume));}catch{ /* Preferences are optional. */ }
  },[]);
  const toggleMotion = useCallback(() => { const next = !motionEnabled; setMotionEnabled(next); try { localStorage.setItem("bang:motion", next ? "on" : "off"); } catch { /* Optional. */ } }, [motionEnabled]);
  const value = useMemo(() => ({ cue, targeting: targeting?.version === version ? targeting : null, setTargeting, soundEnabled, soundVolume, changeSoundVolume, motionEnabled, motionAllowed, toggleSound, toggleMotion }), [cue, targeting, version, soundEnabled, soundVolume, changeSoundVolume, motionEnabled, motionAllowed, toggleSound, toggleMotion]);
  return <ExperienceContext.Provider value={value}>
    <div className={`game-experience${scene ? " game-experience--scene" : ""}${motionAllowed ? "" : " game-experience--still"}`} data-last-sound={lastSound || undefined}>{children}
      {!scene && snapshot.status === "playing" && (snapshot.viewer.mode === "active" || ownResponse) ? <nav className="game-navigation" aria-label="게임 화면 바로가기"><a href="#game-table-title">테이블</a><a href={ownResponse ? "#reaction-prompt-title" : "#game-actions-title"}>{ownResponse ? "내 응답" : "내 손패"}</a></nav> : null}
      {cue ? <div key={cue.id} className={`game-cue game-cue--${cue.kind}`} role="status" aria-live="polite">
        <strong>{cue.label}</strong>
        {cue.card ? <PlayingCardFace card={cue.card} /> : null}
      </div> : null}
    </div>
  </ExperienceContext.Provider>;
}

export function GameExperienceControls() {
  const game = useGameExperience();
  if (!game) return null;
  return <div className="game-experience__controls" aria-label="게임 연출 설정">
    <button type="button" aria-pressed={game.soundEnabled} onClick={game.toggleSound}>효과음 {game.soundEnabled ? "켜짐" : "꺼짐"}</button>
    <label className="game-experience__volume">음량 <input aria-label="효과음 음량" type="range" min="0" max="100" step="5" value={Math.round(game.soundVolume*100)} onChange={event=>game.changeSoundVolume(Number(event.target.value)/100)}/><span>{Math.round(game.soundVolume*100)}%</span></label>
    <button type="button" aria-pressed={game.motionEnabled} onClick={game.toggleMotion}>연출 {game.motionEnabled ? "켜짐" : "꺼짐"}</button>
  </div>;
}

interface Point { x: number; y: number }
/** Coordinates are measured from the visible public seat elements only. */
export function TableEffects({ surface }: { surface: RefObject<HTMLDivElement | null> }) {
  const game = useGameExperience(), cue = game?.cue;
  const motionAllowed = game?.motionAllowed ?? false;
  const [geometry, setGeometry] = useState<{ id: string; source?: Point; targets: Point[]; flights: {from:Point;to:Point}[] } | null>(null);
  useEffect(() => {
    const table = surface.current;
    if (!cue || !table || !motionAllowed) { setGeometry(null); return; }
    const measure = () => {
      const bounds = table.getBoundingClientRect();
      const seats = new Map(Array.from(table.querySelectorAll<HTMLElement>("[data-player-seat]")).map(e => [e.dataset.playerSeat, e]));
      const center = (id: string): Point | undefined => { const seat = id === table.dataset.viewerId ? table.querySelector<HTMLElement>(".scene-self") ?? seats.get(id) : seats.get(id); if (!seat) return; const r = (seat.querySelector(".character-detail") ?? seat).getBoundingClientRect(); return { x: r.left + r.width / 2 - bounds.left, y: r.top + r.height / 2 - bounds.top }; };
      const anchor = (name:string):Point|undefined => { const element=table.querySelector<HTMLElement>(`[data-card-anchor="${name}"]`); if (!element) return; const r=element.getBoundingClientRect(); return {x:r.left+r.width/2-bounds.left,y:r.top+r.height/2-bounds.top}; };
      const hand = (id:string):Point|undefined => {
        if (id===table.dataset.viewerId) return anchor("hand") ?? center(id);
        const row=seats.get(id)?.querySelector<HTMLElement>(".scene-seat__hand");
        if (!row) return center(id); const r=row.getBoundingClientRect();
        return r.height>0?{x:r.left+r.width/2-bounds.left,y:r.top+r.height/2-bounds.top}:center(id);
      };
      const equipment = (id:string):Point|undefined => {
        const seat = seats.get(id), button = seat?.querySelector<HTMLElement>(".scene-seat__equipment");
        if (!button) return center(id);
        const r = button.getBoundingClientRect(); return {x:r.left+r.width/2-bounds.left,y:r.top+r.height/2-bounds.top};
      };
      const source=cue.actorId?center(cue.actorId):undefined;
      const targets=cue.targetIds.flatMap(id=>{const p=center(id);return p?[p]:[];});
      const flights:{from:Point;to:Point}[]=[];
      const route=(from:Point|undefined,to:Point|undefined)=>{if(from&&to)flights.push({from,to});};
      if(cue.movement)route(cue.movement.fromZone==="in_play"?equipment(cue.movement.fromId):hand(cue.movement.fromId),
        cue.movement.toZone==="discard"?anchor("discard"):cue.movement.toId?hand(cue.movement.toId):undefined);
      else if(cue.kind==="draw")cue.targetIds.forEach(id=>route(anchor("deck"),hand(id)));
      else if(["play","shot","burst","threat","duel"].includes(cue.kind))route(cue.actorId?hand(cue.actorId):undefined,anchor("discard"));
      else if(cue.kind==="equip")cue.targetIds.forEach(id=>route(cue.actorId?hand(cue.actorId):anchor("discard"),center(id)));
      else if(cue.kind==="discard")cue.targetIds.forEach(id=>route(hand(id),anchor("discard")));
      else if(cue.kind==="pick")cue.targetIds.forEach(id=>route(cue.actorId?hand(id):anchor("choice") ?? anchor("discard"),hand(cue.actorId??id)));
      else if(cue.kind==="pass")targets.forEach(p=>route(source,p));
      setGeometry({ id: cue.id, source, targets, flights });
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(table);
    return () => observer.disconnect();
  }, [cue?.id, surface, motionAllowed]);
  if (!motionAllowed || !cue || geometry?.id !== cue.id) return null;
  const shooting = cue.kind === "shot" || cue.kind === "burst";
  return <div className={`table-effects table-effects--${cue.kind}`} key={cue.id} aria-hidden="true">
    {geometry.flights.map(({from,to},index)=><div key={`flight:${index}`} className="scene-card-flight" style={{left:from.x,top:from.y,"--travel-x":`${to.x-from.x}px`,"--travel-y":`${to.y-from.y}px`} as CSSProperties}>{cue.card?<PlayingCardFace card={cue.card}/>:<span className="scene-flight-back">B!</span>}</div>)}
    {geometry.targets.map((target, index) => <div key={index}>
      {cue.kind === "explosion" ? <div className="dynamite-explosion" style={{left:target.x,top:target.y}}>
        <i className="dynamite-explosion__flash"/><i className="dynamite-explosion__wave"/>
        {Array.from({length:10},(_,spark)=><i key={spark} className="dynamite-explosion__spark" style={{"--spark-angle":`${spark*36}deg`,"--spark-distance":`${64+(spark%3)*18}px`} as CSSProperties}/>)}
        <span className="dynamite-explosion__label">펑!</span>
      </div> : null}
      {shooting && geometry.source ? <>
        <svg className="table-effects__traces"><path pathLength="1" d={`M ${geometry.source.x} ${geometry.source.y} L ${target.x} ${target.y}`} /></svg>
        {Array.from({ length: cue.kind === "burst" ? 4 : 1 }, (_, shot) => <i key={shot} className="table-effects__projectile" style={{ left: geometry.source!.x, top: geometry.source!.y, "--travel-x": `${target.x - geometry.source!.x}px`, "--travel-y": `${target.y - geometry.source!.y}px`, animationDelay: `${shot * 90 + index * 50}ms` } as CSSProperties} />)}
      </> : null}
      {cue.kind !== "explosion" ? <span className="table-effects__impact" style={{ left: target.x, top: target.y, animationDelay: shooting ? `${index * 50 + 220}ms` : "0ms" }}>{cue.kind === "block" ? "팅!" : cue.kind === "heal" ? "+♥" : shooting ? "뱅!" : cue.kind === "hit" ? "−♥" : cue.kind === "pick" && cue.movement ? "탈취!" : cue.kind === "discard" ? "버림!" : cue.kind === "eliminated" ? "탈락" : cue.kind === "threat" ? "대응!" : cue.kind === "victory" ? "승리" : ""}</span> : null}
    </div>)}
  </div>;
}
