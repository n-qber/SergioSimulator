/**
 * Motor de Áudio Web Audio API para o Sérgio Simulator
 * Arquitetura Pré-Renderizada com OfflineAudioContext:
 * - Toda a peça é pré-sintetizada diretamente na memória em ~5ms
 * - O playback é executado por AudioBufferSourceNode via hardware de som
 * - ZERO timers (sem setInterval, sem setTimeout, sem lookahead)
 * - Zero jitter, zero oscilações e transições instantâneas entre compassos
 */

class PercussionAudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.sourceNode = null;
    this.isMuted = false;
    this.volume = 0.8;
    this.soundType = "woodblock"; // 'woodblock', 'clave', 'click', 'beep'
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

  /**
   * Renderiza a peça inteira em memória usando OfflineAudioContext.
   * Executa em ~5 a 10ms em background.
   */
  async renderPieceBuffer(timings, totalDuration, soundType = this.soundType) {
    const sampleRate = 44100;
    // Margem de segurança de 0.4s no final para cauda do último ataque
    const safeDuration = Math.max(0.5, totalDuration + 0.4);
    const numSamples = Math.ceil(safeDuration * sampleRate);

    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const offlineCtx = new OfflineCtx(1, numSamples, sampleRate);

    if (timings && timings.length > 0) {
      for (let idx = 0; idx < timings.length; idx++) {
        const t = timings[idx];
        for (let b = 0; b < t.beats; b++) {
          const beatTime = t.startTime + (b * t.beatDuration);
          const isAccent = (b === 0);
          this.synthesizeSound(offlineCtx, offlineCtx.destination, beatTime, isAccent, soundType);
        }
      }
    }

    const renderedBuffer = await offlineCtx.startRendering();
    return renderedBuffer;
  }

  /**
   * Toca o buffer pré-renderizado a partir de um ponto no tempo (em segundos).
   */
  play(buffer, offset = 0, speed = 1.0, loop = false, loopEnd = 0, onEnded = null) {
    if (!this.ctx || !buffer) return;

    this.stop();

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = speed;
    source.loop = loop;
    if (loop) {
      source.loopStart = 0;
      source.loopEnd = loopEnd > 0 ? loopEnd : buffer.duration;
    }

    source.connect(this.masterGain);

    source.onended = () => {
      if (this.sourceNode === source) {
        this.sourceNode = null;
        if (onEnded) onEnded();
      }
    };

    const startOffset = Math.max(0, Math.min(buffer.duration - 0.001, offset));
    source.start(0, startOffset);
    this.sourceNode = source;
  }

  /**
   * Interrompe o playback do buffer
   */
  stop() {
    if (this.sourceNode) {
      try {
        this.sourceNode.stop();
      } catch (e) {
        // Ignora se já estiver parado
      }
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
  }

  /**
   * Atualiza a taxa de reprodução em tempo real no hardware
   */
  setPlaybackRate(speed) {
    if (this.sourceNode && this.sourceNode.playbackRate) {
      this.sourceNode.playbackRate.setValueAtTime(speed, this.ctx.currentTime);
    }
  }

  /**
   * Despacha a síntese de som para o contexto e destino fornecidos
   */
  synthesizeSound(ctx, dest, time, isAccent, soundType = this.soundType) {
    switch (soundType) {
      case "woodblock":
        this.synthWoodblock(ctx, dest, time, isAccent);
        break;
      case "clave":
        this.synthClave(ctx, dest, time, isAccent);
        break;
      case "beep":
        this.synthBeep(ctx, dest, time, isAccent);
        break;
      case "click":
      default:
        this.synthClick(ctx, dest, time, isAccent);
        break;
    }
  }

  synthWoodblock(ctx, dest, time, isAccent) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

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
    gain.connect(dest);

    osc.start(time);
    osc.stop(time + 0.08);
  }

  synthClave(ctx, dest, time, isAccent) {
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

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
    gain.connect(dest);

    osc1.start(time);
    osc2.start(time);
    osc1.stop(time + 0.045);
    osc2.stop(time + 0.045);
  }

  synthClick(ctx, dest, time, isAccent) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "triangle";
    osc.frequency.setValueAtTime(isAccent ? 1600 : 900, time);
    osc.frequency.exponentialRampToValueAtTime(150, time + 0.02);

    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(isAccent ? 1.0 : 0.6, time + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.025);

    osc.connect(gain);
    gain.connect(dest);

    osc.start(time);
    osc.stop(time + 0.03);
  }

  synthBeep(ctx, dest, time, isAccent) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(isAccent ? 1200 : 800, time);

    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(isAccent ? 0.8 : 0.45, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.035);

    osc.connect(gain);
    gain.connect(dest);

    osc.start(time);
    osc.stop(time + 0.04);
  }
}

export const audio = new PercussionAudioEngine();
