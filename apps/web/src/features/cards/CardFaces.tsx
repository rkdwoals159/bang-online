import { useEffect, useId, useRef, useState } from "react";
import type { CardFaceView } from "../../../../../packages/contracts/src/protocol.js";
import {
  getCharacterCardPresentation,
  getOpponentHandBackAlt,
  getPlayingCardPresentation,
  getRoleCardPresentation,
} from "./assets.js";
import "./cards.css";

export function PlayingCardFace({ card }: { card: CardFaceView }) {
  const presentation = getPlayingCardPresentation(card);

  return (
    <div className="playing-card" role="group" aria-label={presentation.accessibleLabel}>
      <CardArtwork
        className="playing-card__artwork"
        assetUrl={presentation.assetUrl}
        imageAlt={presentation.imageAlt}
        fallbackText={presentation.fallbackText}
      />
      <span className="playing-card__printed-corner-cover" aria-hidden="true" />
      <span className="playing-card__rank" aria-label={`숫자 ${presentation.rankText}`}>
        {presentation.rankText}
      </span>
      <span className="playing-card__suit" aria-label={presentation.suitName}>
        <span
          aria-hidden="true"
          style={{ color: card.suit === "HEARTS" || card.suit === "DIAMONDS" ? "#bd3130" : "#211e1a" }}
        >
          {presentation.suitMark}
        </span>
      </span>
    </div>
  );
}

const PLAYING_CARD_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  bang: "사거리 내 다른 생존자 1명을 공격합니다.",
  missed: "뱅 심볼 공격에 대응합니다. 일반 사용은 불가합니다(캘러미티 재닛 예외).",
  beer: "자기 생명력을 최대치까지 1 회복합니다. 자기 사용 단계 또는 치명상 구제에서만 사용할 수 있습니다. 생존자가 2명이면 회복은 0이며, 만피나 생존자 2명 상태에서도 자기 턴에 사용할 수 있습니다.",
  saloon: "자신을 포함한 모든 생존자가 최대치까지 생명력을 1 회복합니다. 생존자가 2명이어도 유효합니다. 치명상 구제나 부활에는 사용할 수 없습니다.",
  stagecoach: "자기 손패로 카드 2장을 뽑습니다.",
  wells_fargo: "자기 손패로 카드 3장을 뽑습니다.",
  general_store: "현재 생존자 수만큼 카드를 공개합니다. 카드 사용자부터 시계 방향으로 생존자가 각 1장씩 골라 손패에 넣습니다.",
  panic: "거리 1인 대상의 손패에서는 무작위 카드 1장을, 공개 장착 카드에서는 카드 사용자가 고른 카드 1장을 자기 손패로 가져옵니다. 무기 사거리는 적용하지 않습니다.",
  cat_balou: "거리와 관계없이 대상의 손패에서 무작위 카드 1장을, 공개 장착 카드에서는 카드 사용자가 고른 카드 1장을 버립니다.",
  gatling: "자신을 제외한 모든 생존자에게 뱅 심볼 공격을 합니다. 빗나감이나 술통으로 대응할 수 있습니다. 뱅 사용 횟수 제한과 슬랩의 효과는 적용하지 않습니다.",
  indians: "자신을 제외한 각 생존자는 뱅 1장을 버리거나 피해 1을 받습니다. 빗나감이나 술통으로 대응할 수 없습니다(캘러미티 재닛의 변환 예외).",
  duel: "거리와 관계없이 다른 생존자 1명과 결투합니다. 상대부터 뱅 1장씩 번갈아 버립니다. 카드를 내지 못하거나 포기한 쪽은 피해 1을 받고 결투가 끝납니다. 빗나감이나 술통은 사용할 수 없습니다(캘러미티 재닛의 변환 예외).",
  barrel: "자신에게 장착합니다. 공격을 받을 때마다 하트 판정으로 방어할 수 있습니다.",
  jail: "보안관이 아닌 다른 생존자에게 장착합니다. 대상의 차례 시작에 하트가 나오면 진행하고, 아니면 그 차례를 건너뜁니다. 판정 결과와 관계없이 감옥은 버립니다.",
  dynamite: "자신에게 장착합니다. 다음 자기 차례 시작에 스페이드 2–9가 나오면 버리고 피해 3을 받습니다. 그렇지 않으면 다음 시계 방향 생존자에게 전달합니다. 감옥보다 먼저 처리합니다.",
  mustang: "자신에게 장착합니다. 다른 플레이어가 보는 자신의 거리가 1 증가합니다.",
  scope: "자신에게 장착합니다. 자신이 보는 다른 플레이어와의 거리가 1 감소합니다(최소 1).",
  volcanic: "자신에게 장착합니다. 사거리는 1이며, 뱅을 제한 없이 사용할 수 있습니다.",
  schofield: "자신에게 장착합니다. 사거리는 2입니다.",
  remington: "자신에게 장착합니다. 사거리는 3입니다.",
  carabine: "자신에게 장착합니다. 사거리는 4입니다.",
  winchester: "자신에게 장착합니다. 사거리는 5입니다.",
});

/** Card text is taken from the ruleset's existing per-card summaries. */
export function getPlayingCardDescription(typeId: string): string {
  return PLAYING_CARD_DESCRIPTIONS[typeId] ?? "카드 설명을 확인할 수 없습니다.";
}

/** A separate, non-mutating detail entry point for an already-projected card face. */
export function PlayingCardZoomButton({
  card,
  details = [],
  detailHeading = "현재 허용된 선택",
  triggerClassName = "",
  triggerText = "상세 보기",
}: {
  card: CardFaceView;
  details?: readonly string[];
  detailHeading?: string;
  triggerClassName?: string;
  triggerText?: string;
}) {
  const presentation = getPlayingCardPresentation(card);
  const titleId = useId();
  const descriptionId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openedRef = useRef(false);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!isOpen) {
      if (openedRef.current) {
        openedRef.current = false;
        triggerRef.current?.focus();
      }
      return;
    }
    if (!dialog || dialog.open) return;

    openedRef.current = true;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }, [isOpen]);

  function closeDialog() {
    const dialog = dialogRef.current;
    if (dialog?.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
    setIsOpen(false);
  }

  return (
    <div className="card-zoom">
      <button
        ref={triggerRef}
        className={`card-zoom__trigger${triggerClassName ? ` ${triggerClassName}` : ""}`}
        type="button"
        aria-label={`카드 상세 보기: ${presentation.accessibleLabel}`}
        aria-haspopup="dialog"
        onClick={() => setIsOpen(true)}
      >
        {triggerText}
      </button>
      <dialog
        ref={dialogRef}
        className="card-zoom__dialog"
        aria-modal="true"
        aria-hidden={isOpen ? undefined : true}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onCancel={(event) => {
          event.preventDefault();
          closeDialog();
        }}
        onClose={() => setIsOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeDialog();
        }}
      >
        <header className="card-zoom__header">
          <h2 id={titleId} className="card-zoom__title">{presentation.cardName} 카드 상세</h2>
          <button className="card-zoom__close" type="button" onClick={closeDialog}>닫기</button>
        </header>
        <div className="card-zoom__content">
          <div className="card-zoom__visual">
            <PlayingCardFace card={card} />
          </div>
          <div className="card-zoom__text">
            <p className="card-zoom__identity">{presentation.rankText} · {presentation.suitName}</p>
            <p id={descriptionId} className="card-zoom__description">{getPlayingCardDescription(card.typeId)}</p>
            {details.length > 0 ? (
              <section className="card-zoom__details" aria-label={detailHeading}>
                <h3>{detailHeading}</h3>
                <ul>
                  {details.map((detail, index) => <li key={`${index}-${detail}`}>{detail}</li>)}
                </ul>
              </section>
            ) : null}
          </div>
        </div>
      </dialog>
    </div>
  );
}

/** A CSS-only back keeps opponent hand identity, rank, and suit out of the DOM. */
export function OpponentHandBacks({ count, label = "상대 손패" }: { count: number; label?: string }) {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;

  return (
    <section className="opponent-hand" aria-label={`${label} ${safeCount}장`}>
      <span className="opponent-hand__count">손패 {safeCount}장</span>
      {safeCount > 0 ? (
        <ul className="opponent-hand__cards" aria-label={`${label} 카드 뒷면`}>
          {Array.from({ length: safeCount }, (_, index) => (
            <li key={`${label}-${index}`}>
              <div className="card-back" role="img" aria-label={getOpponentHandBackAlt()}>
                <span aria-hidden="true">뒷면</span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <span className="opponent-hand__empty">손패가 비어 있어요.</span>
      )}
    </section>
  );
}

export function CharacterCardFace({
  characterId,
  description,
}: {
  characterId: string;
  /** Provide the ruleset's text description separately from the image. */
  description: string;
}) {
  const presentation = getCharacterCardPresentation(characterId);
  return (
    <RosterCard
      kind="인물"
      name={presentation.name}
      assetUrl={presentation.assetUrl}
      imageAlt={presentation.imageAlt}
      fallbackText={presentation.fallbackText}
      description={description}
    />
  );
}

export function RoleCardFace({ roleId, description }: { roleId: string; description: string }) {
  const presentation = getRoleCardPresentation(roleId);
  return (
    <RosterCard
      kind="역할"
      name={presentation.name}
      assetUrl={presentation.assetUrl}
      imageAlt={presentation.imageAlt}
      fallbackText={presentation.fallbackText}
      description={description}
    />
  );
}

function RosterCard({
  kind,
  name,
  assetUrl,
  imageAlt,
  fallbackText,
  description,
}: {
  kind: "인물" | "역할";
  name: string;
  assetUrl: string | undefined;
  imageAlt: string;
  fallbackText: string;
  description: string;
}) {
  return (
    <article className="roster-card" aria-label={`${name} ${kind} 카드`}>
      <CardArtwork
        className="roster-card__artwork"
        assetUrl={assetUrl}
        imageAlt={imageAlt}
        fallbackText={fallbackText}
      />
      <h3>{name}</h3>
      <p>{description}</p>
    </article>
  );
}

function CardArtwork({
  className,
  assetUrl,
  imageAlt,
  fallbackText,
}: {
  className: string;
  assetUrl: string | undefined;
  imageAlt: string;
  fallbackText: string;
}) {
  const [failedAssetUrl, setFailedAssetUrl] = useState<string | null>(null);
  const useFallback = !assetUrl || failedAssetUrl === assetUrl;

  if (useFallback) {
    return (
      <div className={`${className} card-artwork--fallback`} role="img" aria-label={imageAlt}>
        <span>{fallbackText}</span>
      </div>
    );
  }

  return (
    <div className={className}>
      <img
        src={assetUrl}
        alt={imageAlt}
        loading="lazy"
        decoding="async"
        onError={() => setFailedAssetUrl(assetUrl)}
      />
    </div>
  );
}
