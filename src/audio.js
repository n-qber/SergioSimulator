/**
 * Motor de Áudio Web Audio API para o Sérgio Simulator
 * Agendamento de alta precisão (Lookahead Scheduler) sem jitter ou drift de tempo.
 * Sintetizador dedicado a sons de percussão (Woodblock, Clave, Click de Estúdio).
 */

class PercussionAudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.isMuted = false;
    this.volume = 0.8;
    this.soundType = "woodblock"; // 'woodblock', 'clave', 'click', 'beep'

    // Callbacks para sincronização visual
    this.onBeatListeners = new Set();
  }

  async init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx({ latencyHint: 'interactive' });
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(this.isMuted ? 0 : this.volume, this.ctx.currentTime);
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
    return this.ctx;
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
   * Síntese de percussão analógica com liberação limpa de nós de áudio (zero GC stutter)
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
    const baseFreq = isAccent ? 1080 : 740;
    filter.frequency.setValueAtTime(baseFreq, time);
    filter.Q.setValueAtTime(14, time);

    osc.type = "sine";
    osc.frequency.setValueAtTime(baseFreq * 1.6, time);
    osc.frequency.exponentialRampToValueAtTime(baseFreq, time + 0.012);

    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(isAccent ? 1.0 : 0.65, time + 0.0015);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + (isAccent ? 0.075 : 0.05));

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);

    osc.start(time);
    const stopTime = time + 0.08;
    osc.stop(stopTime);

    // Desconecta nós de áudio após finalização para evitar vazamento de memória e travamentos do GC
    osc.onended = () => {
      osc.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
  }

  playClave(time, isAccent) {
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    const freq1 = isAccent ? 2500 : 1950;
    const freq2 = isAccent ? 3000 : 2350;

    osc1.type = "sine";
    osc2.type = "sine";
    osc1.frequency.setValueAtTime(freq1, time);
    osc2.frequency.setValueAtTime(freq2, time);

    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(isAccent ? 0.9 : 0.55, time + 0.0015);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.04);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(this.masterGain);

    osc1.start(time);
    osc2.start(time);
    const stopTime = time + 0.045;
    osc1.stop(stopTime);
    osc2.stop(stopTime);

    osc1.onended = () => {
      osc1.disconnect();
      osc2.disconnect();
      gain.disconnect();
    };
  }

  playClick(time, isAccent) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = "triangle";
    osc.frequency.setValueAtTime(isAccent ? 1600 : 900, time);
    osc.frequency.exponentialRampToValueAtTime(150, time + 0.02);

    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(isAccent ? 1.0 : 0.6, time + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.025);

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(time);
    const stopTime = time + 0.03;
    osc.stop(stopTime);

    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  }

  playBeep(time, isAccent) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(isAccent ? 1200 : 800, time);

    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(isAccent ? 0.8 : 0.45, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.035);

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(time);
    const stopTime = time + 0.04;
    osc.stop(stopTime);

    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  }
}

export const audio = new PercussionAudioEngine();
