import { useEffect, useRef, useState, type FormEvent } from "react";
import { useOptionalAppState } from "../../app/app-state.js";
import { normalizeDisplayName } from "../room-entry/model.js";
import "./profile.css";

export function NicknameEditor({ displayName, onSave }: { displayName: string; onSave: (name: string) => Promise<void> }) {
  const [open, setOpen] = useState(false), [draft, setDraft] = useState(displayName);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const flight = useRef(false), mounted = useRef(true), summary = useRef<HTMLElement>(null);
  useEffect(() => { setDraft(displayName); }, [displayName]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function save(event: FormEvent) {
    event.preventDefault(); if (flight.current) return;
    let name: string;
    try { name = normalizeDisplayName(draft); } catch (issue) { setError(issue instanceof Error ? issue.message : "닉네임을 확인해 주세요."); return; }
    flight.current = true; setBusy(true); setError("");
    try { await onSave(name); if (mounted.current) { setOpen(false); summary.current?.focus(); } }
    catch { if (mounted.current) setError("닉네임을 바꾸지 못했어요. 다시 시도해 주세요."); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  return <details className="nickname-settings" open={open}>
    <summary ref={summary} onClick={event => { event.preventDefault(); setOpen(current => !current); }} aria-label={`닉네임 변경, 현재 ${displayName}`}><span>{displayName}</span><span>닉네임 변경</span></summary>
    <form onSubmit={event => void save(event)} aria-label="닉네임 변경" aria-busy={busy}>
      <label>닉네임<input name="nickname" value={draft} disabled={busy} autoComplete="nickname"
        onChange={event => setDraft(event.target.value)} aria-invalid={!!error} /></label>
      {error ? <p role="alert">{error}</p> : null}
      <div><button type="button" disabled={busy} onClick={() => { setOpen(false); setDraft(displayName); setError(""); summary.current?.focus(); }}>취소</button>
      <button type="submit" disabled={busy}>{busy ? "저장 중…" : "저장"}</button></div>
    </form>
  </details>;
}

export function NicknameSettings() {
  const app = useOptionalAppState();
  const guest = app?.sessionRecovery.kind === "ready" ? app.sessionRecovery.guest : null;
  return app && guest ? <NicknameEditor displayName={guest.player.displayName} onSave={app.changeNickname} /> : null;
}
