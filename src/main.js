/**
 * Sérgio Simulator - Controlador Principal (Main)
 * Motor de tempo sample-accurate sem jitter, sem lentidão na troca de compassos e sem atraso no play.
 */

import { state } from './state.js';
import { audio } from './audio.js';
import { PRESETS } from './presets.js';
import { DJRunnerRenderer } from './renderer.js';
import { collab, DEFAULT_AVATAR_COLORS } from './collab.js';

class SergioApp {
  constructor() {
    this.playbackTime = 0;
    this.isPlaying = false;
    this.loopEnabled = true;
    this.playbackSpeed = 1.0;
    
    // Motor de Áudio Pré-Renderizado (OfflineAudioContext)
    this.audio = audio;
    this.state = state;
    this.collab = collab;
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

    // Seleção múltipla de compassos (com Shift e Ctrl/Cmd)
    this.selectedMeasureIndices = new Set();
    this.lastSelectedMeasureIdx = null;

    this.dom = {};
  }

  init() {
    this.cacheDom();
    this.initTheme();
    this.setupSaveIndicator();
    this.initRenderer();
    this.initEventListeners();
    this.setupRunnerInteractions();
    this.initPresetsDropdown();
    this.renderMeasuresList();
    this.updateHUD(0);
    this.setupCollab();
    this.setupShareModal();
    this.setupHistoryModal();
    this.setupJoinModal();
    this.updateBpmPracticeUI();
    this.updateUndoRedoUI();

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

  initTheme() {
    const savedTheme = localStorage.getItem('sergio_theme') || 
      (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    this.setTheme(savedTheme);

    this.dom.btnThemeToggle?.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = current === 'light' ? 'dark' : 'light';
      this.setTheme(next);
      if (this.renderer) {
        this.renderer.render(this.playbackTime);
      }
    });
  }

  setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('sergio_theme', theme);
    if (this.dom.themeIcon) {
      this.dom.themeIcon.textContent = theme === 'light' ? '🌙' : '☀️';
    }
    if (this.dom.btnThemeToggle) {
      this.dom.btnThemeToggle.title = theme === 'light' ? 'Mudar para Tema Escuro (T)' : 'Mudar para Tema Claro (T)';
    }
    if (this.renderer) {
      this.renderer.markMinimapDirty?.();
    }
  }

  setupSaveIndicator() {
    let saveTimeout = null;
    window.addEventListener('sergio:saved', () => {
      const ind = this.dom.saveIndicator;
      if (!ind) return;
      ind.classList.add('just-saved');
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        ind.classList.remove('just-saved');
      }, 1600);
    });
  }

  cacheDom() {
    this.dom = {
      // Header & Base BPM
      inputBaseBpm: document.getElementById('inputBaseBpm'),
      btnBpmMinus5: document.getElementById('btnBpmMinus5'),
      btnBpmMinus1: document.getElementById('btnBpmMinus1'),
      btnBpmPlus1: document.getElementById('btnBpmPlus1'),
      btnBpmPlus5: document.getElementById('btnBpmPlus5'),
      btnTapTempo: document.getElementById('btnTapTempo'),
      bpmPracticeStatus: document.getElementById('bpmPracticeStatus'),
      bpmPracticeBadge: document.getElementById('bpmPracticeBadge'),
      btnResetPresentationBpm: document.getElementById('btnResetPresentationBpm'),
      btnPromotePresentationBpm: document.getElementById('btnPromotePresentationBpm'),
      inputPieceName: document.getElementById('inputPieceName'),
      selectPreset: document.getElementById('selectPreset'),
      btnExport: document.getElementById('btnExport'),
      fileImport: document.getElementById('fileImport'),
      btnNewPiece: document.getElementById('btnNewPiece'),
      btnUndo: document.getElementById('btnUndo'),
      btnRedo: document.getElementById('btnRedo'),
      btnThemeToggle: document.getElementById('btnThemeToggle'),
      themeIcon: document.getElementById('themeIcon'),
      saveIndicator: document.getElementById('saveIndicator'),
      btnMute: document.getElementById('btnMute'),
      muteIcon: document.getElementById('muteIcon'),
      selectSoundType: document.getElementById('selectSoundType'),

      // Nuvem, Colaboração e Histórico
      cloudStatusPill: document.getElementById('cloudStatusPill'),
      cloudStatusText: document.getElementById('cloudStatusText'),
      presenceRow: document.getElementById('presenceRow'),
      btnOpenHistory: document.getElementById('btnOpenHistory'),
      historyBadgeCount: document.getElementById('historyBadgeCount'),
      btnSharePiece: document.getElementById('btnSharePiece'),

      // Modal de Compartilhar
      modalSharePiece: document.getElementById('modalSharePiece'),
      btnShareModalClose: document.getElementById('btnShareModalClose'),
      inputShareUrl: document.getElementById('inputShareUrl'),
      btnCopyShareUrl: document.getElementById('btnCopyShareUrl'),
      copyIcon: document.getElementById('copyIcon'),
      copyText: document.getElementById('copyText'),
      userAvatarPreview: document.getElementById('userAvatarPreview'),
      inputCollabName: document.getElementById('inputCollabName'),
      avatarColorPicker: document.getElementById('avatarColorPicker'),
      collabUsersList: document.getElementById('collabUsersList'),
      onlineCountBadge: document.getElementById('onlineCountBadge'),

      // Modal de Entrada na Sessão Compartilhada
      modalJoinCollab: document.getElementById('modalJoinCollab'),
      btnJoinModalClose: document.getElementById('btnJoinModalClose'),
      formJoinCollab: document.getElementById('formJoinCollab'),
      inputJoinName: document.getElementById('inputJoinName'),
      joinNameError: document.getElementById('joinNameError'),
      joinAvatarColorPicker: document.getElementById('joinAvatarColorPicker'),
      joinAvatarPreview: document.getElementById('joinAvatarPreview'),
      joinPieceTitleHeading: document.getElementById('joinPieceTitleHeading'),
      btnJoinConfirm: document.getElementById('btnJoinConfirm'),

      // Modal de Histórico
      modalVersionHistory: document.getElementById('modalVersionHistory'),
      btnHistoryModalClose: document.getElementById('btnHistoryModalClose'),
      historyTotalCount: document.getElementById('historyTotalCount'),
      historyListContainer: document.getElementById('historyListContainer'),

      // Toast Flutuante
      toastNotification: document.getElementById('toastNotification'),
      toastIcon: document.getElementById('toastIcon'),
      toastMessage: document.getElementById('toastMessage'),

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
      btnClearAllMeasures: document.getElementById('btnClearAllMeasures'),
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
      editRepeat: document.getElementById('editRepeat'),
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
      existingGroupsList: document.getElementById('existingGroupsList'),

      // Modal de Confirmação Novo Arquivo (Double Check)
      modalConfirmNewPiece: document.getElementById('modalConfirmNewPiece'),
      btnConfirmNewClose: document.getElementById('btnConfirmNewClose'),
      btnCancelNewPiece: document.getElementById('btnCancelNewPiece'),
      btnExecuteNewPiece: document.getElementById('btnExecuteNewPiece'),

      // Redimensionamento e Barra de Ferramentas da Visão Corrida
      runnerViewport: document.getElementById('runnerViewport'),
      runnerResizer: document.getElementById('runnerResizer'),
      runnerMeasureToolbar: document.getElementById('runnerMeasureToolbar'),
      toolbarMeasureBadge: document.getElementById('toolbarMeasureBadge'),
      toolbarMeasureName: document.getElementById('toolbarMeasureName'),
      btnMoveMeasureLeft: document.getElementById('btnMoveMeasureLeft'),
      btnMoveMeasureRight: document.getElementById('btnMoveMeasureRight'),
      btnGroupSelectedMeasures: document.getElementById('btnGroupSelectedMeasures'),
      btnConfigureSelectedMeasure: document.getElementById('btnConfigureSelectedMeasure'),
      btnDuplicateSelectedMeasure: document.getElementById('btnDuplicateSelectedMeasure'),
      btnDeleteSelectedMeasure: document.getElementById('btnDeleteSelectedMeasure'),
      btnCloseToolbar: document.getElementById('btnCloseToolbar'),
      btnToggleWideMode: document.getElementById('btnToggleWideMode'),

      // Menu de Contexto
      runnerContextMenu: document.getElementById('runnerContextMenu'),
      ctxMenuHeader: document.getElementById('ctxMenuHeader'),
      ctxEdit: document.getElementById('ctxEdit'),
      ctxMoveLeft: document.getElementById('ctxMoveLeft'),
      ctxMoveRight: document.getElementById('ctxMoveRight'),
      ctxDuplicate: document.getElementById('ctxDuplicate'),
      ctxDelete: document.getElementById('ctxDelete')
    };
  }

  initRenderer() {
    this.renderer = new DJRunnerRenderer(
      this.dom.djCanvas,
      this.dom.minimapCanvas,
      state,
      {
        onSeek: (seekSeconds) => this.seekTo(seekSeconds),
        onSelectMeasure: (idx, e) => this.handleMeasureSelected(idx, e),
        onMoveMeasure: (fromIdx, toIdx) => this.handleMeasureMoved(fromIdx, toIdx),
        onEditMeasure: (idx) => this.openMeasureModal(idx),
        onContextMenu: (idx, x, y) => this.openContextMenu(idx, x, y)
      }
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

    // Lookahead de 25ms para sincronização precisa entre o hardware de áudio e a tela
    // Permite que o driver de som prepare o buffer DMA, eliminando micro-atrasos e estalos iniciais
    const lookahead = 0.025;
    const when = audio.ctx.currentTime + lookahead;
    this.audioAnchorTime = when;
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
      },
      when
    );
  }

  async startPlayback() {
    if (state.measures.length === 0) return;
    await audio.init();
    if (this.isPlaying) return;

    if (this.playbackTime >= state.totalDuration) {
      this.playbackTime = 0;
    }

    if (!this.pieceAudioBuffer || (audio.ctx && this.pieceAudioBuffer.sampleRate !== audio.ctx.sampleRate)) {
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
      if (state.measures.length === 0) return;
      this.startPlayback();
    }
  }

  stopPlayback() {
    this.pausePlayback();
    this.seekTo(0);
  }

  seekTo(seconds) {
    if (state.measures.length === 0) {
      this.playbackTime = 0;
      this.updateHUD(0);
      return;
    }
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
    const now = audio.ctx.currentTime;
    if (now < this.audioAnchorTime) {
      // Mantém a agulha visualmente alinhada com o início enquanto o hardware engatilha o áudio (25ms)
      return this.pieceAnchorTime;
    }
    const elapsedAudio = (now - this.audioAnchorTime) * this.playbackSpeed;
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
      if (pos.measureIndex !== this.lastBeatMeasureIdx || pos.repeatIteration !== this.lastBeatRepeatIdx || pos.beatIndex !== this.lastBeatIdx) {
        if (this.renderer) {
          this.renderer.triggerBeatHit(pos.beatIndex === 0);
        }
        this.lastBeatMeasureIdx = pos.measureIndex;
        this.lastBeatRepeatIdx = pos.repeatIteration;
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
    if (state.measures.length === 0) {
      this.dom.hudCurrentTime.textContent = '00:00.0';
      this.dom.hudTotalTime.textContent = '00:00.0';
      this.dom.hudMeasureBadge.textContent = '0 compassos';
      this.dom.hudMeasureNickname.textContent = '';
      this.dom.hudMeasureNickname.style.display = 'none';
      this.dom.hudGroupPill.style.display = 'none';
      this.dom.hudBeatText.textContent = '- / -';
      this.dom.hudBeatDots.textContent = '';
      this.dom.hudBpmValue.textContent = state.baseBpm;
      this.dom.hudTempoRatio.textContent = '-';
      this._lastMeasureIdx = -1;
      this._lastRepeatIdx = -1;
      this._lastCurTimeStr = '00:00.0';
      this._lastTotalTimeStr = '00:00.0';
      this.lastBeatText = '- / -';
      this.highlightActiveMeasureCard(-1);
      return;
    }

    const pos = state.getPositionAtTime(seconds);
    if (!pos || !pos.measure || !pos.timing) return;

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

    // Compasso badge & apelido (escreve se trocou de compasso ou repetição)
    if (this._lastMeasureIdx !== pos.measureIndex || this._lastRepeatIdx !== pos.repeatIteration) {
      this._lastMeasureIdx = pos.measureIndex;
      this._lastRepeatIdx = pos.repeatIteration;

      const repInfo = (pos.repeatCount > 1) ? ` (rep. ${pos.repeatIteration + 1}/${pos.repeatCount})` : '';
      this.dom.hudMeasureBadge.textContent = `c. ${pos.measureIndex + 1}${repInfo}`;
      if (pos.measure.nickname && pos.measure.nickname.trim()) {
        this.dom.hudMeasureNickname.textContent = pos.measure.nickname;
        this.dom.hudMeasureNickname.style.display = '';
      } else {
        this.dom.hudMeasureNickname.textContent = '';
        this.dom.hudMeasureNickname.style.display = 'none';
      }

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
      if (input) input.value = state.baseBpm;
      this.updateBpmPracticeUI();
    };
    syncBpmInput();

    const commitBpm = (val) => {
      const num = parseInt(val, 10);
      if (!isNaN(num) && num >= 20 && num <= 400) {
        // Altera apenas o andamento base local para treino/estudo (não afeta o banco de dados nem outros usuários)
        state.setBaseBpm(num, true);
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

    // Botão de restaurar BPM original da apresentação
    this.dom.btnResetPresentationBpm?.addEventListener('click', () => {
      state.resetToPresentationBpm();
      syncBpmInput();
      this.showToast(`BPM restaurado para ${state.presentationBpm} (Apresentação)`, '↺');
    });

    // Botão de promover BPM atual para oficial da apresentação na nuvem
    this.dom.btnPromotePresentationBpm?.addEventListener('click', () => {
      state.setPresentationBpm(state.baseBpm);
      syncBpmInput();
      this.showToast(`BPM oficial da apresentação definido como ${state.presentationBpm} na nuvem!`, '☁️');
    });

    // Tap Tempo (ajusta BPM local de treino)
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
        if (calculatedBpm >= 20 && calculatedBpm <= 400) {
          commitBpm(calculatedBpm);
        }
      }
    });
  }

  updateBpmPracticeUI() {
    const isPractice = state.baseBpm !== state.presentationBpm;
    if (this.dom.bpmPracticeStatus) {
      this.dom.bpmPracticeStatus.style.display = isPractice ? 'inline-flex' : 'none';
    }
    if (this.dom.btnResetPresentationBpm) {
      this.dom.btnResetPresentationBpm.textContent = `↺ ${state.presentationBpm}`;
      this.dom.btnResetPresentationBpm.title = `Restaurar para ${state.presentationBpm} BPM (Apresentação Oficial)`;
    }
    if (this.dom.inputBaseBpm) {
      if (isPractice) {
        this.dom.inputBaseBpm.classList.add('practice-active');
        this.dom.inputBaseBpm.title = `Andamento de Treino Local (${state.baseBpm} BPM). O BPM da apresentação é ${state.presentationBpm}.`;
      } else {
        this.dom.inputBaseBpm.classList.remove('practice-active');
        this.dom.inputBaseBpm.title = `Andamento Base da Apresentação (${state.presentationBpm} BPM)`;
      }
    }
  }

  updateUndoRedoUI() {
    if (this.dom.btnUndo) {
      const canU = state.canUndo();
      this.dom.btnUndo.disabled = !canU;
      this.dom.btnUndo.style.opacity = canU ? '1' : '0.4';
      this.dom.btnUndo.style.cursor = canU ? 'pointer' : 'not-allowed';
      this.dom.btnUndo.setAttribute('aria-disabled', String(!canU));
    }
    if (this.dom.btnRedo) {
      const canR = state.canRedo();
      this.dom.btnRedo.disabled = !canR;
      this.dom.btnRedo.style.opacity = canR ? '1' : '0.4';
      this.dom.btnRedo.style.cursor = canR ? 'pointer' : 'not-allowed';
      this.dom.btnRedo.setAttribute('aria-disabled', String(!canR));
    }
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
      if (state.measures.length === 0) return;
      const pos = state.getPositionAtTime(this.playbackTime);
      const timings = state.measureTimings;
      const curIdx = pos.timingIndex ?? 0;
      const curTiming = timings[curIdx];
      if (curTiming && this.playbackTime > curTiming.startTime + 0.4) {
        this.seekTo(curTiming.startTime);
      } else if (curIdx > 0) {
        this.seekTo(timings[curIdx - 1].startTime);
      } else {
        this.seekTo(0);
      }
    });

    this.dom.btnNextMeasure.addEventListener('click', () => {
      if (state.measures.length === 0) return;
      const pos = state.getPositionAtTime(this.playbackTime);
      const timings = state.measureTimings;
      const curIdx = pos.timingIndex ?? 0;
      if (curIdx < timings.length - 1) {
        this.seekTo(timings[curIdx + 1].startTime);
      }
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

    // Botão Novo Arquivo & Limpar com double-check
    this.dom.btnNewPiece?.addEventListener('click', () => {
      this.openConfirmNewModal();
    });

    if (this.dom.btnClearAllMeasures) {
      this.dom.btnClearAllMeasures.addEventListener('click', () => {
        this.openConfirmNewModal();
      });
    }

    this.dom.btnConfirmNewClose?.addEventListener('click', () => {
      this.closeConfirmNewModal();
    });

    this.dom.btnCancelNewPiece?.addEventListener('click', () => {
      this.closeConfirmNewModal();
    });

    this.dom.btnExecuteNewPiece?.addEventListener('click', () => {
      this.executeCreateNewPiece();
    });

    this.dom.modalConfirmNewPiece?.addEventListener('click', (e) => {
      if (e.target === this.dom.modalConfirmNewPiece) {
        this.closeConfirmNewModal();
      }
    });

    // Exportar e Importar
    this.dom.btnExport.addEventListener('click', () => this.exportPieceFile());
    this.dom.fileImport.addEventListener('change', (e) => this.handleImportFile(e));

    // Modais
    this.setupMeasureModal();
    this.setupGroupModal();

    // Botões Desfazer & Refazer
    this.dom.btnUndo?.addEventListener('click', () => {
      const action = state.undo();
      if (action) {
        this.showToast(`Desfez: ${action}`, '↩');
      } else {
        this.showToast('Nada a desfazer', 'ℹ️');
      }
    });

    this.dom.btnRedo?.addEventListener('click', () => {
      const action = state.redo();
      if (action) {
        this.showToast(`Refez: ${action}`, '↪');
      } else {
        this.showToast('Nada a refazer', 'ℹ️');
      }
    });

    // Inscrição no estado para re-renderizar quando houver alterações estruturais
    state.subscribe((st, action, isRemote, isLocalOnly) => {
      this.dom.inputPieceName.value = state.name;
      this.dom.inputBaseBpm.value = state.baseBpm;
      this.updateBpmPracticeUI();
      this.updateUndoRedoUI();
      this.renderMeasuresList();
      this.updateHUD(this.playbackTime);
      this.initPresetsDropdown();
      if (this.renderer) {
        this.renderer.markMinimapDirty?.();
        this.renderer.resize();
      }
      this.preparePieceAudio(true);

      // Sincroniza alteração local com o Firebase na nuvem estilo Google Docs (se não for alteração local exclusiva, como treino de BPM)
      if (!isRemote && !isLocalOnly) {
        collab.commitLocalChange(action, state);
      }
    });

    // Atalhos de teclado
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;

      const hasModifier = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      // Atalho Ctrl+Z / Cmd+Z: Desfazer
      if (hasModifier && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        const action = state.undo();
        if (action) {
          this.showToast(`Desfez: ${action}`, '↩');
        } else {
          this.showToast('Nada a desfazer', 'ℹ️');
        }
        return;
      }

      // Atalho Ctrl+Y ou Ctrl+Shift+Z / Cmd+Shift+Z: Refazer
      if (hasModifier && ((key === 'z' && e.shiftKey) || key === 'y')) {
        e.preventDefault();
        const action = state.redo();
        if (action) {
          this.showToast(`Refez: ${action}`, '↪');
        } else {
          this.showToast('Nada a refazer', 'ℹ️');
        }
        return;
      }

      if (hasModifier && key === 'n') {
        e.preventDefault();
        this.openConfirmNewModal();
        return;
      }

      if (e.key === 'Escape') {
        if (this.dom.modalJoinCollab && this.dom.modalJoinCollab.style.display === 'flex') {
          this.closeJoinModal();
          return;
        }
        if (this.dom.modalConfirmNewPiece && this.dom.modalConfirmNewPiece.style.display === 'flex') {
          this.closeConfirmNewModal();
          return;
        }
        if (this.dom.modalSharePiece && this.dom.modalSharePiece.style.display === 'flex') {
          this.closeShareModal();
          return;
        }
        if (this.dom.modalVersionHistory && this.dom.modalVersionHistory.style.display === 'flex') {
          this.closeHistoryModal();
          return;
        }
        if (this.selectedMeasureIndices.size > 0) {
          this.closeMeasureToolbar();
          return;
        }
      }

      // Atalho de Excluir compasso(s) selecionado(s) com Delete ou Backspace
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (this.selectedMeasureIndices.size > 0) {
          e.preventDefault();
          this.deleteSelectedMeasures();
          return;
        }
      }

      // Atalho Ctrl+A / Cmd+A: Selecionar todos os compassos
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        this.selectedMeasureIndices.clear();
        for (let i = 0; i < state.measures.length; i++) {
          this.selectedMeasureIndices.add(i);
        }
        this.lastSelectedMeasureIdx = state.measures.length > 0 ? state.measures.length - 1 : null;
        this.syncSelectionUI();
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        this.togglePlayPause();
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        this.stopPlayback();
      } else if (e.key === 'm' || e.key === 'M') {
        this.dom.btnMute.click();
      } else if (e.key === 't' || e.key === 'T') {
        if (!e.ctrlKey && !e.metaKey && !e.altKey) {
          this.dom.btnThemeToggle?.click();
        }
      } else if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        const selIdx = this.renderer?.selectedMeasureIndex;
        if (selIdx !== null && selIdx !== undefined && selIdx > 0) {
          state.moveMeasure(selIdx, selIdx - 1);
          this.handleMeasureSelected(selIdx - 1);
        }
      } else if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        const selIdx = this.renderer?.selectedMeasureIndex;
        if (selIdx !== null && selIdx !== undefined && selIdx < state.measures.length - 1) {
          state.moveMeasure(selIdx, selIdx + 1);
          this.handleMeasureSelected(selIdx + 1);
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.dom.btnPrevMeasure.click();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        this.dom.btnNextMeasure.click();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        const selIdx = this.renderer?.selectedMeasureIndex;
        if (selIdx !== null && selIdx !== undefined && this.dom.modalMeasureEdit.style.display !== 'flex') {
          e.preventDefault();
          state.removeMeasure(selIdx);
          this.closeMeasureToolbar();
        }
      }
    });
  }

  // =========================================================================
  // INTERAÇÕES DA VISÃO CORRIDA (REDIMENSIONAMENTO, SELEÇÃO E CONTEXTO)
  // =========================================================================

  setupRunnerInteractions() {
    // 1. Redimensionador de altura (drag handle)
    const resizer = this.dom.runnerResizer;
    const viewport = this.dom.runnerViewport;
    if (resizer && viewport) {
      const savedH = localStorage.getItem('sergio_runner_height');
      if (savedH) {
        viewport.style.height = `${parseInt(savedH, 10)}px`;
        this.renderer?.resize();
      }

      let isResizing = false;
      let startY = 0;
      let startH = 0;

      resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        startY = e.clientY;
        startH = viewport.getBoundingClientRect().height;
        resizer.classList.add('is-resizing');
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
      });

      window.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const dy = e.clientY - startY;
        const newH = Math.max(180, Math.min(window.innerHeight * 0.8, startH + dy));
        viewport.style.height = `${newH}px`;
        this.renderer?.resize();
      });

      window.addEventListener('mouseup', () => {
        if (!isResizing) return;
        isResizing = false;
        resizer.classList.remove('is-resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        const finalH = viewport.getBoundingClientRect().height;
        localStorage.setItem('sergio_runner_height', Math.round(finalH));
      });

      resizer.addEventListener('dblclick', () => {
        viewport.style.height = '340px';
        localStorage.setItem('sergio_runner_height', 340);
        this.renderer?.resize();
      });
    }

    // 2. Modo Amplo (Toma toda a largura da tela)
    if (this.dom.btnToggleWideMode) {
      const mainStage = document.querySelector('.main-stage');
      const isWide = localStorage.getItem('sergio_wide_mode') === 'true';
      if (isWide && mainStage) {
        mainStage.classList.add('wide-mode');
        this.dom.btnToggleWideMode.textContent = '⤡ Padrão';
      }

      this.dom.btnToggleWideMode.addEventListener('click', () => {
        if (!mainStage) return;
        const nowWide = mainStage.classList.toggle('wide-mode');
        this.dom.btnToggleWideMode.textContent = nowWide ? '⤡ Padrão' : '⤢ Amplo';
        localStorage.setItem('sergio_wide_mode', nowWide);
        setTimeout(() => this.renderer?.resize(), 60);
      });
    }

    // 3. Barra de ferramentas do compasso selecionado
    this.dom.btnMoveMeasureLeft?.addEventListener('click', () => {
      const idx = this.renderer?.selectedMeasureIndex;
      if (idx !== null && idx !== undefined && idx > 0) {
        state.moveMeasure(idx, idx - 1);
        this.handleMeasureSelected(idx - 1);
      }
    });

    this.dom.btnMoveMeasureRight?.addEventListener('click', () => {
      const idx = this.renderer?.selectedMeasureIndex;
      if (idx !== null && idx !== undefined && idx < state.measures.length - 1) {
        state.moveMeasure(idx, idx + 1);
        this.handleMeasureSelected(idx + 1);
      }
    });

    this.dom.btnGroupSelectedMeasures?.addEventListener('click', () => {
      if (this.selectedMeasureIndices.size === 0) return;
      const indices = Array.from(this.selectedMeasureIndices);
      const minIdx = Math.min(...indices);
      const maxIdx = Math.max(...indices);
      this.openGroupModalWithRange(minIdx, maxIdx);
    });

    this.dom.btnConfigureSelectedMeasure?.addEventListener('click', () => {
      const idx = this.renderer?.selectedMeasureIndex;
      if (idx !== null && idx !== undefined) {
        this.openMeasureModal(idx);
      }
    });

    this.dom.btnDuplicateSelectedMeasure?.addEventListener('click', () => {
      this.duplicateSelectedMeasures();
    });

    this.dom.btnDeleteSelectedMeasure?.addEventListener('click', () => {
      this.deleteSelectedMeasures();
    });

    this.dom.btnCloseToolbar?.addEventListener('click', () => {
      this.closeMeasureToolbar();
    });

    // 4. Menu de Contexto
    this.dom.ctxEdit?.addEventListener('click', () => {
      if (this._contextMeasureIdx !== undefined) {
        this.openMeasureModal(this._contextMeasureIdx);
      }
      this.closeContextMenu();
    });

    this.dom.ctxMoveLeft?.addEventListener('click', () => {
      if (this._contextMeasureIdx !== undefined && this._contextMeasureIdx > 0) {
        state.moveMeasure(this._contextMeasureIdx, this._contextMeasureIdx - 1);
        this.handleMeasureSelected(this._contextMeasureIdx - 1);
      }
      this.closeContextMenu();
    });

    this.dom.ctxMoveRight?.addEventListener('click', () => {
      if (this._contextMeasureIdx !== undefined && this._contextMeasureIdx < state.measures.length - 1) {
        state.moveMeasure(this._contextMeasureIdx, this._contextMeasureIdx + 1);
        this.handleMeasureSelected(this._contextMeasureIdx + 1);
      }
      this.closeContextMenu();
    });

    this.dom.ctxDuplicate?.addEventListener('click', () => {
      if (this._contextMeasureIdx !== undefined) {
        state.duplicateMeasure(this._contextMeasureIdx);
      }
      this.closeContextMenu();
    });

    this.dom.ctxDelete?.addEventListener('click', () => {
      if (this._contextMeasureIdx !== undefined) {
        const idx = this._contextMeasureIdx;
        state.removeMeasure(idx);
        if (state.measures.length > 0) {
          const nextIdx = Math.min(idx, state.measures.length - 1);
          this.handleMeasureSelected(nextIdx);
          const t = state.getFirstTimingForMeasure(nextIdx);
          if (t) this.seekTo(t.startTime);
        } else {
          this.closeMeasureToolbar();
        }
      }
      this.closeContextMenu();
    });

    window.addEventListener('click', (e) => {
      if (!e.target.closest('#runnerContextMenu')) {
        this.closeContextMenu();
      }
    });
  }

  handleMeasureSelected(idx, event = null) {
    if (idx < 0 || idx >= state.measures.length) {
      this.closeMeasureToolbar();
      return;
    }

    if (event && event.shiftKey && this.lastSelectedMeasureIdx !== null) {
      // Seleção em intervalo contínuo com SHIFT
      const start = Math.min(this.lastSelectedMeasureIdx, idx);
      const end = Math.max(this.lastSelectedMeasureIdx, idx);

      if (!event.ctrlKey && !event.metaKey) {
        this.selectedMeasureIndices.clear();
      }
      for (let i = start; i <= end; i++) {
        this.selectedMeasureIndices.add(i);
      }
    } else if (event && (event.ctrlKey || event.metaKey)) {
      // Toggle individual com CTRL / CMD
      if (this.selectedMeasureIndices.has(idx)) {
        this.selectedMeasureIndices.delete(idx);
      } else {
        this.selectedMeasureIndices.add(idx);
        this.lastSelectedMeasureIdx = idx;
      }
    } else {
      // Seleção simples sem modificadores
      this.selectedMeasureIndices.clear();
      this.selectedMeasureIndices.add(idx);
      this.lastSelectedMeasureIdx = idx;
    }

    this.syncSelectionUI();
  }

  syncSelectionUI() {
    const count = this.selectedMeasureIndices.size;
    if (count === 0) {
      this.closeMeasureToolbar();
      return;
    }

    const indices = Array.from(this.selectedMeasureIndices).sort((a, b) => a - b);
    const primaryIdx = indices[0];
    const m = state.measures[primaryIdx];

    if (this.renderer) {
      this.renderer.setSelectedMeasures(indices);
      this.renderer.render(this.playbackTime);
    }

    if (this.dom.runnerMeasureToolbar) {
      this.dom.runnerMeasureToolbar.style.display = 'flex';

      if (count > 1) {
        const minIdx = indices[0] + 1;
        const maxIdx = indices[indices.length - 1] + 1;
        this.dom.toolbarMeasureBadge.textContent = `${count} compassos (${minIdx} a ${maxIdx})`;
        this.dom.toolbarMeasureName.textContent = '(Shift para estender seleção)';

        if (this.dom.btnMoveMeasureLeft) this.dom.btnMoveMeasureLeft.style.display = 'none';
        if (this.dom.btnMoveMeasureRight) this.dom.btnMoveMeasureRight.style.display = 'none';
        if (this.dom.btnConfigureSelectedMeasure) this.dom.btnConfigureSelectedMeasure.style.display = 'none';
        if (this.dom.btnGroupSelectedMeasures) this.dom.btnGroupSelectedMeasures.style.display = 'inline-flex';
        if (this.dom.btnDuplicateSelectedMeasure) {
          this.dom.btnDuplicateSelectedMeasure.textContent = `⧉ Duplicar (${count})`;
          this.dom.btnDuplicateSelectedMeasure.style.display = 'inline-flex';
        }
        if (this.dom.btnDeleteSelectedMeasure) {
          this.dom.btnDeleteSelectedMeasure.textContent = `✕ Excluir (${count}) (Del)`;
          this.dom.btnDeleteSelectedMeasure.style.display = 'inline-flex';
        }
      } else {
        this.dom.toolbarMeasureBadge.textContent = `c. ${primaryIdx + 1}`;
        this.dom.toolbarMeasureName.textContent = m?.nickname || '';

        if (this.dom.btnMoveMeasureLeft) {
          this.dom.btnMoveMeasureLeft.style.display = 'inline-flex';
          this.dom.btnMoveMeasureLeft.disabled = (primaryIdx === 0);
        }
        if (this.dom.btnMoveMeasureRight) {
          this.dom.btnMoveMeasureRight.style.display = 'inline-flex';
          this.dom.btnMoveMeasureRight.disabled = (primaryIdx === state.measures.length - 1);
        }
        if (this.dom.btnConfigureSelectedMeasure) this.dom.btnConfigureSelectedMeasure.style.display = 'inline-flex';
        if (this.dom.btnGroupSelectedMeasures) this.dom.btnGroupSelectedMeasures.style.display = 'none';
        if (this.dom.btnDuplicateSelectedMeasure) {
          this.dom.btnDuplicateSelectedMeasure.textContent = '⧉ Duplicar';
          this.dom.btnDuplicateSelectedMeasure.style.display = 'inline-flex';
        }
        if (this.dom.btnDeleteSelectedMeasure) {
          this.dom.btnDeleteSelectedMeasure.textContent = '✕ Excluir (Del)';
          this.dom.btnDeleteSelectedMeasure.style.display = 'inline-flex';
        }
      }
    }

    // Destaque visual na lista de cartões abaixo
    const allCards = document.querySelectorAll('.measure-card');
    allCards.forEach((c, cIdx) => {
      c.classList.toggle('is-selected', this.selectedMeasureIndices.has(cIdx));
    });

    const targetCard = allCards[primaryIdx];
    if (targetCard && count === 1) {
      targetCard.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }

  deleteSelectedMeasures() {
    if (this.selectedMeasureIndices.size === 0) return;
    const indices = Array.from(this.selectedMeasureIndices).sort((a, b) => a - b);
    const count = indices.length;
    const firstDeletedIdx = indices[0];

    state.removeMeasures(indices);

    if (state.measures.length > 0) {
      // Seleciona o mais próximo da direita; se não houver, o da esquerda
      const nextIdx = Math.min(firstDeletedIdx, state.measures.length - 1);
      this.selectedMeasureIndices.clear();
      this.selectedMeasureIndices.add(nextIdx);
      this.lastSelectedMeasureIdx = nextIdx;
      this.syncSelectionUI();

      const t = state.getFirstTimingForMeasure(nextIdx);
      if (t) this.seekTo(t.startTime);
    } else {
      this.closeMeasureToolbar();
    }

    this.showToast(`${count} compasso${count > 1 ? 's' : ''} excluído${count > 1 ? 's' : ''}`, '✕');
  }

  duplicateSelectedMeasures() {
    if (this.selectedMeasureIndices.size === 0) return;
    const indices = Array.from(this.selectedMeasureIndices);
    const count = indices.length;
    const res = state.duplicateMeasures(indices);
    if (res) {
      this.selectedMeasureIndices.clear();
      for (let i = res.start; i <= res.end; i++) {
        this.selectedMeasureIndices.add(i);
      }
      this.lastSelectedMeasureIdx = res.end;
      this.syncSelectionUI();
      this.showToast(`${count} compasso${count > 1 ? 's' : ''} duplicado${count > 1 ? 's' : ''}`, '⧉');
    }
  }

  openGroupModalWithRange(start, end) {
    const modal = this.dom.modalGroupManage;
    if (!modal) return;
    this.populateGroupSelects();
    if (this.dom.newGroupStart) this.dom.newGroupStart.value = start;
    if (this.dom.newGroupEnd) this.dom.newGroupEnd.value = end;
    this.renderExistingGroupsList();
    modal.style.display = 'flex';
    this.dom.newGroupName.focus();
  }

  handleMeasureMoved(fromIdx, toIdx) {
    state.moveMeasure(fromIdx, toIdx);
    this.handleMeasureSelected(toIdx);
  }

  closeMeasureToolbar() {
    this.selectedMeasureIndices.clear();
    this.lastSelectedMeasureIdx = null;
    if (this.renderer) {
      this.renderer.setSelectedMeasures([]);
      this.renderer.render(this.playbackTime);
    }
    if (this.dom.runnerMeasureToolbar) {
      this.dom.runnerMeasureToolbar.style.display = 'none';
    }
    document.querySelectorAll('.measure-card').forEach(c => c.classList.remove('is-selected'));
  }

  openContextMenu(idx, clientX, clientY) {
    const menu = this.dom.runnerContextMenu;
    if (!menu) return;

    this._contextMeasureIdx = idx;
    const m = state.measures[idx];
    const title = m?.nickname ? `c. ${idx + 1} (${m.nickname})` : `Compasso ${idx + 1}`;
    this.dom.ctxMenuHeader.textContent = title;

    this.dom.ctxMoveLeft.disabled = (idx === 0);
    this.dom.ctxMoveRight.disabled = (idx === state.measures.length - 1);

    menu.style.display = 'flex';
    menu.style.left = `${Math.min(window.innerWidth - 200, clientX)}px`;
    menu.style.top = `${Math.min(window.innerHeight - 200, clientY)}px`;
  }

  closeContextMenu() {
    if (this.dom.runnerContextMenu) {
      this.dom.runnerContextMenu.style.display = 'none';
    }
  }

  // =========================================================================
  // GRADE DE COMPASSOS INFERIOR
  // =========================================================================

  renderMeasuresList() {
    const grid = this.dom.measuresGrid;
    const measures = state.measures;

    const totalCount = state.getTotalMeasureCount();
    const uniqueCount = measures.length;
    this.dom.measureCountBadge.textContent = (totalCount !== uniqueCount)
      ? `${totalCount} compassos no total (${uniqueCount} ${uniqueCount === 1 ? 'cartão' : 'cartões'})`
      : `${uniqueCount} ${uniqueCount === 1 ? 'compasso' : 'compassos'}`;

    grid.innerHTML = '';
    this.cachedCards = [];
    this.lastHighlightedIdx = -1;

    if (measures.length === 0) {
      grid.innerHTML = `
        <div class="empty-measures-state">
          <div class="empty-icon">🥁</div>
          <h3 class="empty-title">Nenhum compasso na peça</h3>
          <p class="empty-desc">Esta peça está sem compassos no momento. Adicione compassos para construir sua partitura ou escolha uma peça de exemplo no menu superior.</p>
          <div class="empty-actions">
            <button type="button" class="btn-empty-add" id="btnEmptyAddMeasure">+ Adicionar Primeiro Compasso</button>
          </div>
        </div>
      `;
      const btnAdd = grid.querySelector('#btnEmptyAddMeasure');
      if (btnAdd) {
        btnAdd.addEventListener('click', () => {
          state.addMeasure();
        });
      }
      return;
    }

    measures.forEach((m, idx) => {
      const timing = state.getFirstTimingForMeasure(idx) || { effectiveBpm: state.baseBpm };
      const grp = state.getGroupByMeasureIndex(idx);

      const card = document.createElement('div');
      card.className = 'measure-card';
      if ((m.repeat || 1) > 1) {
        card.classList.add('has-repeats');
      }
      if (this.renderer?.selectedMeasureIndex === idx) {
        card.classList.add('is-selected');
      }
      card.dataset.index = idx;
      card.draggable = true;

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

      const repeatTagHtml = ((m.repeat || 1) > 1)
        ? `<span class="measure-card-repeat-tag" title="Este compasso se repete continuamente ${m.repeat} vezes">×${m.repeat}</span>`
        : '';

      const hasNickname = !!(m.nickname && m.nickname.trim());
      const headerIndexHtml = hasNickname 
        ? `<div class="card-idx-wrap"><span class="measure-card-idx" style="color:${m.color || '#ff334b'}">c. ${idx + 1}</span>${repeatTagHtml}</div>` 
        : `<div class="card-idx-wrap">${repeatTagHtml}</div>`;

      const titleHtml = hasNickname
        ? `<h3 class="measure-card-nickname" title="${m.nickname}">${m.nickname}</h3>`
        : `<h3 class="measure-card-nickname is-unnamed"><span class="measure-card-idx-large" style="color:${m.color || '#ff334b'}">c. ${idx + 1}</span></h3>`;

      card.innerHTML += `
        <div class="measure-card-header">
          ${headerIndexHtml}
          ${groupTagHtml}
        </div>

        <!-- APELIDO DO COMPASSO OU NÚMERO C. X -->
        ${titleHtml}

        <div class="measure-card-details">
          <span class="measure-card-meter">${m.beats}/${m.beatUnit}</span>
          <span class="measure-card-tempo">${tempoDesc}</span>
        </div>

        <!-- CONTROLE RÁPIDO DE REPETIÇÕES -->
        <div class="measure-card-repeat-row">
          <span class="repeat-row-label">Repetir:</span>
          <div class="repeat-stepper">
            <button type="button" class="btn-repeat-step btn-repeat-minus" title="Diminuir repetições">-</button>
            <input type="number" class="input-card-repeat" min="1" max="999" value="${m.repeat || 1}" title="Número de vezes que este compasso se repete">
            <button type="button" class="btn-repeat-step btn-repeat-plus" title="Aumentar repetições">+</button>
          </div>
        </div>

        <div class="measure-card-actions">
          <button type="button" class="btn-card-icon btn-card-move-left" title="Mover Compasso para Trás (←)" ${idx === 0 ? 'disabled style="opacity:0.3;pointer-events:none"' : ''}>◀</button>
          <button type="button" class="btn-card-icon btn-card-move-right" title="Mover Compasso para Frente (→)" ${idx === measures.length - 1 ? 'disabled style="opacity:0.3;pointer-events:none"' : ''}>▶</button>
          <button type="button" class="btn-card-icon btn-card-dup" title="Duplicar Compasso">⧉</button>
          <button type="button" class="btn-card-icon btn-card-del" title="Excluir Compasso">✕</button>
          <button type="button" class="btn-card-edit">Configurar</button>
        </div>
      `;

      // Eventos do controle de repetições rápido
      const btnMinus = card.querySelector('.btn-repeat-minus');
      const btnPlus = card.querySelector('.btn-repeat-plus');
      const inputRepeat = card.querySelector('.input-card-repeat');

      if (btnMinus) {
        btnMinus.addEventListener('dblclick', (e) => e.stopPropagation());
        btnMinus.addEventListener('click', (e) => {
          e.stopPropagation();
          const cur = Math.max(1, (m.repeat || 1) - 1);
          state.updateMeasure(idx, { repeat: cur });
        });
      }

      if (btnPlus) {
        btnPlus.addEventListener('dblclick', (e) => e.stopPropagation());
        btnPlus.addEventListener('click', (e) => {
          e.stopPropagation();
          const cur = Math.min(999, (m.repeat || 1) + 1);
          state.updateMeasure(idx, { repeat: cur });
        });
      }

      if (inputRepeat) {
        inputRepeat.addEventListener('dblclick', (e) => e.stopPropagation());
        inputRepeat.addEventListener('click', (e) => e.stopPropagation());
        inputRepeat.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            inputRepeat.blur();
          }
        });
        inputRepeat.addEventListener('change', (e) => {
          e.stopPropagation();
          const parsed = Math.max(1, Math.min(999, parseInt(inputRepeat.value, 10) || 1));
          if (parsed !== (m.repeat || 1)) {
            state.updateMeasure(idx, { repeat: parsed });
          }
        });
      }

      // Previne propagação de dblclick em todos os botões internos do cartão
      card.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('dblclick', (e) => e.stopPropagation());
      });

      // Eventos de clique nas ações e no cartão
      card.addEventListener('click', (e) => {
        if (e.target.closest('.btn-card-move-left')) {
          e.stopPropagation();
          state.moveMeasure(idx, idx - 1);
          this.handleMeasureSelected(idx - 1);
          return;
        }
        if (e.target.closest('.btn-card-move-right')) {
          e.stopPropagation();
          state.moveMeasure(idx, idx + 1);
          this.handleMeasureSelected(idx + 1);
          return;
        }
        if (e.target.closest('.btn-card-del')) {
          e.stopPropagation();
          state.removeMeasure(idx);
          if (state.measures.length > 0) {
            const nextIdx = Math.min(idx, state.measures.length - 1);
            this.handleMeasureSelected(nextIdx);
            const t = state.getFirstTimingForMeasure(nextIdx);
            if (t) this.seekTo(t.startTime);
          } else {
            this.closeMeasureToolbar();
          }
          return;
        }
        if (e.target.closest('.btn-card-dup')) {
          e.stopPropagation();
          state.duplicateMeasure(idx);
          return;
        }
        if (e.target.closest('.btn-card-edit')) {
          e.stopPropagation();
          this.openMeasureModal(idx);
          return;
        }

        // Clique no cartão seleciona e navega (com suporte a Shift e Ctrl)
        this.handleMeasureSelected(idx, e);
        const t = state.getFirstTimingForMeasure(idx);
        if (t && !e.shiftKey) this.seekTo(t.startTime);
      });

      card.addEventListener('dblclick', (e) => {
        // Ignora duplo clique em botões internos, inputs ou controles (ex: cliques rápidos no + ou - de repetições)
        if (e.target.closest('button, input, select, textarea, .card-actions, .card-repeat-box, .btn-repeat-step, .btn-card-icon, .btn-card-edit')) {
          return;
        }
        this.openMeasureModal(idx);
      });

      // Arrastar e soltar cartões para reordenar
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', idx);
        card.classList.add('is-drag-source');
      });

      card.addEventListener('dragend', () => {
        card.classList.remove('is-drag-source');
        document.querySelectorAll('.measure-card').forEach(c => c.classList.remove('is-drag-target'));
      });

      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        card.classList.add('is-drag-target');
      });

      card.addEventListener('dragleave', () => {
        card.classList.remove('is-drag-target');
      });

      card.addEventListener('drop', (e) => {
        e.preventDefault();
        card.classList.remove('is-drag-target');
        const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (!isNaN(fromIdx) && fromIdx !== idx) {
          state.moveMeasure(fromIdx, idx);
          this.handleMeasureSelected(idx);
        }
      });

      grid.appendChild(card);
      this.cachedCards.push(card);
    });
  }

  // =========================================================================
  // MODAL DE CONFIRMAÇÃO: NOVO ARQUIVO (DOUBLE CHECK)
  // =========================================================================

  openConfirmNewModal() {
    if (this.dom.modalConfirmNewPiece) {
      this.dom.modalConfirmNewPiece.style.display = 'flex';
      this.dom.btnExecuteNewPiece?.focus();
    }
  }

  closeConfirmNewModal() {
    if (this.dom.modalConfirmNewPiece) {
      this.dom.modalConfirmNewPiece.style.display = 'none';
    }
  }

  executeCreateNewPiece() {
    this.stopPlayback();
    this.closeMeasureToolbar();

    // Se estiver em uma sala com link compartilhado antigo (?p=...), limpa da URL para não sobrescrever a sala alheia
    if (typeof window !== 'undefined' && window.history && window.location.search) {
      const url = new URL(window.location.href);
      if (url.searchParams.has('p') || url.searchParams.has('piece')) {
        url.searchParams.delete('p');
        url.searchParams.delete('piece');
        window.history.pushState({}, '', url.pathname + (url.search ? url.search : ''));
      }
    }

    state.createNewPiece("Nova Peça", 120);

    // Reconecta à nova peça no Firebase Collab com seu ID exclusivo
    collab.connectToPiece(state.id, state);

    if (this.dom.inputPieceName) this.dom.inputPieceName.value = state.name;
    if (this.dom.inputBaseBpm) this.dom.inputBaseBpm.value = state.baseBpm;
    this.initPresetsDropdown();
    this.closeConfirmNewModal();
    this.showToast("Nova peça criada! A peça anterior foi salva em 'Minhas Peças'.", "✨");
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
      if (state.measures.length > 0) {
        const nextIdx = Math.min(idx, state.measures.length - 1);
        this.handleMeasureSelected(nextIdx);
        const t = state.getFirstTimingForMeasure(nextIdx);
        if (t) this.seekTo(t.startTime);
      } else {
        this.closeMeasureToolbar();
      }
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
        repeat: Math.max(1, Math.min(999, parseInt(this.dom.editRepeat.value, 10) || 1)),
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
    this.dom.editNickname.value = m.nickname || '';
    this.dom.editBeats.value = m.beats;
    this.dom.editBeatUnit.value = m.beatUnit;
    this.dom.editRepeat.value = m.repeat || 1;

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
      if (state.measures.length === 0) return;
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
    const submitBtn = this.dom.formCreateGroup?.querySelector('button[type="submit"]');

    startSelect.innerHTML = '';
    endSelect.innerHTML = '';

    if (state.measures.length === 0) {
      startSelect.innerHTML = '<option value="" disabled selected>Nenhum compasso disponível</option>';
      endSelect.innerHTML = '<option value="" disabled selected>Nenhum compasso disponível</option>';
      if (submitBtn) submitBtn.disabled = true;
      return;
    }

    if (submitBtn) submitBtn.disabled = false;

    state.measures.forEach((m, idx) => {
      const optText = (m.nickname && m.nickname.trim())
        ? `c. ${idx + 1} - ${m.nickname}`
        : `c. ${idx + 1}`;
      startSelect.innerHTML += `<option value="${idx}">${optText}</option>`;
      endSelect.innerHTML += `<option value="${idx}">${optText}</option>`;
    });

    startSelect.selectedIndex = 0;
    endSelect.selectedIndex = Math.min(3, state.measures.length - 1);
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
    if (!select) return;
    select.innerHTML = '';

    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.disabled = true;
    defaultOpt.selected = true;
    defaultOpt.textContent = 'Peças & Modelos...';
    select.appendChild(defaultOpt);

    const actionGroup = document.createElement('optgroup');
    actionGroup.label = 'Ações da Peça';

    const newOpt = document.createElement('option');
    newOpt.value = '__new_piece__';
    newOpt.textContent = '✨ Nova Peça (Salva a atual)';
    actionGroup.appendChild(newOpt);

    const resetOpt = document.createElement('option');
    resetOpt.value = '__reset_default__';
    resetOpt.textContent = '🔄 Restaurar Estudo Padrão';
    actionGroup.appendChild(resetOpt);

    select.appendChild(actionGroup);

    // 📁 Grupo de Minhas Peças Salvas Localmente
    const libraryPieces = state.getLibraryPieces ? state.getLibraryPieces() : [];
    if (libraryPieces.length > 0) {
      const libraryGroup = document.createElement('optgroup');
      libraryGroup.label = '📁 Minhas Peças Salvas';

      libraryPieces.forEach(p => {
        const opt = document.createElement('option');
        opt.value = `lib_${p.id}`;
        const isCurrent = p.id === state.id;
        const count = p.measures?.length || 0;
        opt.textContent = `${isCurrent ? '▶ ' : ''}${p.name || 'Sem Nome'} (${count} comp.)`;
        if (isCurrent) opt.selected = true;
        libraryGroup.appendChild(opt);
      });

      select.appendChild(libraryGroup);
    }

    // 🎼 Grupo de Estudos Didáticos
    const presetsGroup = document.createElement('optgroup');
    presetsGroup.label = 'Estudos Didáticos';

    PRESETS.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      presetsGroup.appendChild(opt);
    });

    select.appendChild(presetsGroup);

    if (!select._hasChangeListener) {
      select._hasChangeListener = true;
      select.addEventListener('change', (e) => {
        const val = e.target.value;
        if (val === '__new_piece__' || val === '__empty__') {
          select.value = '';
          this.openConfirmNewModal();
          return;
        }
        if (val.startsWith('lib_')) {
          const pieceId = val.replace('lib_', '');
          if (pieceId !== state.id) {
            this.pausePlayback();
            const loaded = state.loadPieceFromLibrary(pieceId);
            if (loaded) {
              collab.connectToPiece(state.id, state);
              this.seekTo(0);
              this.closeMeasureToolbar();
              this.showToast(`Peça '${state.name}' carregada!`, '📁');
            }
          }
          this.initPresetsDropdown();
          return;
        }
        if (val === '__reset_default__') {
          this.pausePlayback();
          if (state.measures && state.measures.length > 0) {
            state.saveCurrentPieceToLibrary();
          }
          state.resetToDefault();
          collab.connectToPiece(state.id, state);
          this.seekTo(0);
          this.closeMeasureToolbar();
          this.initPresetsDropdown();
          return;
        }
        const found = PRESETS.find(p => p.id === val);
        if (found) {
          this.pausePlayback();
          if (state.measures && state.measures.length > 0) {
            state.saveCurrentPieceToLibrary();
          }
          state.loadPieceData(JSON.parse(JSON.stringify(found)));
          collab.connectToPiece(state.id, state);
          this.seekTo(0);
          this.closeMeasureToolbar();
          this.initPresetsDropdown();
        }
      });
    }
  }

  /* ==========================================================================
     SISTEMA DE COLABORAÇÃO & HISTÓRICO NA NUVEM (GOOGLE CLOUD FIRESTORE)
     ========================================================================== */

  setupCollab() {
    collab.onRemoteStateChange = (remoteData) => {
      state.loadPieceData(remoteData, true);
      if (this.dom.joinPieceTitleHeading && remoteData.name) {
        this.dom.joinPieceTitleHeading.textContent = `Peça: "${remoteData.name}"`;
      }
      this.showToast(`${remoteData.updatedBy?.name || 'Alguém'} atualizou a peça`, '🔄');
    };

    collab.onHistoryChange = (historyList) => {
      if (this.dom.historyBadgeCount) {
        this.dom.historyBadgeCount.textContent = historyList.length;
      }
      if (this.dom.historyTotalCount) {
        this.dom.historyTotalCount.textContent = `${historyList.length} alterações salvas`;
      }
      this.renderHistoryList(historyList);
    };

    collab.onPresenceChange = (activeUsers) => {
      this.renderPresenceAvatars(activeUsers);
      this.renderCollabModalUsers(activeUsers);
    };

    collab.onSyncStatusChange = (status, text) => {
      this.updateSyncStatus(status, text);
    };

    // Conexão inicial: Se houver ?piece= na URL, conecta àquela peça; se não, sincroniza com o ID da peça atual
    const urlPieceId = collab.getPieceIdFromUrl();
    if (urlPieceId) {
      collab.connectToPiece(urlPieceId, state);
      this.checkJoinModalOnSharedLink(urlPieceId);
    } else {
      collab.connectToPiece(state.id, state);
    }
  }

  updateSyncStatus(status, text) {
    const pill = this.dom.cloudStatusPill;
    const label = this.dom.cloudStatusText;
    if (!pill || !label) return;

    pill.className = `cloud-status-pill ${status}`;
    label.textContent = text || (status === 'synced' ? 'Nuvem OK' : 'Sincronizando...');
    pill.title = `Firebase Firestore (São Paulo): ${text}`;
  }

  renderPresenceAvatars(activeUsers) {
    const row = this.dom.presenceRow;
    if (!row) return;
    row.innerHTML = '';

    const maxAvatars = 4;
    const displayUsers = activeUsers.slice(0, maxAvatars);

    displayUsers.forEach(u => {
      const pill = document.createElement('div');
      pill.className = 'presence-avatar-pill';
      pill.style.backgroundColor = u.color || '#3b82f6';
      const initial = (u.name || 'U').charAt(0).toUpperCase();
      pill.textContent = initial;
      const isMe = u.id === collab.localUser.id;
      pill.title = isMe ? `${u.name} (Você - clique para editar seu perfil)` : u.name;
      if (isMe) {
        pill.style.cursor = 'pointer';
        pill.addEventListener('click', () => this.openShareModal());
      }
      row.appendChild(pill);
    });

    if (activeUsers.length > maxAvatars) {
      const more = document.createElement('div');
      more.className = 'presence-avatar-pill';
      more.style.backgroundColor = '#64748b';
      more.textContent = `+${activeUsers.length - maxAvatars}`;
      more.title = `${activeUsers.length - maxAvatars} outros colaboradores online`;
      row.appendChild(more);
    }
  }

  renderCollabModalUsers(activeUsers) {
    if (this.dom.onlineCountBadge) {
      this.dom.onlineCountBadge.textContent = `${activeUsers.length} online`;
    }
    const list = this.dom.collabUsersList;
    if (!list) return;
    list.innerHTML = '';

    if (activeUsers.length === 0) {
      list.innerHTML = `<span style="font-size:0.75rem; color:var(--white-muted)">Apenas você nesta sala</span>`;
      return;
    }

    activeUsers.forEach(u => {
      const isMe = u.id === collab.localUser.id;
      const chip = document.createElement('div');
      chip.className = 'collab-user-chip';
      chip.innerHTML = `
        <span class="user-chip-dot" style="background:${u.color || '#3b82f6'}">${(u.name || 'U').charAt(0).toUpperCase()}</span>
        <span>${u.name || 'Anônimo'}</span>
        ${isMe ? '<span class="user-chip-you">(você)</span>' : ''}
      `;
      list.appendChild(chip);
    });
  }

  /* ==========================================================================
     MODAL DE COMPARTILHAMENTO
     ========================================================================== */

  setupShareModal() {
    this.dom.btnSharePiece?.addEventListener('click', () => this.openShareModal());
    this.dom.btnShareModalClose?.addEventListener('click', () => this.closeShareModal());

    // Fechar ao clicar no backdrop
    this.dom.modalSharePiece?.addEventListener('click', (e) => {
      if (e.target === this.dom.modalSharePiece) this.closeShareModal();
    });

    // Copiar Link
    this.dom.btnCopyShareUrl?.addEventListener('click', () => this.copyShareUrl());

    // Configuração do perfil local
    if (this.dom.inputCollabName) {
      this.dom.inputCollabName.value = collab.localUser.name;
      this.dom.inputCollabName.addEventListener('input', (e) => {
        collab.updateProfile(e.target.value);
        this.updateCollabAvatarPreview();
      });
    }

    // Gerador de botões de cor
    if (this.dom.avatarColorPicker) {
      this.dom.avatarColorPicker.innerHTML = '';
      const colors = ['#FF334B', '#3B82F6', '#10B981', '#8B5CF6', '#F59E0B', '#EC4899', '#06B6D4', '#14B8A6'];
      colors.forEach(c => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `avatar-color-btn ${c === collab.localUser.color ? 'selected' : ''}`;
        btn.style.backgroundColor = c;
        btn.title = `Cor ${c}`;
        btn.addEventListener('click', () => {
          this.dom.avatarColorPicker.querySelectorAll('.avatar-color-btn').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
          collab.updateProfile(this.dom.inputCollabName.value, c);
          this.updateCollabAvatarPreview();
        });
        this.dom.avatarColorPicker.appendChild(btn);
      });
    }

    this.updateCollabAvatarPreview();
  }

  updateCollabAvatarPreview() {
    const preview = this.dom.userAvatarPreview;
    if (!preview) return;
    preview.style.backgroundColor = collab.localUser.color;
    preview.textContent = (collab.localUser.name || 'U').charAt(0).toUpperCase();
  }

  openShareModal() {
    if (!this.dom.modalSharePiece) return;

    // Garante que a peça atual está sincronizada na nuvem com o link gerado
    const shareLink = collab.getShareableLink(state.id);
    if (this.dom.inputShareUrl) {
      this.dom.inputShareUrl.value = shareLink;
    }

    if (this.dom.inputCollabName) {
      this.dom.inputCollabName.value = collab.localUser.name;
    }
    this.updateCollabAvatarPreview();
    this.renderCollabModalUsers(collab.activeCollaborators);

    this.dom.modalSharePiece.style.display = 'flex';
  }

  closeShareModal() {
    if (this.dom.modalSharePiece) {
      this.dom.modalSharePiece.style.display = 'none';
    }
  }

  /* ==========================================================================
     MODAL DE ENTRADA NA SESSÃO COMPARTILHADA (IDENTIFICAÇÃO NOME & COR)
     ========================================================================== */

  checkJoinModalOnSharedLink(urlPieceId) {
    if (!urlPieceId) return;
    const sessionKey = `sergio_session_joined_${urlPieceId}`;
    try {
      const alreadyJoinedInThisTab = sessionStorage.getItem(sessionKey);
      if (!alreadyJoinedInThisTab) {
        // Abre o modal de identificação perguntando nome e cor
        this.openJoinModal(urlPieceId);
      }
    } catch (_) {
      this.openJoinModal(urlPieceId);
    }
  }

  setupJoinModal() {
    if (!this.dom.modalJoinCollab) return;

    this.selectedJoinColor = collab.localUser.color || DEFAULT_AVATAR_COLORS[0];

    // Gerador de botões de cor para o modal de entrada
    if (this.dom.joinAvatarColorPicker) {
      this.dom.joinAvatarColorPicker.innerHTML = '';
      DEFAULT_AVATAR_COLORS.forEach(c => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `avatar-color-btn ${c === this.selectedJoinColor ? 'selected' : ''}`;
        btn.style.backgroundColor = c;
        btn.title = `Cor ${c}`;
        btn.innerHTML = c === this.selectedJoinColor ? '✓' : '';
        btn.addEventListener('click', () => {
          this.selectedJoinColor = c;
          this.dom.joinAvatarColorPicker.querySelectorAll('.avatar-color-btn').forEach(b => {
            b.classList.remove('selected');
            b.innerHTML = '';
          });
          btn.classList.add('selected');
          btn.innerHTML = '✓';
          this.updateJoinAvatarPreview();
        });
        this.dom.joinAvatarColorPicker.appendChild(btn);
      });
    }

    // Input do nome do colaborador
    if (this.dom.inputJoinName) {
      this.dom.inputJoinName.addEventListener('input', () => {
        if (this.dom.joinNameError) this.dom.joinNameError.style.display = 'none';
        this.dom.inputJoinName.classList.remove('input-error');
        this.updateJoinAvatarPreview();
      });
    }

    // Fechar ao clicar no backdrop ou botão X
    this.dom.btnJoinModalClose?.addEventListener('click', () => this.closeJoinModal());
    this.dom.modalJoinCollab?.addEventListener('click', (e) => {
      if (e.target === this.dom.modalJoinCollab) this.closeJoinModal();
    });

    // Submissão do formulário
    this.dom.formJoinCollab?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submitJoinCollab();
    });
  }

  updateJoinAvatarPreview() {
    const preview = this.dom.joinAvatarPreview;
    if (!preview) return;
    const name = this.dom.inputJoinName ? this.dom.inputJoinName.value.trim() : '';
    const color = this.selectedJoinColor || collab.localUser.color || DEFAULT_AVATAR_COLORS[0];
    preview.style.backgroundColor = color;
    preview.textContent = name ? name.charAt(0).toUpperCase() : (collab.localUser.name ? collab.localUser.name.charAt(0).toUpperCase() : '?');
    preview.style.boxShadow = `0 0 16px ${color}88`;
  }

  openJoinModal(pieceId) {
    if (!this.dom.modalJoinCollab) return;

    this.currentJoiningPieceId = pieceId;

    if (this.dom.joinPieceTitleHeading) {
      this.dom.joinPieceTitleHeading.textContent = state.name ? `Peça: "${state.name}"` : 'Sessão Colaborativa';
    }

    // Pré-preenche se o usuário já possui um perfil configurado no LocalStorage
    if (this.dom.inputJoinName) {
      const savedProfile = collab.localUser;
      if (collab.hasCustomProfile()) {
        this.dom.inputJoinName.value = savedProfile.name || '';
      } else {
        this.dom.inputJoinName.value = '';
      }
      this.selectedJoinColor = savedProfile.color || DEFAULT_AVATAR_COLORS[0];
    }

    // Atualiza swatches de cor selecionados
    if (this.dom.joinAvatarColorPicker) {
      this.dom.joinAvatarColorPicker.querySelectorAll('.avatar-color-btn').forEach(b => {
        const isMatch = b.style.backgroundColor === this.selectedJoinColor || b.getAttribute('title')?.includes(this.selectedJoinColor);
        if (isMatch) {
          b.classList.add('selected');
          b.innerHTML = '✓';
        } else {
          b.classList.remove('selected');
          b.innerHTML = '';
        }
      });
    }

    this.updateJoinAvatarPreview();
    this.dom.modalJoinCollab.style.display = 'flex';

    setTimeout(() => {
      this.dom.inputJoinName?.focus();
      this.dom.inputJoinName?.select();
    }, 100);
  }

  closeJoinModal() {
    if (this.dom.modalJoinCollab) {
      this.dom.modalJoinCollab.style.display = 'none';
    }
  }

  submitJoinCollab() {
    const name = this.dom.inputJoinName ? this.dom.inputJoinName.value.trim() : '';
    if (!name) {
      if (this.dom.joinNameError) this.dom.joinNameError.style.display = 'block';
      this.dom.inputJoinName?.classList.add('input-error');
      this.dom.inputJoinName?.focus();
      return;
    }

    const color = this.selectedJoinColor || collab.localUser.color || DEFAULT_AVATAR_COLORS[0];

    // Atualiza perfil e salva no LocalStorage
    collab.updateProfile(name, color);

    // Marca esta sessão como ingressada nesta aba para não reabrir em recargas de tela (F5)
    if (this.currentJoiningPieceId) {
      try {
        sessionStorage.setItem(`sergio_session_joined_${this.currentJoiningPieceId}`, 'true');
      } catch (_) {}
    }

    this.closeJoinModal();
    this.updateCollabAvatarPreview();
    if (this.dom.inputCollabName) {
      this.dom.inputCollabName.value = name;
    }

    // Ativa o áudio com o gesto do clique de entrada
    try {
      audio.init();
    } catch (_) {}

    this.showToast(`Bem-vindo(a), ${name}! Você está conectado à peça.`, '👋');
  }

  async copyShareUrl() {
    const link = this.dom.inputShareUrl?.value || collab.getShareableLink(state.id);
    if (!link) return;

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(link);
      } else {
        this.dom.inputShareUrl.select();
        document.execCommand('copy');
      }

      if (this.dom.copyText) this.dom.copyText.textContent = "Link Copiado!";
      if (this.dom.copyIcon) this.dom.copyIcon.textContent = "✓";
      this.showToast("Link copiado para a área de transferência! Qualquer pessoa pode editar.", "🔗");

      setTimeout(() => {
        if (this.dom.copyText) this.dom.copyText.textContent = "Copiar Link";
        if (this.dom.copyIcon) this.dom.copyIcon.textContent = "📋";
      }, 2500);
    } catch (err) {
      console.warn("Falha ao copiar:", err);
      this.dom.inputShareUrl.select();
      this.showToast("Selecione e copie o link acima manualmente.", "ℹ️");
    }
  }

  /* ==========================================================================
     MODAL DE HISTÓRICO DE VERSÕES (ATÉ 200 ALTERAÇÕES NA NUVEM)
     ========================================================================== */

  setupHistoryModal() {
    this.dom.btnOpenHistory?.addEventListener('click', () => this.openHistoryModal());
    this.dom.btnHistoryModalClose?.addEventListener('click', () => this.closeHistoryModal());

    // Fechar ao clicar no backdrop
    this.dom.modalVersionHistory?.addEventListener('click', (e) => {
      if (e.target === this.dom.modalVersionHistory) this.closeHistoryModal();
    });
  }

  openHistoryModal() {
    if (!this.dom.modalVersionHistory) return;
    this.renderHistoryList(collab.historyList);
    this.dom.modalVersionHistory.style.display = 'flex';
  }

  closeHistoryModal() {
    if (this.dom.modalVersionHistory) {
      this.dom.modalVersionHistory.style.display = 'none';
    }
  }

  renderHistoryList(historyList) {
    const container = this.dom.historyListContainer;
    if (!container) return;

    if (!historyList || historyList.length === 0) {
      container.innerHTML = `
        <div class="history-empty-state">
          <span>🕒</span>
          <p>Nenhuma alteração registrada ainda nesta peça.</p>
          <span style="font-size:0.75rem; color:var(--white-muted)">Faça qualquer edição (BPM, compassos ou grupos) para gravar na nuvem.</span>
        </div>
      `;
      return;
    }

    container.innerHTML = '';

    historyList.forEach((item, idx) => {
      const card = document.createElement('div');
      card.className = `history-item-card ${idx === 0 ? 'is-current' : ''}`;
      
      const author = item.author || { name: 'Percussionista', color: '#64748b' };
      const initial = (author.name || 'P').charAt(0).toUpperCase();
      const timeAgo = this.formatTimeAgo(item.timestamp);

      card.innerHTML = `
        <div class="history-item-left">
          <div class="history-author-avatar" style="background:${author.color || '#3b82f6'}" title="${author.name}">
            ${initial}
          </div>
          <div class="history-item-details">
            <span class="history-action-text">${item.action || 'Alteração na peça'}</span>
            <div class="history-meta-row">
              <span class="history-author-name">${author.name}</span>
              <span>•</span>
              <span class="history-time">${timeAgo}</span>
              ${item.summary ? `<span>•</span><span class="history-summary">${item.summary}</span>` : ''}
            </div>
          </div>
        </div>
        <button type="button" class="btn-restore-version" title="Restaurar a peça para este momento">
          Restaurar
        </button>
      `;

      const btnRestore = card.querySelector('.btn-restore-version');
      btnRestore.addEventListener('click', () => this.restoreHistoryVersion(item));

      container.appendChild(card);
    });
  }

  restoreHistoryVersion(historyItem) {
    if (!historyItem || !historyItem.snapshot) return;

    const formattedTime = new Date(historyItem.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const authorName = historyItem.author?.name || 'Autor';

    const confirmed = window.confirm(`Deseja restaurar a peça para a versão de ${formattedTime} feita por ${authorName}?`);
    if (!confirmed) return;

    this.pausePlayback();
    // Carrega o snapshot histórico
    state.loadPieceData(historyItem.snapshot);
    this.seekTo(0);
    this.closeHistoryModal();

    this.showToast(`Peça restaurada para a versão de ${formattedTime}`, '🕒');
  }

  formatTimeAgo(timestamp) {
    if (!timestamp) return 'Recentemente';
    const now = Date.now();
    const diffSec = Math.floor((now - timestamp) / 1000);

    if (diffSec < 10) return 'Agora mesmo';
    if (diffSec < 60) return `Há ${diffSec}s`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `Há ${diffMin} min`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `Há ${diffHour}h`;
    const date = new Date(timestamp);
    return date.toLocaleDateString([], { day: '2-digit', month: '2-digit' }) + ' ' + 
           date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /* ==========================================================================
     TOAST NOTIFICATION FLUTUANTE
     ========================================================================== */

  showToast(message, icon = '✓') {
    const toast = this.dom.toastNotification;
    if (!toast) return;

    if (this.dom.toastIcon) this.dom.toastIcon.textContent = icon;
    if (this.dom.toastMessage) this.dom.toastMessage.textContent = message;

    toast.style.display = 'flex';
    // Força reflow para animação css
    toast.offsetHeight;
    toast.classList.add('show');

    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => {
        toast.style.display = 'none';
      }, 300);
    }, 2800);
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

// Inicialização robusta da aplicação ao carregar a página
function startApp() {
  if (window.__sergioApp) return;
  const app = new SergioApp();
  app.init();
  window.__sergioApp = app;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startApp);
} else {
  startApp();
}
