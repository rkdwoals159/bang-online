import { useEffect, useRef, useState } from "react";
import type { MatchSnapshotView, PublicMatchEvent, TablewideAttackView } from "../../../../../packages/contracts/src/protocol.js";
import { finishTablewideAttack } from "./tablewide-presentation.js";

/** Brief final feedback, cleared by the next game action; never blocks inputs. */
export function useTablewideSummary(version:number,snapshot:MatchSnapshotView,events:readonly PublicMatchEvent[]) {
  const previous=useRef<{attack:TablewideAttackView;eventSeq:number}|null>(null);
  const finishedVersion=useRef<number|null>(null);
  const [summary,setSummary]=useState<TablewideAttackView|null>(null);
  useEffect(()=>{
    const attack=snapshot.publicTable.tablewideAttack;
    if(attack){previous.current={attack,eventSeq:Math.max(0,...events.map(event=>event.eventSeq))};setSummary(null);return;}
    const before=previous.current;previous.current=null;
    if(before && snapshot.status === "playing" && !snapshot.pendingInteraction){
      finishedVersion.current=version;setSummary(finishTablewideAttack(before.attack,snapshot,events,before.eventSeq));
    }else if(snapshot.pendingInteraction || snapshot.status !== "playing" || finishedVersion.current !== version)setSummary(null);
  },[version,snapshot,events]);
  useEffect(()=>{if(!summary)return;const timer=window.setTimeout(()=>setSummary(null),5000);return()=>window.clearTimeout(timer);},[summary]);
  return summary;
}
