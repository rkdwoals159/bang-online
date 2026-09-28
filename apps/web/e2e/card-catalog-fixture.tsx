import { createRoot } from "react-dom/client";
import { BASE_PHYSICAL_CARDS } from "../../../packages/catalog/src/cards/index.js";
import type { CardFaceView, MatchSnapshotView } from "../../../packages/contracts/src/protocol.js";
import { ActionsPanel } from "../src/features/actions/ActionsPanel.js";
import { PlayingCardFace } from "../src/features/cards/CardFaces.js";

declare global {
  interface Window {
    __T60_CARD_FIXTURE__?: Record<string, unknown>;
  }
}

const query = new URLSearchParams(window.location.search);
const mode = query.get("mode") === "d15" ? "d15" : "d14";
const failImage = mode === "d15" && query.get("failImage") === "1";

if (failImage) installBrokenCardImageRoute();

function CatalogFixture() {
  if (mode === "d15") return <FailedImageActionFixture />;

  const cards = BASE_PHYSICAL_CARDS.map((physical) => ({
    ...physical,
    card: {
      cardInstanceId: `fixture-${physical.definitionId}`,
      typeId: physical.typeId,
      rank: String(physical.rank),
      suit: physical.suit,
    } satisfies CardFaceView,
  }));
  const stagecoachCopies = cards.filter(({ typeId }) => typeId === "stagecoach");
  const instanceIds = new Set(cards.map(({ definitionId }) => definitionId));
  const summary = {
    mode,
    totalPhysicalCards: cards.length,
    uniqueDefinitionIds: instanceIds.size,
    stagecoach: stagecoachCopies.map(({ definitionId, card }) => ({
      definitionId,
      cardInstanceId: card.cardInstanceId,
      typeId: card.typeId,
      rank: card.rank,
      suit: card.suit,
    })),
  };
  window.__T60_CARD_FIXTURE__ = summary;
  document.title = "T60 D14 · 80 physical card faces";

  return (
    <>
      <p id="fixture-status" role="status">
        D14: {cards.length} 물리 카드 · 고유 definitionId {instanceIds.size}개 · 역마차 {stagecoachCopies.length}장
      </p>
      <ol className="fixture-grid" aria-label="기본판 물리 카드 80장">
        {cards.map(({ definitionId, typeId, copyIndex, card }) => (
          <li
            className="fixture-card"
            key={definitionId}
            data-definition-id={definitionId}
            data-card-instance-id={card.cardInstanceId}
            data-type-id={typeId}
            data-copy-index={copyIndex}
            data-rank={card.rank}
            data-suit={card.suit}
          >
            <PlayingCardFace card={card} />
            <div className="fixture-meta">
              <code>{definitionId}</code>
              <span>{typeId} · {card.rank} · {card.suit}</span>
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

function FailedImageActionFixture() {
  const matchId = "t60-d15-fixture-match";
  const card: CardFaceView = {
    cardInstanceId: "t60-d15-bang-instance",
    typeId: "bang",
    rank: "A",
    suit: "SPADES",
  };
  const snapshot: MatchSnapshotView = {
    status: "playing",
    viewer: { playerId: "fixture-viewer", seatIndex: 0, mode: "active" },
    publicTable: {
      players: [
        {
          playerId: "fixture-viewer",
          displayName: "테스트 플레이어",
          seatIndex: 0,
          characterId: "bart_cassidy",
          hp: 4,
          maxHp: 4,
          eliminated: false,
          handCount: 1,
          role: "sheriff",
          inPlay: [],
        },
        {
          playerId: "fixture-target",
          displayName: "대상 플레이어",
          seatIndex: 1,
          characterId: "black_jack",
          hp: 4,
          maxHp: 4,
          eliminated: false,
          handCount: 3,
          role: null,
          inPlay: [],
        },
      ],
      turn: { currentPlayerId: "fixture-viewer", phase: "action" },
      deckCount: 79,
      publicDiscard: { topCard: null, count: 0 },
    },
    selfPrivate: { role: "sheriff", hand: [card] },
    legalActions: [{ type: "PLAY_CARD", payload: { cardInstanceId: card.cardInstanceId, targetPlayerId: "fixture-target" } }],
    pendingInteraction: null,
  };
  const status = {
    protocolVersion: 1 as const,
    requestId: "t60-d15-fixture-sync",
    matchId,
    version: 2,
    eventSeq: 1,
    requiresFullSnapshot: true,
    snapshot,
    visibleEvents: [],
  };
  const transport = {
    async sendMatchCommand(command: { commandId: string }) {
      window.__T60_CARD_FIXTURE__ = {
        ...(window.__T60_CARD_FIXTURE__ ?? {}),
        selectedCommandId: command.commandId,
        selectionSubmitted: true,
      };
      return {
        protocolVersion: 1 as const,
        commandId: command.commandId,
        status: "accepted" as const,
        duplicate: false,
        aggregateVersion: 2,
        eventSeq: 1,
      };
    },
    async syncMatch() {
      return status;
    },
  };

  window.__T60_CARD_FIXTURE__ = {
    mode,
    failImageInjected: failImage,
    imageFailureRoute: failImage ? "/__t60_d15_missing_image__.png" : null,
    cardInstanceId: card.cardInstanceId,
    expectedFallback: "뱅! 이미지 없음",
    expectedRankSuit: "A · 스페이드",
    expectedEffect: "사거리 내 다른 생존자 1명을 공격합니다.",
    selectionSubmitted: false,
  };
  document.title = "T60 D15 · failed card image with selectable action";

  return (
    <section className="fixture-actions" aria-label="D15 이미지 실패 카드 행동 fixture">
      <p id="fixture-status" className="fixture-notice" role="status">
        D15: 카드 그림을 의도적으로 실패시켰습니다. 카드 선택, 숫자·무늬와 상세 설명을 확인하세요.
      </p>
      <ActionsPanel
        matchId={matchId}
        version={1}
        snapshot={snapshot}
        transport={transport}
        createCommandId={() => "t60-d15-fixture-command"}
      />
    </section>
  );
}

function installBrokenCardImageRoute(): void {
  const missingImageUrl = "/__t60_d15_missing_image__.png";
  const originalSetAttribute = Element.prototype.setAttribute;
  const imageSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");

  Element.prototype.setAttribute = function setAttribute(name: string, value: string): void {
    if (this instanceof HTMLImageElement && name.toLowerCase() === "src" && value.startsWith("/assets/cards/")) {
      originalSetAttribute.call(this, "data-t60-original-card-image", value);
      originalSetAttribute.call(this, name, missingImageUrl);
      return;
    }
    originalSetAttribute.call(this, name, value);
  };

  if (imageSrcDescriptor?.set && imageSrcDescriptor.get) {
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      configurable: true,
      enumerable: imageSrcDescriptor.enumerable,
      get: imageSrcDescriptor.get,
      set(value: string) {
        const next = value.startsWith("/assets/cards/") ? missingImageUrl : value;
        imageSrcDescriptor.set!.call(this, next);
        if (next === missingImageUrl) {
          originalSetAttribute.call(this, "data-t60-original-card-image", value);
        }
      },
    });
  }
}

createRoot(document.getElementById("root")!).render(<CatalogFixture />);
