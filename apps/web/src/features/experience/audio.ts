import type { CueKind } from "./model.js";

/** Small original synthesized effects; no downloads or sound-library dependency. */
export class GameAudio {
  private context: AudioContext | null = null;
  private output: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private enabled = true;
  private visible = true;
  private sources = new Set<AudioScheduledSourceNode>();
  private stopSources(): void { for (const source of this.sources) { try { source.stop(); } catch { /* Already ended. */ } } this.sources.clear(); }
  setVisible(value: boolean): void {
    this.visible = value;
    if (!value) this.stopSources();
    if (this.output && this.context) this.output.gain.setValueAtTime(value && this.enabled ? .22 : 0, this.context.currentTime);
  }
  setEnabled(value: boolean): void {
    this.enabled = value;
    if (!value) this.stopSources();
    if (this.output && this.context) this.output.gain.setValueAtTime(value && this.visible ? .22 : 0, this.context.currentTime);
  }
  unlock(): void {
    if (!this.enabled || typeof window === "undefined") return;
    try {
      if (!this.context) {
        const Audio = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Audio) return;
        this.context = new Audio();
        this.output = this.context.createGain(); this.output.gain.value = this.visible ? .22 : 0;
        this.output.connect(this.context.destination);
        this.noise = this.context.createBuffer(1, Math.ceil(this.context.sampleRate * .6), this.context.sampleRate);
        const data = this.noise.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      }
      if (this.context.state === "suspended") void this.context.resume().catch(() => {});
    } catch { /* Audio support must never block a game action. */ }
  }
  play(kind: CueKind): boolean {
    if (!this.enabled || !this.visible || !this.context || this.context.state !== "running" || !this.output || (typeof document !== "undefined" && document.hidden)) return false;
    const t = this.context.currentTime;
    try {
      if (kind === "shot" || kind === "burst" || kind === "explosion") {
        const count = kind === "burst" ? 5 : 1;
        for (let i = 0; i < count; i++) { this.hiss(t + i * .105, kind === "explosion" ? .5 : .13, kind === "explosion" ? 480 : 1800); this.tone(t + i * .105, 110, .13, "triangle", 40); }
      } else if (kind === "block") { this.tone(t, 1800, .27, "sine", 900); this.tone(t + .012, 2800, .18, "sine", 1400); }
      else if (kind === "hit" || kind === "eliminated") this.tone(t, 150, .23, "triangle", 55);
      else if (kind === "heal" || kind === "victory") [523,659,784,...(kind === "victory" ? [1047] : [])].forEach((f,i) => this.tone(t+i*.09, f, .2, "sine"));
      else if (kind === "turn") { this.tone(t, 660, .1, "sine"); this.tone(t + .11, 880, .15, "sine"); }
      else if (kind === "duel" || kind === "threat") { this.tone(t, 220, .25, "triangle"); this.tone(t+.13, 196, .3, "triangle"); }
      else this.hiss(t, .07, 4200);
      return true;
    } catch { return false; /* Keep visual feedback when sound is unavailable. */ }
  }
  private tone(start: number, frequency: number, duration: number, type: OscillatorType, endFrequency = frequency): void {
    const c = this.context!, oscillator = c.createOscillator(), gain = c.createGain();
    oscillator.type = type; oscillator.frequency.setValueAtTime(frequency, start); oscillator.frequency.exponentialRampToValueAtTime(endFrequency, start + duration);
    gain.gain.setValueAtTime(.001, start); gain.gain.exponentialRampToValueAtTime(.45, start + .004); gain.gain.exponentialRampToValueAtTime(.001, start + duration);
    if (this.sources.size >= 24) return;
    this.sources.add(oscillator);
    oscillator.connect(gain); gain.connect(this.output!); oscillator.onended = () => { this.sources.delete(oscillator); oscillator.disconnect(); gain.disconnect(); }; oscillator.start(start); oscillator.stop(start + duration + .02);
  }
  private hiss(start: number, duration: number, frequency: number): void {
    const c = this.context!, source = c.createBufferSource(), filter = c.createBiquadFilter(), gain = c.createGain();
    source.buffer = this.noise; filter.type = "lowpass"; filter.frequency.value = frequency;
    gain.gain.setValueAtTime(.7, start); gain.gain.exponentialRampToValueAtTime(.001, start + duration);
    if (this.sources.size >= 24) return;
    this.sources.add(source);
    source.connect(filter); filter.connect(gain); gain.connect(this.output!); source.onended = () => { this.sources.delete(source); source.disconnect(); filter.disconnect(); gain.disconnect(); }; source.start(start); source.stop(start + duration);
  }
  dispose(): void { this.stopSources(); if (this.context) void this.context.close().catch(() => {}); this.context = null; this.output = null; this.noise = null; }
}
