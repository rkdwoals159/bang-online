import { useEffect, useRef, type CSSProperties } from "react";
import { circleSeatPosition, viewerDistance } from "./layout.js";
import { playSeatMotion } from "../experience/motion.js";
import { GameExperienceControls, TableEffects, useGameExperience } from "../experience/GameExperience.js";
import { cardName } from "../actions/model.js";
import { CharacterPortrait } from "../cards/CardFaces.js";
import { AppIcon } from "../../components/AppIcon.js";
import type {
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
  const livingPlayers = players.filter(({ player }) => !player.eliminated);
  const eliminatedPlayers = players.filter(({ player }) => player.eliminated);
  const surface = useRef<HTMLDivElement>(null);
  const activeSelfPrivate = snapshot.viewer.mode === "active" ? snapshot.selfPrivate : null;
  const pending = snapshot.pendingInteraction;
  const responderId = pending && "currentResponderPlayerId" in pending ? pending.currentResponderPlayerId : null;
  const responseLabel = pending?.kind === "GENERAL_STORE_PICK" ? "카드 선택 중" : pending?.kind === "DEATH_RESCUE" ? "생명력 구제 중" : "응답 중";
  const isEliminated = snapshot.viewer.mode === "eliminated_observer";

  return (
    <section className="game-table" aria-labelledby="game-table-title">
      <header className="game-table__header">
        <div>
          <h1 id="game-table-title">게임 테이블</h1>
        </div>
        <GameExperienceControls />
        {snapshot.status !== "playing" ? <span className="game-table__status">{statusNames[snapshot.status]}</span> : null}
      </header>

      {isEliminated ? (
        <p className="game-table__observer-note sr-only" role="status">
          탈락한 플레이어로서 공개된 테이블을 보고 있습니다.
        </p>
      ) : null}

      <div className="game-table__scroll" aria-label="원형 테이블, 좁은 화면에서는 좌우로 이동할 수 있습니다" tabIndex={0}>
      <div className="game-table__surface" ref={surface}>
        <div className="game-table__felt" aria-hidden="true" />
        <div className="game-table__circle-center" aria-hidden="true"><strong>BANG!</strong><span>시계 방향으로 진행</span></div>

        <ol className="game-table__seats" aria-label="플레이어 좌석">
          {livingPlayers.map(({ player }, index) => (
            <PlayerSeat
              key={player.playerId}
              player={player}
              position={circleSeatPosition(index, livingPlayers.length)}
              distance={viewerDistance(snapshot, player)}
              responseLabel={player.playerId === responderId ? responseLabel : undefined}
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
        <TableEffects surface={surface} />
      </div>
      </div>
      {eliminatedPlayers.length > 0 ? <ol className="game-table__eliminated-seats" aria-label="탈락한 플레이어">
        {eliminatedPlayers.map(({ player }) => <PlayerSeat key={player.playerId} player={player} isViewer={player.playerId === snapshot.viewer.playerId} isCurrentTurn={false} ownRole={player.playerId === snapshot.viewer.playerId ? activeSelfPrivate?.role ?? null : null} />)}
      </ol> : null}

    </section>
  );
}

function PlayerSeat({
  player,
  isViewer,
  isCurrentTurn,
  ownRole,
  responseLabel,
  position,
  distance,
}: {
  player: PublicPlayerView;
  isViewer: boolean;
  isCurrentTurn: boolean;
  ownRole: RoleId | null;
  responseLabel?: string;
  position?: CSSProperties;
  distance?: number | null;
}) {
  const experience = useGameExperience();
  const cue = experience?.cue;
  const seat = useRef<HTMLElement>(null);
  const effect = cue?.targetIds.includes(player.playerId) ? cue.kind : cue?.actorId === player.playerId ? "source" : undefined;
  const motionAllowed = experience?.motionAllowed ?? false;
  useEffect(() => {
    if (seat.current) return playSeatMotion(seat.current, effect, motionAllowed);
  }, [cue?.id, effect, motionAllowed]);
  const target = experience?.targeting;
  const canTarget = target?.playerIds.includes(player.playerId) ?? false;
  const selected = canTarget && target?.selectedPlayerId === player.playerId;
  const role = player.role ?? ownRole;
  const characterName = characterNames[player.characterId] ?? "인물 카드";
  const accessibleName = [
    isViewer ? "내 자리" : `${player.displayName} 자리`,
    characterName,
    `${player.hp}/${player.maxHp} 생명력`,
    role ? `${player.role ? "공개 역할" : "내 역할"} ${roleNames[role]}` : "역할 비공개",
    `손패 ${player.handCount}장`,
    isCurrentTurn ? "현재 차례" : null,
    player.eliminated ? "탈락" : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <li
      style={position}
      className={[
        "game-table__seat",
        isViewer ? "game-table__seat--viewer" : "",
        isCurrentTurn ? "game-table__seat--turn" : "",
        player.eliminated ? "game-table__seat--eliminated" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <article ref={seat} className="game-table__seat-card" aria-label={accessibleName}
        data-player-seat={player.playerId}
        data-effect={effect}
        data-target={canTarget ? selected ? "selected" : "available" : undefined}>
        <CharacterPortrait characterId={player.characterId} />
        <div className="game-table__seat-heading">
          <div className="game-table__player-name">
            {isViewer ? <span className="game-table__you-label">내 자리</span> : null}
            <strong>{player.displayName}</strong>
          </div>
          {isCurrentTurn && !responseLabel ? <span className="game-table__turn-badge">현재 차례</span> : null}
        </div>

        <p className="game-table__character">{characterName}</p>
        {distance !== undefined && distance !== null ? <span className="game-table__distance" aria-label={`나에게서 거리 ${distance}`}>거리 {distance}</span> : null}
        {responseLabel ? <span className="game-table__response-badge">{responseLabel}</span> : null}

        <div key={player.hp} className="game-table__health" aria-label={`생명력 ${player.hp}/${player.maxHp}`}>
          <AppIcon name="heart" />
          <strong>{player.hp}</strong>
          <span className="game-table__health-max">/ {player.maxHp}</span>
        </div>

        <div className="game-table__seat-meta">
          <span>{role ? `역할 · ${roleNames[role]}` : "역할 비공개"}</span>
          <span className="game-table__hand" role="img" aria-label={`손패 ${player.handCount}장`} style={{ "--hand-count": Math.max(1, Math.min(80, player.handCount)) } as CSSProperties}>
            {player.handCount === 0 ? <span>패 없음</span> : Array.from({ length: Math.min(80, player.handCount) }, (_, index) => <i key={index} className="game-table__hand-card" aria-hidden="true" />)}
          </span>
        </div>

        <div className="game-table__in-play">
          <span className="game-table__seat-caption">장착 카드</span>
          {player.inPlay.length > 0 ? (
            <ul aria-label={`${player.displayName}의 공개 장착 카드`}>
              {player.inPlay.map((card, index) => (
                <li key={`${card.typeId}-${card.rank}-${card.suit}-${index}`}>
                  {cardName(card.typeId)}
                </li>
              ))}
            </ul>
          ) : (
            <span className="game-table__no-equipment">없음</span>
          )}
        </div>

        {canTarget ? <button type="button" className="game-table__choose-target" aria-pressed={selected} aria-label={`${player.displayName} 대상 선택`} onClick={() => target?.choosePlayer(player.playerId)}>{selected ? "선택된 대상" : "이 플레이어 선택"}</button> : null}

        {player.eliminated ? (
          <span className="game-table__eliminated-label">탈락</span>
        ) : null}
      </article>
    </li>
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

