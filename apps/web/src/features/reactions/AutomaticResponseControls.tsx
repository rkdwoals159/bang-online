import { useEffect, useRef, useSyncExternalStore } from "react";
import type { MatchSnapshotView, PendingRespondOption } from "../../../../../packages/contracts/src/protocol.js";
import { AUTOMATIC_RESPONSE_STORAGE_KEY, DEFAULT_AUTOMATIC_RESPONSES, automaticResponseFor, parseAutomaticResponsePreferences, scheduleAutomaticResponse, type AutomaticResponsePreferences } from "./automatic-response.js";

const listeners=new Set<()=>void>();
let cachedRaw:string|null|undefined, cached=DEFAULT_AUTOMATIC_RESPONSES;
let memoryOnly=false;
function read() {
  if(typeof window==="undefined")return DEFAULT_AUTOMATIC_RESPONSES;
  if(memoryOnly)return cached;
  try{const raw=localStorage.getItem(AUTOMATIC_RESPONSE_STORAGE_KEY);if(raw!==cachedRaw){cachedRaw=raw;cached=parseAutomaticResponsePreferences(raw);}}catch{/* Keep the session setting when storage is unavailable. */}
  return cached;
}
function subscribe(listener:()=>void) {
  listeners.add(listener);
  const changed=(event:StorageEvent)=>{if(event.key===AUTOMATIC_RESPONSE_STORAGE_KEY||event.key===null)listener();};
  window.addEventListener("storage",changed);
  return ()=>{listeners.delete(listener);window.removeEventListener("storage",changed);};
}
function usePreferences(){return useSyncExternalStore(subscribe,read,()=>DEFAULT_AUTOMATIC_RESPONSES);}
function update(key:keyof AutomaticResponsePreferences,value:boolean){
  cached={...read(),[key]:value};cachedRaw=JSON.stringify(cached);
  try{localStorage.setItem(AUTOMATIC_RESPONSE_STORAGE_KEY,cachedRaw);}catch{memoryOnly=true;}
  for(const listener of listeners)listener();
}

export function AutomaticResponseControls(){
  const settings=usePreferences();
  const fields=[
    ["indiansBang","인디언!에 뱅! 자동 사용"],
    ["attackMissed","뱅!·개틀링에 빗나감! 자동 사용"],
    ["barrelFirst","뱅!·개틀링에 술통 먼저 자동 판정"],
  ] as const;
  return <fieldset className="automatic-responses"><legend>자동 대응</legend>
    {fields.map(([key,label])=><label key={key}><span>{label}</span><input type="checkbox" role="switch" checked={settings[key]} onChange={event=>update(key,event.target.checked)}/></label>)}
    <p>게임을 열어 둔 동안 적용돼요. 술통이 실패하면 켜 둔 카드 대응을 이어가고, 선택할 카드가 없으면 직접 대응해요.</p>
  </fieldset>;
}

export function AutomaticResponseController({matchId,version,snapshot,enabled,onRespond}:{matchId:string;version:number;snapshot:MatchSnapshotView;enabled:boolean;onRespond:(option:PendingRespondOption)=>void}){
  const preferences=usePreferences();
  const option=automaticResponseFor(snapshot,preferences);
  const callback=useRef(()=>{}),gate=useRef("");
  useEffect(()=>{callback.current=()=>{if(option)onRespond(option);};});
  const signature=option?JSON.stringify(option):"";
  useEffect(()=>{
    if(!enabled||!signature)return;
    const key=JSON.stringify([matchId,version,signature]);
    return scheduleAutomaticResponse(key,gate,()=>callback.current());
  },[matchId,version,signature,enabled]);
  return null;
}
