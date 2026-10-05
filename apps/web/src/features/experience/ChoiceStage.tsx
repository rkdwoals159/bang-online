import { createContext, useContext, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { MatchSnapshotView, PendingRespondOption } from "../../../../../packages/contracts/src/protocol.js";
import { PlayingCardFace, PlayingCardZoomButton } from "../cards/CardFaces.js";
import { getCharacterCardPresentation, getPlayingCardPresentation } from "../cards/assets.js";
import { useGameExperience } from "./GameExperience.js";
import "./choice-stage.css";

interface ChoiceStageProps { interactionId: string; title: string; attentionKey?: string; children: ReactNode; dockLabel?: string; presentation?: "modal" | "table" }
export const TableStageHost = createContext<HTMLElement | null>(null);

/** Action choices live on the table; optional inspection/settings retain their dialogs. */
export function ChoiceStage(props: ChoiceStageProps) {
  return props.presentation === "table" ? <TableStage {...props} /> : <ModalStage {...props} />;
}

function TableStage({ interactionId, title, children }: ChoiceStageProps) {
  const host = useContext(TableStageHost);
  const titleId = useId(), region = useRef<HTMLElement>(null);
  const ownedFocus = useRef(false);
  useEffect(() => {
    // A picked card can disappear. Keep its focus in the action area, without
    // trapping focus or moving it away from a seat, hand card or inspection dialog.
    if (ownedFocus.current && document.activeElement === document.body) region.current?.focus({ preventScroll: true });
  }, [children, interactionId]);
  const content = <section ref={region} tabIndex={-1} className="table-stage" aria-labelledby={titleId}
    onFocusCapture={() => { ownedFocus.current = true; }}
    onBlurCapture={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) ownedFocus.current = false; }}>
    <header className="table-stage__header"><h2 id={titleId}>{title}</h2></header>
    <div className="table-stage__body">{children}</div>
  </section>;
  return host ? createPortal(content, host) : content;
}

/** Native modal focus containment for optional inspection/settings. */
function ModalStage({ interactionId, title, attentionKey, children, dockLabel = "카드 펼쳐 보기" }: ChoiceStageProps) {
  const [expanded, setExpanded] = useState(true);
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const originalFocus = useRef<HTMLElement | null>(null);
  useEffect(() => { setExpanded(true); }, [interactionId, attentionKey]);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (expanded && !node.open) { originalFocus.current ??= document.activeElement as HTMLElement | null; if (typeof node.showModal === "function") node.showModal(); else node.setAttribute("open", ""); }
    else if (!expanded && node.open) { node.close(); trigger.current?.focus(); }
  }, [expanded]);
  useEffect(() => {
    // A selected card disappears. Keep keyboard focus in the shared stage.
    if (dialog.current?.open && document.activeElement === document.body) dialog.current.focus();
  }, [children]);
  useEffect(() => () => { if (originalFocus.current?.isConnected) originalFocus.current.focus(); }, []);
  function minimize() { setExpanded(false); }
  return <section className="choice-stage" aria-label={title}>
    <div className="choice-stage__dock"><strong>{title}</strong><button ref={trigger} type="button" onClick={() => setExpanded(true)}>{dockLabel}</button></div>
    <dialog ref={dialog} tabIndex={-1} className="choice-stage__dialog" aria-labelledby={titleId} aria-modal="true" onCancel={event => { event.preventDefault(); minimize(); }} onClose={minimize}>
      <header className="choice-stage__header"><h2 id={titleId}>{title}</h2><button type="button" onClick={minimize}>게임판 보기</button></header>
      {children}
    </dialog>
  </section>;
}

export function GeneralStoreStage({ snapshot, canRespond, isResponder, busy, notice, onChoose, retry, imagePick = false, presentation = "modal" }: {
  snapshot: MatchSnapshotView; canRespond: boolean; isResponder: boolean; busy: boolean; notice: string;
  onChoose: (option: PendingRespondOption) => void; retry?: () => void;
  imagePick?: boolean;
  presentation?: "modal" | "table";
}) {
  const game = useGameExperience();
  const pending = snapshot.pendingInteraction;
  if (!pending || pending.kind !== "GENERAL_STORE_PICK") return null;
  const responderId = "currentResponderPlayerId" in pending ? pending.currentResponderPlayerId : undefined;
  const responder = snapshot.publicTable.players.find(p => p.playerId === responderId);
  const options = isResponder && "responseOptions" in pending ? pending.responseOptions : [];
  const cards = snapshot.publicTable.generalStoreCards ?? [];
  const actor = snapshot.publicTable.players.find(p => p.playerId === snapshot.publicTable.turn.currentPlayerId);
  const living = snapshot.publicTable.players.filter(p => !p.eliminated);
  const players = [...living].sort((a,b) => ((a.seatIndex - (actor?.seatIndex ?? 0) + snapshot.publicTable.players.length) % snapshot.publicTable.players.length) - ((b.seatIndex - (actor?.seatIndex ?? 0) + snapshot.publicTable.players.length) % snapshot.publicTable.players.length));
  const cue = game?.cue;
  return <ChoiceStage presentation={presentation} interactionId={pending.interactionId} title="잡화점" attentionKey={isResponder ? snapshot.viewer.playerId : undefined}>
    <p className={`store-stage__turn${isResponder ? " store-stage__turn--mine" : ""}`} role="status" aria-live="polite">
      {busy ? "카드를 가져오는 중…" : isResponder ? "내 차례! 원하는 카드 한 장을 가져가세요." : `${responder?.displayName ?? "현재 참가자"} 님이 고르고 있어요.`}
    </p>
    {notice ? <p className="reaction-prompt__notice" role="status">{notice}</p> : null}
    <ul className="store-stage__cards" aria-label="잡화점에 남은 공개 카드" aria-busy={busy}>
      {cards.map((card,index) => {
        const option = options.find(o => (o.choice === "CHOOSE_CARD" || o.choice === "TAKE_CARD") && "selectedCardInstanceId" in o && o.selectedCardInstanceId === card.cardInstanceId);
        const presentation = getPlayingCardPresentation(card);
        return <li key={card.cardInstanceId} style={{ "--deal-index": index } as CSSProperties}>
          <PlayingCardZoomButton card={card} triggerLabel={imagePick && isResponder && option ? `${presentation.accessibleLabel} 가져오기` : undefined} onInspect={imagePick && isResponder && option ? () => { if (canRespond) onChoose(option); return false; } : undefined} />
          <strong>{presentation.cardName}</strong>
          {isResponder && !imagePick ? <button type="button" aria-label={`${presentation.accessibleLabel} 가져오기`} disabled={!canRespond || !option} onClick={() => { if (option) onChoose(option); }}>가져오기</button> : null}
        </li>;
      })}
    </ul>
    {cue?.kind === "pick" && cue.card ? <div className="store-stage__taken" key={cue.id} aria-hidden="true"><PlayingCardFace card={cue.card} /><span>{cue.label}</span></div> : null}
    <ol className="store-stage__players" aria-label="잡화점 선택 순서">
      {players.map(p => { const portrait = getCharacterCardPresentation(p.characterId); return <li key={p.playerId} className={p.playerId === responderId ? "is-picking" : ""} aria-current={p.playerId === responderId ? "step" : undefined}>
        {portrait.assetUrl ? <img src={portrait.assetUrl} alt="" width="32" height="48" loading="lazy" decoding="async" /> : null}
        <span>{p.playerId === snapshot.viewer.playerId ? "나" : p.displayName}</span>
        {p.playerId === responderId ? <strong>선택 중</strong> : null}
      </li>; })}
    </ol>
    {retry ? <button type="button" className="store-stage__retry" onClick={retry}>다시 확인</button> : null}
  </ChoiceStage>;
}
