import type { ReactNode } from "react";
import type { MatchSnapshotView, TablewideAttackView } from "../../../../../packages/contracts/src/protocol.js";
import { getPlayingCardDescription } from "../cards/CardFaces.js";
import { tablewideResponseLabel } from "./tablewide-presentation.js";

export function TablewideAttackStage({attack,snapshot,finished=false,children}: {attack:TablewideAttackView;snapshot:MatchSnapshotView;finished?:boolean;children?:ReactNode}) {
  return <>
    <section className="tablewide-stage__effect" aria-label="카드 효과">
      <p>{getPlayingCardDescription(attack.kind)}</p>
    </section>
    {!finished ? <p className="tablewide-stage__hint">순서를 기다리지 않고 각자 대응을 선택하세요.</p> : null}
    {children}
    <ul className="tablewide-stage__players" aria-label={finished ? "광역 공격 대응 결과" : "광역 공격 대응 상황"} aria-live="polite">
      {attack.targets.map(target => {
        const player=snapshot.publicTable.players.find(player=>player.playerId === target.playerId);
        return <li key={target.playerId} data-response-status={target.status}><strong title={player?.displayName}>{target.playerId === snapshot.viewer.playerId ? "나" : player?.displayName ?? "플레이어"}</strong><span className="tablewide-stage__response">{tablewideResponseLabel(target,snapshot.pendingInteraction)}</span><span>현재 체력 {player?.hp ?? 0}</span></li>;
      })}
    </ul>
  </>;
}
