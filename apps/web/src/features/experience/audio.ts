import type { SoundKind } from "./model.js";

/** Small original synthesized effects; no downloads or sound-library dependency. */
export class GameAudio {
  private context: AudioContext | null = null;
  private output: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private enabled = true;
  private visible = true;
  private volume = .7;
  private sources = new Set<AudioScheduledSourceNode>();
  private stopSources(): void { for (const source of this.sources) { try { source.stop(); } catch { /* Already ended. */ } } this.sources.clear(); }
  setVisible(value: boolean): void {
    this.visible = value;
    if (!value) this.stopSources();
    this.updateGain();
  }
  setEnabled(value: boolean): void {
    this.enabled = value;
    if (!value) this.stopSources();
    this.updateGain();
  }
  setVolume(value: number): void {
    if (!Number.isFinite(value)) return;
    this.volume = Math.max(0, Math.min(1, value));
    if (this.volume === 0) this.stopSources();
    this.updateGain();
  }
  private updateGain(): void {
    if (this.output && this.context) this.output.gain.setValueAtTime(this.enabled && this.visible ? .3 * this.volume : 0, this.context.currentTime);
  }
  unlock(): void {
    if (!this.enabled || typeof window === "undefined") return;
    try {
      if (!this.context) {
        const Audio = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Audio) return;
        this.context = new Audio();
        this.output = this.context.createGain(); this.output.gain.value = this.visible ? .3 * this.volume : 0;
        this.output.connect(this.context.destination);
        this.noise = this.context.createBuffer(1, Math.ceil(this.context.sampleRate * .6), this.context.sampleRate);
        const data = this.noise.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      }
      if (this.context.state === "suspended") void this.context.resume().catch(() => {});
    } catch { /* Audio support must never block a game action. */ }
  }
  play(kind: SoundKind, offset = 0, count = 1): boolean {
    if (!this.enabled || !this.visible || this.volume === 0 || !this.context || this.context.state !== "running" || !this.output || this.sources.size >= 48 || (typeof document !== "undefined" && document.hidden)) return false;
    const t = this.context.currentTime + (Number.isFinite(offset) ? Math.max(0, Math.min(.6, offset)) : 0);
    const cards = Number.isFinite(count) ? Math.max(1, Math.min(4, Math.floor(count))) : 1;
    try {
      if (kind === "shot" || kind === "burst" || kind === "explosion") {
        const count = kind === "burst" ? 5 : 1;
        for (let i = 0; i < count; i++) { this.hiss(t + i * .105, kind === "explosion" ? .65 : .13, kind === "explosion" ? 780 : 1800); this.tone(t + i * .105, kind === "explosion" ? 95 : 110, kind === "explosion" ? .45 : .13, "triangle", kind === "explosion" ? 28 : 40); }
      } else if (kind === "block") { this.tone(t, 1800, .27, "sine", 900); this.tone(t + .012, 2800, .18, "sine", 1400); }
      else if (kind === "hit") { this.hiss(t, .09, 650); this.tone(t, 150, .23, "triangle", 55); }
      else if (kind === "eliminated") [220,165,110].forEach((f,i)=>this.tone(t+i*.13,f,.23,"triangle",f*.8));
      else if (kind === "heal") [523,659,784].forEach((f,i) => this.tone(t+i*.09, f, .2, "sine"));
      else if (kind === "victory") [392,523,659,784,1047].forEach((f,i)=>this.tone(t+i*.13,f,.32,"triangle"));
      else if (kind === "turn") { this.tone(t, 660, .1, "sine"); this.tone(t + .11, 880, .15, "sine"); }
      else if (kind === "duel") { this.tone(t, 220, .25, "triangle"); this.tone(t+.13, 196, .3, "triangle"); }
      else if (kind === "threat") [100,125,100].forEach((f,i)=>{this.hiss(t+i*.12,.06,500);this.tone(t+i*.12,f,.1,"triangle",55);});
      else if (kind === "draw") for(let i=0;i<cards;i++){this.hiss(t+i*.07,.055,3600+i*250,.26,"bandpass");this.tone(t+i*.07,370+i*20,.045,"triangle",220,.1);}
      else if (kind === "play") { this.hiss(t,.07,2400,.25,"bandpass");this.tone(t+.045,180,.085,"triangle",85,.28); }
      else if (kind === "discard") { this.hiss(t,.12,3100,.3,"bandpass");this.hiss(t+.05,.09,1400,.2); }
      else if (kind === "equip") { this.tone(t,280,.06,"triangle",120,.3);this.tone(t+.08,750,.09,"sine",520,.24); }
      else if (kind === "reload") { this.hiss(t,.04,4500,.3,"highpass");this.tone(t,1200,.065,"square",480,.15);this.hiss(t+.09,.05,2100,.25);this.tone(t+.1,600,.09,"triangle",220,.25); }
      else if (kind === "jail") [0,.075,.15].forEach((delay,i)=>this.tone(t+delay,980+i*190,.15,"sine",450,.24));
      else if (kind === "fuse") { this.hiss(t,.32,5400,.22,"highpass");this.tone(t,180,.18,"triangle",90,.17); }
      else if (kind === "pass") { this.hiss(t,.1,1800,.25,"bandpass");this.tone(t+.04,350,.18,"sine",190,.18); }
      else if (kind === "pick") { this.hiss(t,.065,3800,.23,"bandpass");this.tone(t+.04,620,.085,"sine",820,.22); }
      else if (kind === "store") { [0,.06,.12,.18].forEach((delay,i)=>this.hiss(t+delay,.075,2200+i*400,.2,"bandpass"));[659,880].forEach((f,i)=>this.tone(t+.22+i*.1,f,.22,"sine",f,.28)); }
      else if (kind === "judgment") { this.hiss(t,.06,2800,.25,"bandpass");this.tone(t+.07,440,.12,"triangle",330,.2); }
      else if (kind === "drink") { this.tone(t,900,.12,"sine",1300,.25);[0,.06,.12].forEach((delay,i)=>this.tone(t+.06+delay,320+i*80,.06,"sine",170,.2)); }
      else if (kind === "escape") [440,660,880].forEach((f,i)=>this.tone(t+i*.075,f,.17,"triangle",f,.25));
      else if (kind === "jail_skip") { this.tone(t,330,.15,"triangle",220,.27);this.tone(t+.14,220,.22,"triangle",110,.27); }
      else if (kind === "ability") { this.tone(t,440,.15,"sine",880,.25);this.tone(t+.1,660,.18,"sine",990,.2); }
      return true;
    } catch { return false; /* Keep visual feedback when sound is unavailable. */ }
  }
  private tone(start: number, frequency: number, duration: number, type: OscillatorType, endFrequency = frequency, amplitude = .45): void {
    if (this.sources.size >= 48) return;
    const c = this.context!, oscillator = c.createOscillator(), gain = c.createGain();
    oscillator.type = type; oscillator.frequency.setValueAtTime(frequency, start); oscillator.frequency.exponentialRampToValueAtTime(endFrequency, start + duration);
    gain.gain.setValueAtTime(.001, start); gain.gain.exponentialRampToValueAtTime(amplitude, start + .004); gain.gain.exponentialRampToValueAtTime(.001, start + duration);
    this.sources.add(oscillator);
    oscillator.connect(gain); gain.connect(this.output!); oscillator.onended = () => { this.sources.delete(oscillator); oscillator.disconnect(); gain.disconnect(); }; oscillator.start(start); oscillator.stop(start + duration + .02);
  }
  private hiss(start: number, duration: number, frequency: number, amplitude = .7, type: BiquadFilterType = "lowpass"): void {
    if (this.sources.size >= 48) return;
    const c = this.context!, source = c.createBufferSource(), filter = c.createBiquadFilter(), gain = c.createGain();
    source.buffer = this.noise; filter.type = type; filter.frequency.value = frequency;
    gain.gain.setValueAtTime(amplitude, start); gain.gain.exponentialRampToValueAtTime(.001, start + duration);
    this.sources.add(source);
    source.connect(filter); filter.connect(gain); gain.connect(this.output!); source.onended = () => { this.sources.delete(source); source.disconnect(); filter.disconnect(); gain.disconnect(); }; source.start(start); source.stop(start + duration);
  }
  dispose(): void { this.stopSources(); if (this.context) void this.context.close().catch(() => {}); this.context = null; this.output = null; this.noise = null; }
}
