/**
 * Motor de Áudio Web Audio API para o Sérgio Simulator
 * Agendamento de alta precisão (Lookahead Scheduler) sem jitter ou drift de tempo.
 * Sintetizador dedicado a sons de percussão (Woodblock, Clave, Click de Estúdio).
 */

class PercussionAudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.isPlaying = false;
    this.isMuted = false;
    this.volume = 0.8;
    this.soundType = "woodblock"; // 'woodblock', 'clave', 'click', 'beep'

    // Lookahead scheduler settings
    this.lookaheadMs = 25.0; // Frequência do timer em ms
    this.scheduleAheadTime = 0.12; // Janela de agendamento em segundos (120ms)
    this.timerId = null;

    // Estado de reprodução
    this.currentPlaybackTime = 0; // Posição virtual na peça (segundos)
    this.playbackStartTime = 0;
    this.audioStartOffset = 0;
    this.lastScheduledBeatTime = -1;

    // Callbacks para sincronização visual
    this.onBeatListeners = new Set();
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(this.isMuted ? 0 : this.volume, this.ctx.currentTime);
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume();
    }
  }

  setVolume(val) {
    this.volume = Math.max(0, Math.min(1, parseFloat(val) || 0.8));
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(this.isMuted ? 0 : this.volume, this.ctx.currentTime);
    }
  }

  setMuted(muted) {
    this.isMuted = !!muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(this.isMuted ? 0 : this.volume, this.ctx.currentTime);
    }
  }

  setSoundType(type) {
    this.soundType = type;
  }

  onBeat(callback) {
    this.onBeatListeners.add(callback);
    return () => this.onBeatListeners.delete(callback);
  }

  notifyBeat(beatInfo) {
    for (const cb of this.onBeatListeners) {
      try {
        cb(beatInfo);
      } catch (e) {
        console.error("Erro no callback onBeat:", e);
      }
    }
  }

  /**
   * Síntese de percussão analógica usando nós nativos do Web Audio API
   */
  scheduleSound(time, isAccent = false) {
    if (!this.ctx || this.isMuted) return;

    switch (this.soundType) {
      case "woodblock":
        this.playWoodblock(time, isAccent);
        break;
      case "clave":
        this.playClave(time, isAccent);
        break;
      case "beep":
        this.playBeep(time, isAccent);
        break;
      case "click":
      default:
        this.playClick(time, isAccent);
        break;
    }
  }

  playWoodblock(time, isAccent) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();

    filter.type = "bandpass";
    const baseFreq = isAccent ? 1050 : 720;
    filter.frequency.setValueAtTime(baseFreq, time);
    filter.Q.setValueAtTime(12, time);

    osc.type = "sine";
    osc.frequency.setValueAtTime(baseFreq * 1.5, time);
    osc.frequency.exponentialRampToValueAtTime(baseFreq, time + 0.015);

    gain.gain.setValueAtTime(0.001, time);
    gain.gain.exponentialRampToValueAtTime(isAccent ? 1.0 : 0.65, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + (isAccent ? 0.08 : 0.055));

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);

    osc.start(time);
    osc.stop(time + 0.09);
  }

  playClave(time, isAccent) {
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    const freq1 = isAccent ? 2450 : 1900;
    const freq2 = isAccent ? 2900 : 2300;

    osc1.type = "sine";
    osc2.type = "sine";
    osc1.frequency.setValueAtTime(freq1, time);
    osc2.frequency.setValueAtTime(freq2, time);

    gain.gain.setValueAtTime(0.001, time);
    gain.gain.exponentialRampToValueAtTime(isAccent ? 0.9 : 0.55, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.045);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(this.masterGain);

    osc1.start(time);
    osc2.start(time);
    osc1.stop(time + 0.05);
    osc2.stop(time + 0.05);
  }

  playClick(time, isAccent) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = "triangle";
    osc.frequency.setValueAtTime(isAccent ? 1600 : 900, time);
    osc.frequency.exponentialRampToValueAtTime(200, time + 0.025);

    gain.gain.setValueAtTime(0.001, time);
    gain.gain.exponentialRampToValueAtTime(isAccent ? 1.0 : 0.6, time + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.03);

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(time);
    osc.stop(time + 0.035);
  }

  playBeep(time, isAccent) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(isAccent ? 1200 : 800, time);

    gain.gain.setValueAtTime(0.001, time);
    gain.gain.exponentialRampToValueAtTime(isAccent ? 0.8 : 0.45, time + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.04);

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(time);
    osc.stop(time + 0.045);
  }
}

export const audio = new PercussionAudioEngine();
