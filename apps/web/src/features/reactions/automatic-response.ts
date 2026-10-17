import type { MatchSnapshotView, PendingRespondOption } from "../../../../../packages/contracts/src/protocol.js";
import { responderPromptFor } from "./model.js";

export interface AutomaticResponsePreferences { indiansBang: boolean; attackMissed: boolean; barrelFirst: boolean }
export const DEFAULT_AUTOMATIC_RESPONSES: Readonly<AutomaticResponsePreferences> = Object.freeze({indiansBang:false,attackMissed:false,barrelFirst:false});
export const AUTOMATIC_RESPONSE_STORAGE_KEY = "bang:automatic-responses:v1";

export function parseAutomaticResponsePreferences(raw: string | null): AutomaticResponsePreferences {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {...DEFAULT_AUTOMATIC_RESPONSES};
    const row=value as Record<string,unknown>;
    return {indiansBang:row.indiansBang===true,attackMissed:row.attackMissed===true,barrelFirst:row.barrelFirst===true};
  } catch {return {...DEFAULT_AUTOMATIC_RESPONSES};}
}

/** Select an exact legal server option; never synthesize a hit, rescue, Duel, or judgment choice. */
export function automaticResponseFor(snapshot: MatchSnapshotView, preferences: AutomaticResponsePreferences): PendingRespondOption | null {
  if (snapshot.status !== "playing" || snapshot.viewer.mode !== "active") return null;
  const pending=responderPromptFor(snapshot);
  if (!pending) return null;
  const options=pending.responseOptions;
  if (pending.kind === "BANG_RESPONSE" || pending.kind === "GATLING_RESPONSE") {
    if (preferences.barrelFirst) {
      const barrel=options.find(option=>option.choice==="USE_BARREL");
      if (barrel) return barrel;
    }
    if (preferences.attackMissed) return options.find(option=>option.choice==="USE_MISSED") ?? null;
  }
  if (pending.kind === "INDIANS_RESPONSE" && preferences.indiansBang) return options.find(option=>option.choice==="USE_BANG") ?? null;
  return null;
}

/** The response controller owns uncertain-command retries with the same command ID. */
export function scheduleAutomaticResponse(key: string, gate: {current:string}, respond:()=>void, schedule = (callback:()=>void)=>setTimeout(callback,220), cancel = (timer:ReturnType<typeof setTimeout>)=>clearTimeout(timer)): (()=>void) | undefined {
  if (gate.current===key) return;
  let cancelled=false;
  const timer=schedule(()=>{if(cancelled||gate.current===key)return;gate.current=key;respond();});
  return ()=>{cancelled=true;cancel(timer);};
}
