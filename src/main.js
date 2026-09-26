/**
 * Sérgio Simulator - Controlador Principal (Main)
 * Motor de tempo sample-accurate sem jitter, sem lentidão na troca de compassos e sem atraso no play.
 */

import { state } from './state.js';
import { audio } from './audio.js';
import { PRESETS } from './presets.js';
import { DJRunnerRenderer } from './renderer.js';

class SergioApp {
  constructor() {
    this.playbackTime = 0;
    this.isPlaying = false;
    this.loopEnabled = true;
    this.playbackSpeed = 1.0;
    
    // Motor de Áudio Pré-Renderizado (OfflineAudioContext)
    this.pieceAudioBuffer = null;
    this.isRenderingBuffer = false;
    this.pendingBufferRegen = false;
    this.audioAnchorTime = 0;
    this.pieceAnchorTime = 0;

    // Rastreamento de batimento para flash da agulha (zero timers)
    this.lastBeatMeasureIdx = -1;
    this.lastBeatIdx = -1;

    // Cache de performance de DOM
    this.cachedCards = [];
    this.lastHighlightedIdx = -1;
    this.lastBeatText = '';
    this.lastTotalBeats = -1;
    this.lastActiveBeatIdx = -1;

    // Tap tempo buffer
    this.tapTimes = [];
    this.dom = {};
  }

  init() {
    this.cacheDom();
    this.initRenderer();
    this.initEventListeners();
    this.initPresetsDropdown();
    this.renderMeasuresList();
    this.updateHUD(0);

    // Pré-gera a peça toda na memória RAM (~5ms)
    this.preparePieceAudio();

    // Pré-ativação do AudioContext no primeiro toque/clique do usuário
    const unlockAudio = () => {
      audio.init();
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };
    window.addEventListener('pointerdown', unlockAudio);
    window.addEventListener('keydown', unlockAudio);

    // Loop de renderização visual (requestAnimationFrame 60 FPS)
    this.lastFrameTime = performance.now();
    requestAnimationFrame((t) => this.renderLoop(t));
  }

  cacheDom() {
    this.dom = {
      // Header
      inputBaseBpm: document.getElementById('inputBaseBpm'),
      btnBpmMinus5: document.getElementById('btnBpmMinus5'),
      btnBpmMinus1: document.getElementById('btnBpmMinus1'),
      btnBpmPlus1: document.getElementById('btnBpmPlus1'),
      btnBpmPlus5: document.getElementById('btnBpmPlus5'),
      btnTapTempo: document.getElementById('btnTapTempo'),
      inputPieceName: document.getElementById('inputPieceName'),
      selectPreset: document.getElementById('selectPreset'),
      btnExport: document.getElementById('btnExport'),
      fileImport: document.getElementById('fileImport'),
      btnMute: document.getElementById('btnMute'),
      muteIcon: document.getElementById('muteIcon'),
      selectSoundType: document.getElementById('selectSoundType'),

      // HUD
      hudCurrentTime: document.getElementById('hudCurrentTime'),
      hudTotalTime: document.getElementById('hudTotalTime'),
      hudMeasureBadge: document.getElementById('hudMeasureBadge'),
      hudMeasureNickname: document.getElementById('hudMeasureNickname'),
      hudGroupPill: document.getElementById('hudGroupPill'),
      hudGroupName: document.getElementById('hudGroupName'),
      hudBeatText: document.getElementById('hudBeatText'),
      hudBeatDots: document.getElementById('hudBeatDots'),
      hudBpmValue: document.getElementById('hudBpmValue'),
      hudTempoRatio: document.getElementById('hudTempoRatio'),

      // DJ Canvas
      djCanvas: document.getElementById('djCanvas'),
      minimapCanvas: document.getElementById('minimapCanvas'),

      // Transporte
      btnPlayPause: document.getElementById('btnPlayPause'),
      playIcon: document.getElementById('playIcon'),
      pauseIcon: document.getElementById('pauseIcon'),
      btnStopRewind: document.getElementById('btnStopRewind'),
      btnPrevMeasure: document.getElementById('btnPrevMeasure'),
      btnNextMeasure: document.getElementById('btnNextMeasure'),
      btnLoop: document.getElementById('btnLoop'),
      speedBtns: document.querySelectorAll('.speed-opt'),
      btnAddMeasureQuick: document.getElementById('btnAddMeasureQuick'),
      btnManageGroups: document.getElementById('btnManageGroups'),
      btnAddMeasureBottom: document.getElementById('btnAddMeasureBottom'),
      btnOpenGroupModal: document.getElementById('btnOpenGroupModal'),

      // Lista de Compassos
      measuresGrid: document.getElementById('measuresGrid'),
      measureCountBadge: document.getElementById('measureCountBadge'),

      // Modal de Compasso
      modalMeasureEdit: document.getElementById('modalMeasureEdit'),
      btnModalClose: document.getElementById('btnModalClose'),
      formMeasureEdit: document.getElementById('formMeasureEdit'),
      editMeasureIndex: document.getElementById('editMeasureIndex'),
      modalMeasureIdx: document.getElementById('modalMeasureIdx'),
      editNickname: document.getElementById('editNickname'),
      editBeats: document.getElementById('editBeats'),
      editBeatUnit: document.getElementById('editBeatUnit'),
      radioModeRatio: document.getElementById('radioModeRatio'),
      radioModeFixed: document.getElementById('radioModeFixed'),
      panelTempoRatio: document.getElementById('panelTempoRatio'),
      panelTempoFixed: document.getElementById('panelTempoFixed'),
      editRatioNum: document.getElementById('editRatioNum'),
      editRatioDen: document.getElementById('editRatioDen'),
      calcEffectiveBpm: document.getElementById('calcEffectiveBpm'),
      editCustomBpm: document.getElementById('editCustomBpm'),
      editColorPicker: document.getElementById('editColorPicker'),
      btnDeleteMeasureModal: document.getElementById('btnDeleteMeasureModal'),
      btnDuplicateMeasureModal: document.getElementById('btnDuplicateMeasureModal'),

      // Modal de Grupos
      modalGroupManage: document.getElementById('modalGroupManage'),
      btnGroupModalClose: document.getElementById('btnGroupModalClose'),
      formCreateGroup: document.getElementById('formCreateGroup'),
      newGroupName: document.getElementById('newGroupName'),
      newGroupStart: document.getElementById('newGroupStart'),
      newGroupEnd: document.getElementById('newGroupEnd'),
      newGroupColorPicker: document.getElementById('newGroupColorPicker'),
      existingGroupsList: document.getElementById('existingGroupsList')
    };
  }

  initRenderer() {
    this.renderer = new DJRunnerRenderer(
      this.dom.djCanvas,
      this.dom.minimapCanvas,
      state,
      (seekSeconds) => this.seekTo(seekSeconds)
    );
  }

  // =========================================================================
  // MOTOR DE ÁUDIO PRÉ-RENDERIZADO (OFFLINE AUDIO BUFFER)
  // Sem timers (zero setInterval/setTimeout). A peça inteira é sintetizada
  // na memória e tocada diretamente pelo hardware de áudio.
  // =========================================================================

  async preparePieceAudio(forceRestart = false) {
    if (this.isRenderingBuffer) {
      this.pendingBufferRegen = true;
      return;
    }
    this.isRenderingBuffer = true;

    try {
      this.pieceAudioBuffer = await audio.renderPieceBuffer(
        state.measureTimings,
        state.totalDuration,
        audio.soundType
      );
    } catch (err) {
      console.error("Erro ao pré-renderizar buffer de áudio:", err);
    } finally {
      this.isRenderingBuffer = false;
    }

    if (this.pendingBufferRegen) {
      this.pendingBufferRegen = false;
      return this.preparePieceAudio(forceRestart);
    }

    if (this.isPlaying && forceRestart && audio.ctx) {
      const curTime = this.getCurrentPlaybackTime();
      this.startAudioSource(curTime);
    }
  }

  startAudioSource(offsetSeconds) {
    if (!audio.ctx || !this.pieceAudioBuffer) return;
    const offset = Math.max(0, Math.min(state.totalDuration, offsetSeconds));
    this.audioAnchorTime = audio.ctx.currentTime;
    this.pieceAnchorTime = offset;

    audio.play(
      this.pieceAudioBuffer,
      offset,
      this.playbackSpeed,
      this.loopEnabled,
      state.totalDuration,
      () => {
        if (!this.loopEnabled && this.isPlaying) {
          this.pausePlayback();
          this.playbackTime = state.totalDuration;
          this.updateHUD(this.playbackTime);
        }
      }
    );
  }

  async startPlayback() {
    await audio.init();
    if (this.isPlaying) return;

    if (this.playbackTime >= state.totalDuration) {
      this.playbackTime = 0;
    }

    if (!this.pieceAudioBuffer) {
      await this.preparePieceAudio();
    }

    this.isPlaying = true;
    this.updatePlayPauseIcon();
    this.startAudioSource(this.playbackTime);
  }

  pausePlayback() {
    if (!this.isPlaying) return;
    this.playbackTime = this.getCurrentPlaybackTime();
    this.isPlaying = false;
    this.updatePlayPauseIcon();
    audio.stop();
  }

  togglePlayPause() {
    if (this.isPlaying) {
      this.pausePlayback();
    } else {
      this.startPlayback();
    }
  }

  stopPlayback() {
    this.pausePlayback();
    this.seekTo(0);
  }

  seekTo(seconds) {
    this.playbackTime = Math.max(0, Math.min(state.totalDuration, seconds));
    if (this.isPlaying && audio.ctx) {
      this.startAudioSource(this.playbackTime);
    }
    this.updateHUD(this.playbackTime);
  }

  getCurrentPlaybackTime() {
    if (!this.isPlaying || !audio.ctx) {
      return this.playbackTime;
    }
    const elapsedAudio = (audio.ctx.currentTime - this.audioAnchorTime) * this.playbackSpeed;
    if (this.loopEnabled) {
      const total = state.totalDuration || 1;
      return (this.pieceAnchorTime + elapsedAudio) % total;
    } else {
      const current = this.pieceAnchorTime + elapsedAudio;
      if (current >= state.totalDuration) {
        return state.totalDuration;
      }
      return current;
    }
  }

  updatePlayPauseIcon() {
    if (this.isPlaying) {
      this.dom.playIcon.style.display = 'none';
      this.dom.pauseIcon.style.display = 'block';
    } else {
      this.dom.playIcon.style.display = 'block';
      this.dom.pauseIcon.style.display = 'none';
    }
  }

  // =========================================================================
  // LOOP DE ANIMAÇÃO & RENDERIZAÇÃO 60 FPS
  // =========================================================================

  renderLoop(timestamp) {
    const dt = Math.min(0.1, (timestamp - this.lastFrameTime) / 1000);
    this.lastFrameTime = timestamp;

    if (this.isPlaying && audio.ctx) {
      this.playbackTime = this.getCurrentPlaybackTime();
      if (!this.loopEnabled && this.playbackTime >= state.totalDuration) {
        this.playbackTime = state.totalDuration;
        this.pausePlayback();
      }

      // Detecção de batimento precisa sincronizada com o relógio de som (sem timers)
      const pos = state.getPositionAtTime(this.playbackTime);
      if (pos.measureIndex !== this.lastBeatMeasureIdx || pos.beatIndex !== this.lastBeatIdx) {
        if (this.renderer) {
          this.renderer.triggerBeatHit(pos.beatIndex === 0);
        }
        this.lastBeatMeasureIdx = pos.measureIndex;
        this.lastBeatIdx = pos.beatIndex;
      }
    }

    // Renderiza o DJ Runner e o Minimapa
    if (this.renderer) {
      this.renderer.render(this.playbackTime, dt);
    }

    // Atualiza HUD numérico e visual sem sobrecarga de layout
    this.updateHUD(this.playbackTime);

    requestAnimationFrame((t) => this.renderLoop(t));
  }

  // =========================================================================
  // ATUALIZAÇÃO DO HUD AO VIVO (DISPLAY DIGITAL)
  // Otimizado: sem innerHTML, sem querySelector, sem layout thrashing
  // =========================================================================

  updateHUD(seconds) {
    const pos = state.getPositionAtTime(seconds);
    if (!pos || !pos.measure) return;

    // Tempo digital (só escreve se mudou)
    const curTimeStr = this.formatTime(seconds);
    if (this._lastCurTimeStr !== curTimeStr) {
      this._lastCurTimeStr = curTimeStr;
      this.dom.hudCurrentTime.textContent = curTimeStr;
    }

    const totalTimeStr = this.formatTime(state.totalDuration);
    if (this._lastTotalTimeStr !== totalTimeStr) {
      this._lastTotalTimeStr = totalTimeStr;
      this.dom.hudTotalTime.textContent = totalTimeStr;
    }

    // Compasso badge & apelido (só escreve se trocou de compasso)
    if (this._lastMeasureIdx !== pos.measureIndex) {
      this._lastMeasureIdx = pos.measureIndex;

      this.dom.hudMeasureBadge.textContent = `c. ${pos.measureIndex + 1}`;
      this.dom.hudMeasureNickname.textContent = pos.measure.nickname || `Compasso ${pos.measureIndex + 1}`;

      // Grupo (só busca quando muda de compasso, não a cada frame)
      const grp = state.getGroupByMeasureIndex(pos.measureIndex);
      if (grp) {
        this.dom.hudGroupPill.style.display = 'inline-flex';
        this.dom.hudGroupName.textContent = grp.name;
        // Cache do elemento .group-dot para evitar querySelector a cada frame
        if (!this._groupDotEl) {
          this._groupDotEl = this.dom.hudGroupPill.querySelector('.group-dot');
        }
        if (this._groupDotEl) this._groupDotEl.style.color = grp.color;
      } else {
        this.dom.hudGroupPill.style.display = 'none';
      }

      // BPM Efetivo e Ratio (só muda com compasso)
      this.dom.hudBpmValue.textContent = Math.round(pos.effectiveBpm);

      if (pos.measure.tempoMode === "ratio") {
        if (pos.measure.ratioNum === 1 && pos.measure.ratioDen === 1) {
          this.dom.hudTempoRatio.textContent = "1:1";
        } else {
          const mult = (pos.measure.ratioNum / pos.measure.ratioDen).toFixed(2);
          this.dom.hudTempoRatio.textContent = `${pos.measure.ratioNum}/${pos.measure.ratioDen} (${mult}x)`;
        }
      } else {
        this.dom.hudTempoRatio.textContent = "Fixo";
      }

      // Realce no cartão
      this.highlightActiveMeasureCard(pos.measureIndex);
    }

    // Batimento e pontos de beat (muda a cada beat, não a cada frame)
    this.renderBeatDots(pos.timing.beats, pos.beatIndex);

    // Texto do beat
    const beatStr = `${pos.beatIndex + 1} / ${pos.timing.beats}`;
    if (this.lastBeatText !== beatStr) {
      this.lastBeatText = beatStr;
      this.dom.hudBeatText.textContent = beatStr;
    }
  }

  /**
   * Pontos de beat: pre-cria os elementos uma vez por compasso
   * e depois só troca classes, sem nunca destruir e recriar DOM.
   */
  renderBeatDots(totalBeats, activeIdx) {
    // Se mudou o número de tempos, recria a pool de dots
    if (this.lastTotalBeats !== totalBeats) {
      this.lastTotalBeats = totalBeats;
      this.lastActiveBeatIdx = -1;

      const container = this.dom.hudBeatDots;
      container.textContent = ''; // Limpa sem innerHTML
      this._beatDotEls = [];

      for (let i = 0; i < totalBeats; i++) {
        const dot = document.createElement('div');
        dot.className = 'beat-dot';
        container.appendChild(dot);
        this._beatDotEls.push(dot);
      }
    }

    // Se mudou o beat ativo, troca classe direta (zero allocation)
    if (this.lastActiveBeatIdx !== activeIdx && this._beatDotEls) {
      // Remove do anterior
      if (this.lastActiveBeatIdx >= 0 && this._beatDotEls[this.lastActiveBeatIdx]) {
        this._beatDotEls[this.lastActiveBeatIdx].className = 'beat-dot';
      }
      // Ativa o novo
      if (this._beatDotEls[activeIdx]) {
        this._beatDotEls[activeIdx].className = activeIdx === 0 ? 'beat-dot accent' : 'beat-dot active';
      }
      this.lastActiveBeatIdx = activeIdx;
    }
  }

  highlightActiveMeasureCard(activeIndex) {
    if (this.lastHighlightedIdx === activeIndex) return;

    if (this.cachedCards && this.cachedCards.length > 0) {
      if (this.lastHighlightedIdx >= 0 && this.cachedCards[this.lastHighlightedIdx]) {
        this.cachedCards[this.lastHighlightedIdx].classList.remove('active-playback');
      }
      if (this.cachedCards[activeIndex]) {
        this.cachedCards[activeIndex].classList.add('active-playback');
      }
    }
    this.lastHighlightedIdx = activeIndex;
  }

  formatTime(sec) {
    if (isNaN(sec) || sec < 0) sec = 0;
    const minutes = Math.floor(sec / 60);
    const seconds = Math.floor(sec % 60);
    const tenths = Math.floor((sec % 1) * 10);
    const mStr = String(minutes).padStart(2, '0');
    const sStr = String(seconds).padStart(2, '0');
    return `${mStr}:${sStr}.${tenths}`;
  }

  // =========================================================================
  // CONTROLE DO BASE BPM SEM BUGS DE DIGITAÇÃO
  // =========================================================================

  setupBpmControls() {
    const input = this.dom.inputBaseBpm;

    const syncBpmInput = () => {
      input.value = state.baseBpm;
    };
    syncBpmInput();

    const commitBpm = (val) => {
      const num = parseInt(val, 10);
      if (!isNaN(num) && num >= 20 && num <= 400) {
        state.setBaseBpm(num);
      }
      syncBpmInput();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        commitBpm(input.value);
        input.blur();
      } else if (e.key === 'Escape') {
        syncBpmInput();
        input.blur();
      }
    });

    input.addEventListener('blur', () => {
      commitBpm(input.value);
    });

    this.dom.btnBpmMinus5.addEventListener('click', () => commitBpm(state.baseBpm - 5));
    this.dom.btnBpmMinus1.addEventListener('click', () => commitBpm(state.baseBpm - 1));
    this.dom.btnBpmPlus1.addEventListener('click', () => commitBpm(state.baseBpm + 1));
    this.dom.btnBpmPlus5.addEventListener('click', () => commitBpm(state.baseBpm + 5));

    // Tap Tempo
    this.dom.btnTapTempo.addEventListener('click', () => {
      const now = performance.now();
      this.tapTimes = this.tapTimes.filter(t => (now - t) < 2500);
      this.tapTimes.push(now);

      if (this.tapTimes.length >= 2) {
        const intervals = [];
        for (let i = 1; i < this.tapTimes.length; i++) {
          intervals.push(this.tapTimes[i] - this.tapTimes[i - 1]);
        }
        const avgIntervalMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const calculatedBpm = Math.round(60000 / avgIntervalMs);
        if (calculatedBpm >= 20 && calculatedBpm <= 350) {
          commitBpm(calculatedBpm);
        }
      }
    });
  }

  // =========================================================================
  // GESTÃO DE EVENTOS E INTERFACE
  // =========================================================================

  initEventListeners() {
    this.setupBpmControls();

    // Nome da Peça
    this.dom.inputPieceName.value = state.name;
    this.dom.inputPieceName.addEventListener('change', (e) => {
      state.setPieceName(e.target.value);
    });

    // Transporte
    this.dom.btnPlayPause.addEventListener('click', () => this.togglePlayPause());
    this.dom.btnStopRewind.addEventListener('click', () => this.stopPlayback());

    this.dom.btnPrevMeasure.addEventListener('click', () => {
      const pos = state.getPositionAtTime(this.playbackTime);
      const targetMeasure = Math.max(0, pos.measureIndex - 1);
      this.seekTo(state.getTimeAtMeasure(targetMeasure));
    });

    this.dom.btnNextMeasure.addEventListener('click', () => {
      const pos = state.getPositionAtTime(this.playbackTime);
      const targetMeasure = Math.min(state.measures.length - 1, pos.measureIndex + 1);
      this.seekTo(state.getTimeAtMeasure(targetMeasure));
    });

    // Loop
    this.dom.btnLoop.addEventListener('click', () => {
      this.loopEnabled = !this.loopEnabled;
      this.dom.btnLoop.classList.toggle('active', this.loopEnabled);
      if (this.isPlaying && audio.ctx) {
        this.startAudioSource(this.getCurrentPlaybackTime());
      }
    });

    // Velocidade de Estudo
    this.dom.speedBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        this.dom.speedBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.playbackSpeed = parseFloat(btn.dataset.speed) || 1.0;
        if (this.isPlaying && audio.ctx) {
          const curTime = this.getCurrentPlaybackTime();
          this.audioAnchorTime = audio.ctx.currentTime;
          this.pieceAnchorTime = curTime;
          audio.setPlaybackRate(this.playbackSpeed);
        }
      });
    });

    // Áudio: Mute e Timbre
    this.dom.btnMute.addEventListener('click', () => {
      const isMuted = !audio.isMuted;
      audio.setMuted(isMuted);
      this.dom.muteIcon.textContent = isMuted ? '🔇' : '🔊';
      this.dom.btnMute.classList.toggle('active', !isMuted);
    });

    this.dom.selectSoundType.addEventListener('change', (e) => {
      audio.setSoundType(e.target.value);
      this.preparePieceAudio(true);
    });

    // Adicionar Compasso
    this.dom.btnAddMeasureQuick.addEventListener('click', () => {
      state.addMeasure();
      this.renderMeasuresList();
    });

    this.dom.btnAddMeasureBottom.addEventListener('click', () => {
      state.addMeasure();
      this.renderMeasuresList();
    });

    // Exportar e Importar
    this.dom.btnExport.addEventListener('click', () => this.exportPieceFile());
    this.dom.fileImport.addEventListener('change', (e) => this.handleImportFile(e));

    // Modais
    this.setupMeasureModal();
    this.setupGroupModal();

    // Inscrição no estado para re-renderizar quando houver alterações estruturais
    state.subscribe(() => {
      this.dom.inputPieceName.value = state.name;
      this.dom.inputBaseBpm.value = state.baseBpm;
      this.renderMeasuresList();
      this.updateHUD(this.playbackTime);
      if (this.renderer) {
        this.renderer.resize();
      }
      this.preparePieceAudio(true);
    });

    // Atalhos de teclado
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        this.togglePlayPause();
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        this.stopPlayback();
      } else if (e.key === 'm' || e.key === 'M') {
        this.dom.btnMute.click();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.dom.btnPrevMeasure.click();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        this.dom.btnNextMeasure.click();
      }
    });
  }

  // =========================================================================
  // GRADE DE COMPASSOS INFERIOR
  // =========================================================================

  renderMeasuresList() {
    const grid = this.dom.measuresGrid;
    const measures = state.measures;
    const timings = state.measureTimings;

    this.dom.measureCountBadge.textContent = `${measures.length} ${measures.length === 1 ? 'compasso' : 'compassos'} configurados`;

    grid.innerHTML = '';
    this.cachedCards = [];
    this.lastHighlightedIdx = -1;

    measures.forEach((m, idx) => {
      const timing = timings[idx] || { effectiveBpm: state.baseBpm };
      const grp = state.getGroupByMeasureIndex(idx);

      const card = document.createElement('div');
      card.className = 'measure-card';
      card.dataset.index = idx;

      if (grp) {
        card.innerHTML += `<div class="measure-card-group-strip" style="background:${grp.color}"></div>`;
      }

      let groupTagHtml = '';
      if (grp) {
        groupTagHtml = `<span class="measure-card-group-tag" style="background:${grp.color}33; color:${grp.color}">${grp.name}</span>`;
      }

      let tempoDesc = '';
      if (m.tempoMode === "ratio") {
        tempoDesc = (m.ratioNum === 1 && m.ratioDen === 1) 
          ? `${Math.round(timing.effectiveBpm)} BPM (Base)`
          : `${Math.round(timing.effectiveBpm)} BPM (${m.ratioNum}/${m.ratioDen})`;
      } else {
        tempoDesc = `${Math.round(timing.effectiveBpm)} BPM (Fixo)`;
      }

      card.innerHTML += `
        <div class="measure-card-header">
          <span class="measure-card-idx" style="color:${m.color || '#ff334b'}">c. ${idx + 1}</span>
          ${groupTagHtml}
        </div>

        <!-- APELIDO DO COMPASSO EM DESTAQUE (HERO TEXT) -->
        <h3 class="measure-card-nickname" title="${m.nickname}">${m.nickname}</h3>

        <div class="measure-card-details">
          <span class="measure-card-meter">${m.beats}/${m.beatUnit}</span>
          <span class="measure-card-tempo">${tempoDesc}</span>
        </div>

        <div class="measure-card-actions">
          <button type="button" class="btn-card-icon btn-card-dup" title="Duplicar Compasso">⧉</button>
          <button type="button" class="btn-card-icon btn-card-del" title="Excluir Compasso">✕</button>
          <button type="button" class="btn-card-edit">Configurar</button>
        </div>
      `;

      card.addEventListener('click', (e) => {
        if (e.target.closest('.btn-card-del')) {
          e.stopPropagation();
          state.removeMeasure(idx);
          return;
        }
        if (e.target.closest('.btn-card-dup')) {
          e.stopPropagation();
          state.duplicateMeasure(idx);
          return;
        }
        this.openMeasureModal(idx);
      });

      grid.appendChild(card);
      this.cachedCards.push(card);
    });
  }

  // =========================================================================
  // MODAL DE CONFIGURAÇÃO DE COMPASSO
  // =========================================================================

  setupMeasureModal() {
    const modal = this.dom.modalMeasureEdit;
    const form = this.dom.formMeasureEdit;

    this.dom.btnModalClose.addEventListener('click', () => {
      modal.style.display = 'none';
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.style.display = 'none';
    });

    this.dom.radioModeRatio.addEventListener('change', () => this.toggleTempoModePanels());
    this.dom.radioModeFixed.addEventListener('change', () => this.toggleTempoModePanels());

    const ratioBtns = modal.querySelectorAll('.btn-ratio-preset, .preset-ratio-btn');
    ratioBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        ratioBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.dom.editRatioNum.value = btn.dataset.num;
        this.dom.editRatioDen.value = btn.dataset.den;
        this.updateModalCalculatedBpm();
      });
    });

    this.dom.editRatioNum.addEventListener('input', () => this.updateModalCalculatedBpm());
    this.dom.editRatioDen.addEventListener('input', () => this.updateModalCalculatedBpm());

    const swatches = modal.querySelectorAll('.color-swatch-btn');
    swatches.forEach(btn => {
      btn.addEventListener('click', () => {
        swatches.forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        this.dom.editColorPicker.value = btn.dataset.color;
      });
    });

    this.dom.editColorPicker.addEventListener('input', () => {
      swatches.forEach(b => b.classList.remove('selected'));
    });

    this.dom.btnDeleteMeasureModal.addEventListener('click', () => {
      const idx = parseInt(this.dom.editMeasureIndex.value, 10);
      modal.style.display = 'none';
      state.removeMeasure(idx);
    });

    this.dom.btnDuplicateMeasureModal.addEventListener('click', () => {
      const idx = parseInt(this.dom.editMeasureIndex.value, 10);
      modal.style.display = 'none';
      state.duplicateMeasure(idx);
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const idx = parseInt(this.dom.editMeasureIndex.value, 10);
      if (idx < 0) return;

      const tempoMode = this.dom.radioModeFixed.checked ? 'fixed' : 'ratio';
      const num = parseInt(this.dom.editRatioNum.value, 10) || 1;
      const den = parseInt(this.dom.editRatioDen.value, 10) || 1;
      const fixedBpm = parseFloat(this.dom.editCustomBpm.value) || state.baseBpm;

      state.updateMeasure(idx, {
        nickname: this.dom.editNickname.value,
        beats: parseInt(this.dom.editBeats.value, 10) || 4,
        beatUnit: parseInt(this.dom.editBeatUnit.value, 10) || 4,
        tempoMode: tempoMode,
        ratioNum: num,
        ratioDen: den,
        customBpm: fixedBpm,
        color: this.dom.editColorPicker.value
      });

      modal.style.display = 'none';
    });
  }

  toggleTempoModePanels() {
    const isRatio = this.dom.radioModeRatio.checked;
    this.dom.panelTempoRatio.style.display = isRatio ? 'block' : 'none';
    this.dom.panelTempoFixed.style.display = isRatio ? 'none' : 'block';
  }

  updateModalCalculatedBpm() {
    const num = Math.max(1, parseInt(this.dom.editRatioNum.value, 10) || 1);
    const den = Math.max(1, parseInt(this.dom.editRatioDen.value, 10) || 1);
    const eff = Math.round(state.baseBpm * (num / den));
    this.dom.calcEffectiveBpm.textContent = `${eff} BPM`;
  }

  openMeasureModal(index) {
    const m = state.measures[index];
    if (!m) return;

    this.dom.editMeasureIndex.value = index;
    this.dom.modalMeasureIdx.textContent = `Compasso ${index + 1}`;
    this.dom.editNickname.value = m.nickname;
    this.dom.editBeats.value = m.beats;
    this.dom.editBeatUnit.value = m.beatUnit;

    if (m.tempoMode === 'fixed') {
      this.dom.radioModeFixed.checked = true;
    } else {
      this.dom.radioModeRatio.checked = true;
    }
    this.toggleTempoModePanels();

    this.dom.editRatioNum.value = m.ratioNum || 1;
    this.dom.editRatioDen.value = m.ratioDen || 1;
    this.dom.editCustomBpm.value = m.customBpm || state.baseBpm;
    this.dom.editColorPicker.value = m.color || '#ff334b';

    const swatches = this.dom.modalMeasureEdit.querySelectorAll('.color-swatch-btn');
    swatches.forEach(s => {
      s.classList.toggle('selected', s.dataset.color.toLowerCase() === m.color?.toLowerCase());
    });

    this.updateModalCalculatedBpm();
    this.dom.modalMeasureEdit.style.display = 'flex';
    this.dom.editNickname.focus();
  }

  // =========================================================================
  // MODAL DE AGRUPAMENTO DE COMPASSOS VIZINHOS
  // =========================================================================

  setupGroupModal() {
    const modal = this.dom.modalGroupManage;

    const openModal = () => {
      this.populateGroupSelects();
      this.renderExistingGroupsList();
      modal.style.display = 'flex';
      this.dom.newGroupName.focus();
    };

    this.dom.btnManageGroups.addEventListener('click', openModal);
    this.dom.btnOpenGroupModal.addEventListener('click', openModal);

    this.dom.btnGroupModalClose.addEventListener('click', () => {
      modal.style.display = 'none';
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.style.display = 'none';
    });

    const colorBtns = modal.querySelectorAll('.group-color-btn');
    colorBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        colorBtns.forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        this.dom.newGroupColorPicker.value = btn.dataset.color;
      });
    });

    this.dom.formCreateGroup.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = this.dom.newGroupName.value.trim();
      const start = parseInt(this.dom.newGroupStart.value, 10);
      const end = parseInt(this.dom.newGroupEnd.value, 10);
      const color = this.dom.newGroupColorPicker.value;

      if (!name) return;

      state.addGroup(name, color, start, end);
      this.dom.newGroupName.value = '';
      this.renderExistingGroupsList();
      this.renderMeasuresList();
    });
  }

  populateGroupSelects() {
    const startSelect = this.dom.newGroupStart;
    const endSelect = this.dom.newGroupEnd;

    startSelect.innerHTML = '';
    endSelect.innerHTML = '';

    state.measures.forEach((m, idx) => {
      const optText = `c. ${idx + 1} - ${m.nickname}`;
      startSelect.innerHTML += `<option value="${idx}">${optText}</option>`;
      endSelect.innerHTML += `<option value="${idx}">${optText}</option>`;
    });

    if (state.measures.length > 0) {
      startSelect.selectedIndex = 0;
      endSelect.selectedIndex = Math.min(3, state.measures.length - 1);
    }
  }

  renderExistingGroupsList() {
    const list = this.dom.existingGroupsList;
    list.innerHTML = '';

    if (state.groups.length === 0) {
      list.innerHTML = `<p style="font-size:0.8rem; color:var(--white-muted)">Nenhum grupo criado ainda.</p>`;
      return;
    }

    state.groups.forEach(g => {
      const item = document.createElement('div');
      item.className = 'group-item-card';
      item.innerHTML = `
        <div class="group-item-info">
          <div class="group-item-dot" style="background:${g.color}"></div>
          <div>
            <div class="group-item-name">${g.name}</div>
            <div class="group-item-span">c. ${g.startMeasure + 1} até c. ${g.endMeasure + 1}</div>
          </div>
        </div>
        <button type="button" class="group-item-del-btn" title="Desagrupar">Excluir</button>
      `;

      item.querySelector('.group-item-del-btn').addEventListener('click', () => {
        state.removeGroup(g.id);
        this.renderExistingGroupsList();
        this.renderMeasuresList();
      });

      list.appendChild(item);
    });
  }

  // =========================================================================
  // PRESETS, IMPORT & EXPORT
  // =========================================================================

  initPresetsDropdown() {
    const select = this.dom.selectPreset;
    PRESETS.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      select.appendChild(opt);
    });

    select.addEventListener('change', (e) => {
      const presetId = e.target.value;
      const found = PRESETS.find(p => p.id === presetId);
      if (found) {
        this.pausePlayback();
        state.loadPieceData(JSON.parse(JSON.stringify(found)));
        this.seekTo(0);
        select.value = '';
      }
    });
  }

  exportPieceFile() {
    const jsonStr = state.exportJSON();
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeName = (state.name || 'sergio-piece').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    a.href = url;
    a.download = `${safeName}.sergio.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  handleImportFile(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target.result;
      const res = state.importJSON(content);
      if (res.success) {
        this.pausePlayback();
        this.seekTo(0);
      } else {
        alert(`Erro ao importar peça: ${res.error}`);
      }
      event.target.value = '';
    };
    reader.readAsText(file);
  }
}

// Inicialização da aplicação ao carregar a página
document.addEventListener('DOMContentLoaded', () => {
  const app = new SergioApp();
  app.init();
  window.__sergioApp = app;
});
