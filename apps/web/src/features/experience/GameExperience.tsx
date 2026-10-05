import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import type { MatchSnapshotView, PublicMatchEvent } from "../../../../../packages/contracts/src/protocol.js";
import { PlayingCardFace } from "../cards/CardFaces.js";
import { GameAudio } from "./audio.js";
import { advancePresentation, cueDuration, MAX_QUEUED_CUES, type GameCue, type PresentationCursor } from "./model.js";
import "./animista.css";
import "./experience.css";

export interface TableTargeting { version: number; playerIds: readonly string[]; selectedPlayerId?: string; choosePlayer: (playerId: string) => void }
interface ExperienceValue {
  cue: GameCue | null;
  targeting: TableTargeting | null;
  setTargeting: (targeting: TableTargeting | null) => void;
  soundEnabled: boolean;
  motionEnabled: boolean;
  motionAllowed: boolean;
  toggleSound: () => void;
  toggleMotion: () => void;
}
const ExperienceContext = createContext<ExperienceValue | null>(null);
export const useGameExperience = () => useContext(ExperienceContext);

export function GameExperience({ version, snapshot, visibleEvents, children }: { version: number; snapshot: MatchSnapshotView; visibleEvents: readonly PublicMatchEvent[]; children: ReactNode }) {
  const cursor = useRef<PresentationCursor | null>(null);
  const audio = useRef<GameAudio | null>(null);
  const [lastSound, setLastSound] = useState("");
  const [queue, setQueue] = useState<GameCue[]>([]);
  const [targeting, setTargeting] = useState<TableTargeting | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(true);
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
    try { const sound = localStorage.getItem("bang:sound"), motion = localStorage.getItem("bang:motion"); setSoundEnabled(sound !== "off"); setMotionEnabled(motion !== "off"); engine.setEnabled(sound !== "off"); } catch { /* Preferences are optional. */ }
    const unlock = () => engine.unlock();
    const hide = () => { if (document.hidden) setQueue([]); };
    window.addEventListener("pointerdown", unlock, { capture: true }); window.addEventListener("keydown", unlock, { capture: true }); document.addEventListener("visibilitychange", hide);
    return () => { window.removeEventListener("pointerdown", unlock, { capture: true }); window.removeEventListener("keydown", unlock, { capture: true }); document.removeEventListener("visibilitychange", hide); engine.dispose(); audio.current = null; };
  }, []);
  useEffect(() => {
    const next = advancePresentation(cursor.current, version, snapshot, visibleEvents, Date.now(), !document.hidden);
    cursor.current = next.cursor;
    if (next.cues.length) setQueue(current => [...current, ...next.cues].slice(-MAX_QUEUED_CUES));
  }, [version, snapshot, visibleEvents]);
  useEffect(() => {
    if (!cue) return;
    if (audio.current?.play(cue.kind)) setLastSound(cue.id);
    const timer = window.setTimeout(() => setQueue(current => current.filter(c => c.id !== cue.id)), cueDuration(cue.kind));
    return () => window.clearTimeout(timer);
  }, [cue]);
  const toggleSound = useCallback(() => {
    const next = !soundEnabled; setSoundEnabled(next); audio.current?.setEnabled(next); if (next) audio.current?.unlock();
    try { localStorage.setItem("bang:sound", next ? "on" : "off"); } catch { /* Optional. */ }
  }, [soundEnabled]);
  const toggleMotion = useCallback(() => { const next = !motionEnabled; setMotionEnabled(next); try { localStorage.setItem("bang:motion", next ? "on" : "off"); } catch { /* Optional. */ } }, [motionEnabled]);
  const value = useMemo(() => ({ cue, targeting: targeting?.version === version ? targeting : null, setTargeting, soundEnabled, motionEnabled, motionAllowed, toggleSound, toggleMotion }), [cue, targeting, version, soundEnabled, motionEnabled, motionAllowed, toggleSound, toggleMotion]);
  return <ExperienceContext.Provider value={value}>
    <div className={`game-experience${motionAllowed ? "" : " game-experience--still"}`} data-last-sound={lastSound || undefined}>{children}
      {snapshot.status === "playing" && (snapshot.viewer.mode === "active" || ownResponse) ? <nav className="game-navigation" aria-label="게임 화면 바로가기"><a href="#game-table-title">테이블</a><a href={ownResponse ? "#reaction-prompt-title" : "#game-actions-title"}>{ownResponse ? "내 응답" : "내 손패"}</a></nav> : null}
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
    <button type="button" aria-pressed={game.motionEnabled} onClick={game.toggleMotion}>연출 {game.motionEnabled ? "켜짐" : "꺼짐"}</button>
  </div>;
}

interface Point { x: number; y: number }
/** Coordinates are measured from the visible public seat elements only. */
export function TableEffects({ surface }: { surface: RefObject<HTMLDivElement | null> }) {
  const game = useGameExperience(), cue = game?.cue;
  const motionAllowed = game?.motionAllowed ?? false;
  const [geometry, setGeometry] = useState<{ id: string; source?: Point; targets: Point[] } | null>(null);
  useEffect(() => {
    const table = surface.current;
    if (!cue || !table || !motionAllowed) { setGeometry(null); return; }
    const measure = () => {
      const bounds = table.getBoundingClientRect();
      const seats = new Map(Array.from(table.querySelectorAll<HTMLElement>("[data-player-seat]")).map(e => [e.dataset.playerSeat, e]));
      const center = (id: string): Point | undefined => { const seat = seats.get(id); if (!seat) return; const r = (seat.querySelector(".character-detail") ?? seat).getBoundingClientRect(); return { x: r.left + r.width / 2 - bounds.left, y: r.top + r.height / 2 - bounds.top }; };
      setGeometry({ id: cue.id, source: cue.actorId ? center(cue.actorId) : undefined, targets: cue.targetIds.flatMap(id => { const p = center(id); return p ? [p] : []; }) });
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(table);
    return () => observer.disconnect();
  }, [cue?.id, surface, motionAllowed]);
  if (!motionAllowed || !cue || geometry?.id !== cue.id) return null;
  const shooting = cue.kind === "shot" || cue.kind === "burst";
  return <div className={`table-effects table-effects--${cue.kind}`} key={cue.id} aria-hidden="true">
    {geometry.targets.map((target, index) => <div key={index}>
      {shooting && geometry.source ? <>
        <svg className="table-effects__traces"><path pathLength="1" d={`M ${geometry.source.x} ${geometry.source.y} L ${target.x} ${target.y}`} /></svg>
        {Array.from({ length: cue.kind === "burst" ? 4 : 1 }, (_, shot) => <i key={shot} className="table-effects__projectile" style={{ left: geometry.source!.x, top: geometry.source!.y, "--travel-x": `${target.x - geometry.source!.x}px`, "--travel-y": `${target.y - geometry.source!.y}px`, animationDelay: `${shot * 90 + index * 50}ms` } as CSSProperties} />)}
      </> : null}
      <span className="table-effects__impact" style={{ left: target.x, top: target.y, animationDelay: shooting ? `${index * 50 + 220}ms` : "0ms" }}>{cue.kind === "block" ? "팅!" : cue.kind === "heal" ? "+" : cue.kind === "shot" || cue.kind === "burst" ? "뱅!" : cue.kind === "hit" ? "−" : ""}</span>
    </div>)}
  </div>;
}
