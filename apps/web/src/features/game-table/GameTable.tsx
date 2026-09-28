import type { CSSProperties } from "react";
import type {
  CardFaceView,
  MatchSnapshotView,
  PublicPlayerView,
  RoleId,
} from "../../../../../packages/contracts/src/protocol.js";
import "./game-table.css";

const roleNames: Record<RoleId, string> = {
  sheriff: "보안관",
  deputy: "부관",
  outlaw: "무법자",
  renegade: "배신자",
};

const characterNames: Record<string, string> = {
  bart_cassidy: "바트 캐시디",
  black_jack: "블랙 잭",
  calamity_janet: "캘러미티 재닛",
  el_gringo: "엘 그링고",
  jesse_jones: "제시 존스",
  jourdonnais: "주르도네",
  kit_carlson: "킷 칼슨",
  lucky_duke: "럭키 듀크",
  paul_regret: "폴 레그레",
  pedro_ramirez: "페드로 라미레스",
  rose_doolan: "로즈 둘런",
  sid_ketchum: "시드 케첨",
  slab_the_killer: "슬랩 더 킬러",
  suzy_lafayette: "수지 라파예트",
  vulture_sam: "벌처 샘",
  willy_the_kid: "윌리 더 키드",
};

const cardNames: Record<string, string> = {
  bang: "뱅!",
  missed: "빗나감!",
  beer: "맥주",
  saloon: "술집",
  stagecoach: "역마차",
  wells_fargo: "웰스 파고",
  general_store: "잡화점",
  panic: "패닉!",
  cat_balou: "캣 벌루",
  gatling: "개틀링",
  indians: "인디언!",
  duel: "결투",
  barrel: "술통",
  jail: "감옥",
  dynamite: "다이너마이트",
  mustang: "머스탱",
  scope: "조준경",
  volcanic: "볼캐닉",
  schofield: "스코필드",
  remington: "레밍턴",
  carabine: "레밍턴 카빈",
  winchester: "윈체스터",
};

const suitMarks: Record<CardFaceView["suit"], string> = {
  SPADES: "♠",
  HEARTS: "♥",
  DIAMONDS: "♦",
  CLUBS: "♣",
};

const suitNames: Record<CardFaceView["suit"], string> = {
  SPADES: "스페이드",
  HEARTS: "하트",
  DIAMONDS: "다이아몬드",
  CLUBS: "클럽",
};

const phaseNames: Record<string, string> = {
  start: "턴 시작",
  draw: "카드 뽑기",
  play: "카드 사용",
  discard: "손패 정리",
};

const statusNames: Record<MatchSnapshotView["status"], string> = {
  playing: "게임 진행 중",
  paused: "게임 일시 정지",
  completed: "게임 종료",
  recovery_required: "복구 확인 필요",
};

interface GameTableProps {
  snapshot: MatchSnapshotView;
}

interface PositionedPlayer {
  player: PublicPlayerView;
  relativeIndex: number;
}

/** A presentation-only table built from the authenticated seat's projection. */
export function GameTable({ snapshot }: GameTableProps) {
  const players = orderPlayersForViewer(snapshot);
  const activeSelfPrivate =
    snapshot.viewer.mode === "active" ? snapshot.selfPrivate : null;
  const currentPlayer = snapshot.publicTable.players.find(
    (player) => player.playerId === snapshot.publicTable.turn.currentPlayerId,
  );
  const currentPlayerName = currentPlayer?.displayName ?? "게임 진행 중";
  const phaseName = phaseNames[snapshot.publicTable.turn.phase] ?? "진행 중";
  const isEliminated = snapshot.viewer.mode === "eliminated_observer";
  const discardTop = snapshot.publicTable.publicDiscard.topCard;

  return (
    <section className="game-table" aria-labelledby="game-table-title">
      <header className="game-table__header">
        <div>
          <p className="game-table__eyebrow">기본판 · {players.length}명</p>
          <h1 id="game-table-title">게임 테이블</h1>
        </div>
        <span className="game-table__status">{statusNames[snapshot.status]}</span>
      </header>

      {isEliminated ? (
        <p className="game-table__observer-note" role="status">
          탈락한 플레이어로서 공개된 테이블을 보고 있습니다.
        </p>
      ) : null}

      <div className="game-table__surface">
        <div className="game-table__felt" aria-hidden="true" />

        <div className="game-table__center">
          <section className="game-table__turn" aria-label="현재 차례와 단계">
            <span className="game-table__center-label">현재 차례</span>
            <strong>{currentPlayerName}</strong>
            <span>{phaseName}</span>
          </section>

          <section className="game-table__discard" aria-label="버림더미">
            <span className="game-table__center-label">버림더미</span>
            {discardTop ? (
              <>
                <strong>{cardNames[discardTop.typeId] ?? "공개 카드"}</strong>
                <span aria-label={`${discardTop.rank} ${suitNames[discardTop.suit]}`}>
                  {discardTop.rank} {suitMarks[discardTop.suit]}
                </span>
              </>
            ) : (
              <span>아직 버린 카드가 없어요</span>
            )}
            <span>{snapshot.publicTable.publicDiscard.count}장</span>
          </section>

          <section className="game-table__deck" aria-label="남은 덱 카드 수">
            <span className="game-table__center-label">남은 덱</span>
            <strong>{snapshot.publicTable.deckCount}장</strong>
          </section>
        </div>

        <ol className="game-table__seats" aria-label="플레이어 좌석">
          {players.map(({ player, relativeIndex }) => (
            <PlayerSeat
              key={player.playerId}
              player={player}
              relativeIndex={relativeIndex}
              playerCount={players.length}
              isViewer={player.playerId === snapshot.viewer.playerId}
              isCurrentTurn={player.playerId === snapshot.publicTable.turn.currentPlayerId}
              ownRole={
                player.playerId === snapshot.viewer.playerId
                  ? activeSelfPrivate?.role ?? null
                  : null
              }
            />
          ))}
        </ol>
      </div>

      {activeSelfPrivate ? (
        <section className="game-table__own-hand" aria-labelledby="own-hand-title">
          <div className="game-table__own-hand-heading">
            <div>
              <p className="game-table__eyebrow">나만 볼 수 있어요</p>
              <h2 id="own-hand-title">내 손패</h2>
            </div>
            <span>{activeSelfPrivate.hand.length}장</span>
          </div>
          {activeSelfPrivate.hand.length > 0 ? (
            <ul className="game-table__hand-list" aria-label="내 손패 카드">
              {activeSelfPrivate.hand.map((card, index) => (
                <li key={`${card.typeId}-${card.rank}-${card.suit}-${index}`}>
                  <SafeCardText card={card} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="game-table__empty-hand">손패가 비어 있어요.</p>
          )}
        </section>
      ) : null}
    </section>
  );
}

function PlayerSeat({
  player,
  relativeIndex,
  playerCount,
  isViewer,
  isCurrentTurn,
  ownRole,
}: {
  player: PublicPlayerView;
  relativeIndex: number;
  playerCount: number;
  isViewer: boolean;
  isCurrentTurn: boolean;
  ownRole: RoleId | null;
}) {
  const role = player.role ?? ownRole;
  const characterName = characterNames[player.characterId] ?? "인물 카드";
  const accessibleName = [
    isViewer ? "내 자리" : `${player.displayName} 자리`,
    characterName,
    `${player.hp}/${player.maxHp} 생명력`,
    role ? `공개 역할 ${roleNames[role]}` : "역할 비공개",
    `손패 ${player.handCount}장`,
    isCurrentTurn ? "현재 차례" : null,
    player.eliminated ? "탈락" : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <li
      className={[
        "game-table__seat",
        isViewer ? "game-table__seat--viewer" : "",
        isCurrentTurn ? "game-table__seat--turn" : "",
        player.eliminated ? "game-table__seat--eliminated" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={seatPosition(relativeIndex, playerCount)}
    >
      <article className="game-table__seat-card" aria-label={accessibleName}>
        <div className="game-table__seat-heading">
          <div className="game-table__player-name">
            {isViewer ? <span className="game-table__you-label">내 자리</span> : null}
            <strong>{player.displayName}</strong>
          </div>
          {isCurrentTurn ? <span className="game-table__turn-badge">현재 차례</span> : null}
        </div>

        <p className="game-table__character">{characterName}</p>

        <div className="game-table__health" aria-label={`생명력 ${player.hp}/${player.maxHp}`}>
          <span aria-hidden="true">♥</span>
          <strong>{player.hp}</strong>
          <span className="game-table__health-max">/ {player.maxHp}</span>
        </div>

        <div className="game-table__seat-meta">
          <span>{role ? `역할 · ${roleNames[role]}` : "역할 비공개"}</span>
          <span>손패 {player.handCount}장</span>
        </div>

        <div className="game-table__in-play">
          <span className="game-table__seat-caption">장착 카드</span>
          {player.inPlay.length > 0 ? (
            <ul aria-label={`${player.displayName}의 공개 장착 카드`}>
              {player.inPlay.map((card, index) => (
                <li key={`${card.typeId}-${card.rank}-${card.suit}-${index}`}>
                  {cardNames[card.typeId] ?? "테이블 카드"}
                </li>
              ))}
            </ul>
          ) : (
            <span className="game-table__no-equipment">없음</span>
          )}
        </div>

        {player.eliminated ? (
          <span className="game-table__eliminated-label">탈락</span>
        ) : null}
      </article>
    </li>
  );
}

function SafeCardText({ card }: { card: CardFaceView }) {
  const cardName = cardNames[card.typeId] ?? "카드";
  return (
    <span aria-label={`${cardName}, ${card.rank} ${suitNames[card.suit]}`}>
      <strong>{cardName}</strong>
      <span>{card.rank} {suitMarks[card.suit]}</span>
    </span>
  );
}

function orderPlayersForViewer(snapshot: MatchSnapshotView): PositionedPlayer[] {
  const count = snapshot.publicTable.players.length;
  return snapshot.publicTable.players
    .map((player) => ({
      player,
      relativeIndex: (player.seatIndex - snapshot.viewer.seatIndex + count) % count,
    }))
    .sort((first, second) => first.relativeIndex - second.relativeIndex);
}

function seatPosition(relativeIndex: number, playerCount: number): CSSProperties {
  const angle = (2 * Math.PI * relativeIndex) / playerCount;
  const left = 50 + 37 * Math.sin(angle);
  const top = 50 + 36 * Math.cos(angle);
  return {
    left: `${left.toFixed(3)}%`,
    top: `${top.toFixed(3)}%`,
  };
}
