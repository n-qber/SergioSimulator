/**
 * Sérgio Simulator - Controlador Principal (Main)
 * Motor de tempo sample-accurate sem jitter, sem lentidão na troca de compassos e sem atraso no play.
 */

import { state } from './state.js';
import { audio } from './audio.js';
import { PRESETS } from './presets.js';
import { DJRunnerRenderer } from './renderer.js';
import { collab, DEFAULT_AVATAR_COLORS } from './collab.js';
import { authService } from './auth.js';

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
    this.authService = authService;
    this.authModalMode = 'login';
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

    // Gestão de Bossas Embutidas & Gerenciador
    this.selectedBossaPiece = null;
    this.currentBossaTab = 'library';
    this.bossaTargetIndex = null;
    this._saveBossaIndices = [];
    this.currentMgrFilter = 'all';
    this.mgrSearchQuery = '';
    this.activePreviewBossaId = null;
    this.currentView = 'simulator'; // 'simulator' | 'bossas'
    this.previousMobileTab = 'stage';

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
    this.setupAuth();
    this.setupShareModal();
    this.setupAccessControlUi();
    this.setupHistoryModal();
    this.setupJoinModal();
    this.setupBossaModals();
    this.updateBpmPracticeUI();
    this.updateUndoRedoUI();
    this.setupMobileNav();
    this.renderQuickMeasureStrip();
    this.setupPwa();
    this.setupRouting();

    // Sincroniza bossas com a nuvem na inicialização se o usuário já estiver conectado
    if (this.authService && this.authService.isLoggedIn()) {
      collab.syncUserLibraryWithCloud(state).then(() => {
        this.initPresetsDropdown();
      }).catch(() => {});
    }

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

    // Sincronização automática contínua em segundo plano (ao focar aba, reconectar ou trocar de dispositivo)
    window.addEventListener('focus', () => {
      if (this.authService && this.authService.isLoggedIn()) {
        this.handleSyncBossas(false);
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.authService && this.authService.isLoggedIn()) {
        this.handleSyncBossas(false);
      }
    });

    window.addEventListener('online', () => {
      if (this.authService && this.authService.isLoggedIn()) {
        this.handleSyncBossas(false);
      }
    });

    setInterval(() => {
      if (this.authService && this.authService.isLoggedIn() && !document.hidden) {
        this.handleSyncBossas(false);
      }
    }, 45000);

    // Loop de renderização visual (requestAnimationFrame 60 FPS)
    this.lastFrameTime = performance.now();
    requestAnimationFrame((t) => this.renderLoop(t));
  }

  initTheme() {
    const savedTheme = localStorage.getItem('sergio_theme') || 
      (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    this.setTheme(savedTheme);

    const toggleTheme = () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = current === 'light' ? 'dark' : 'light';
      this.setTheme(next);
      if (this.renderer) {
        this.renderer.render(this.playbackTime);
      }
    };

    this.dom.btnThemeToggle?.addEventListener('click', toggleTheme);
    this.dom.btnThemeToggleBossaMgr?.addEventListener('click', toggleTheme);
  }

  setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('sergio_theme', theme);
    if (this.dom.themeIcon) {
      this.dom.themeIcon.textContent = theme === 'light' ? '🌙' : '☀️';
    }
    if (this.dom.themeIconBossaMgr) {
      this.dom.themeIconBossaMgr.textContent = theme === 'light' ? '🌙' : '☀️';
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
      fileImport: document.getElementById('fileImport') || document.getElementById('inputImport'),
      btnNewPiece: document.getElementById('btnNewPiece'),
      btnSavePieceToLibrary: document.getElementById('btnSavePieceToLibrary'),
      btnUndo: document.getElementById('btnUndo'),
      btnRedo: document.getElementById('btnRedo'),
      btnThemeToggle: document.getElementById('btnThemeToggle'),
      themeIcon: document.getElementById('themeIcon'),
      btnAppMenu: document.getElementById('btnAppMenu'),
      appMenuDropdown: document.getElementById('appMenuDropdown'),
      saveIndicator: document.getElementById('syncStatusPill') || document.getElementById('saveIndicator'),
      syncStatusPill: document.getElementById('syncStatusPill'),
      syncStatusText: document.getElementById('syncStatusText'),
      syncStatusIcon: document.getElementById('syncStatusIcon'),
      btnMute: document.getElementById('btnMute'),
      muteIcon: document.getElementById('muteIcon'),
      selectSoundType: document.getElementById('selectSoundType'),

      // Nuvem, Colaboração e Histórico
      cloudStatusPill: document.getElementById('syncStatusPill') || document.getElementById('cloudStatusPill'),
      cloudStatusText: document.getElementById('syncStatusText') || document.getElementById('cloudStatusText'),
      presenceRow: document.getElementById('presenceRow'),
      btnOpenHistory: document.getElementById('btnOpenHistory'),
      historyBadgeCount: document.getElementById('historyBadgeCount'),
      btnSharePiece: document.getElementById('btnSharePiece'),

      // Perfil e Autenticação
      btnAuth: document.getElementById('btnAuth'),
      userAuthAvatar: document.getElementById('userAuthAvatar'),
      userAuthLabel: document.getElementById('userAuthLabel'),
      userMenuDropdown: document.getElementById('userMenuDropdown'),
      userMenuAvatarLarge: document.getElementById('userMenuAvatarLarge'),
      userMenuName: document.getElementById('userMenuName'),
      userMenuEmail: document.getElementById('userMenuEmail'),
      btnUserCloudPieces: document.getElementById('btnUserCloudPieces'),
      btnUserManageBossas: document.getElementById('btnUserManageBossas'),
      btnUserLogout: document.getElementById('btnUserLogout'),

      // Modo Leitura / Ouvinte
      readOnlyBanner: document.getElementById('readOnlyBanner'),
      btnForkPiece: document.getElementById('btnForkPiece'),

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

      // Controle de Acesso no Modal de Compartilhar
      radioAccessPrivate: document.getElementById('radioAccessPrivate'),
      radioAccessView: document.getElementById('radioAccessView'),
      radioAccessEdit: document.getElementById('radioAccessEdit'),
      accessLoginRequiredNotice: document.getElementById('accessLoginRequiredNotice'),
      btnNoticeLogin: document.getElementById('btnNoticeLogin'),
      labelShareUrl: document.getElementById('labelShareUrl'),
      hintShareUrl: document.getElementById('hintShareUrl'),

      // Modal de Autenticação
      modalAuth: document.getElementById('modalAuth'),
      btnAuthModalClose: document.getElementById('btnAuthModalClose'),
      btnGoogleSignIn: document.getElementById('btnGoogleSignIn'),
      formAuthEmail: document.getElementById('formAuthEmail'),
      inputAuthName: document.getElementById('inputAuthName'),
      inputAuthEmail: document.getElementById('inputAuthEmail'),
      inputAuthPassword: document.getElementById('inputAuthPassword'),
      btnForgotPass: document.getElementById('btnForgotPass'),
      btnAuthSubmit: document.getElementById('btnAuthSubmit'),
      btnAuthToggleMode: document.getElementById('btnAuthToggleMode'),
      authAlertBox: document.getElementById('authAlertBox'),
      groupAuthName: document.getElementById('groupAuthName'),
      groupAuthPassword: document.getElementById('groupAuthPassword'),
      authModalTitle: document.getElementById('authModalTitle'),
      authModalSubtitle: document.getElementById('authModalSubtitle'),
      authTogglePrompt: document.getElementById('authTogglePrompt'),

      // Modal de Acesso Negado
      modalAccessDenied: document.getElementById('modalAccessDenied'),
      btnAccessDeniedGoHome: document.getElementById('btnAccessDeniedGoHome'),
      btnAccessDeniedLogin: document.getElementById('btnAccessDeniedLogin'),

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
      inputNewPieceName: document.getElementById('inputNewPieceName'),

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
      ctxDelete: document.getElementById('ctxDelete'),

      // Navegação Mobile & Floating Play
      mobileBottomNav: document.getElementById('mobileBottomNav'),
      tabNavStage: document.getElementById('tabNavStage'),
      tabNavMeasures: document.getElementById('tabNavMeasures'),
      tabNavPiece: document.getElementById('tabNavPiece'),
      tabMeasuresBadge: document.getElementById('tabMeasuresBadge'),
      btnFloatingPlay: document.getElementById('btnFloatingPlay'),
      floatingPlayIcon: document.getElementById('floatingPlayIcon'),
      floatingPauseIcon: document.getElementById('floatingPauseIcon'),
      measureQuickCarouselWrap: document.getElementById('measureQuickCarouselWrap'),
      measureQuickStrip: document.getElementById('measureQuickStrip'),
      measuresSection: document.getElementById('measuresSection'),
      stageContainer: document.querySelector('.stage-container'),
      headerRightArea: document.getElementById('headerRightArea'),
      btnInstallPwa: document.getElementById('btnInstallPwa'),

      // Modais e Controles de Bossa Embutida
      measureBossaBanner: document.getElementById('measureBossaBanner'),
      bossaBannerName: document.getElementById('bossaBannerName'),
      btnMeasureUnlinkModal: document.getElementById('btnMeasureUnlinkModal'),
      btnMeasureRestoreModal: document.getElementById('btnMeasureRestoreModal'),
      btnOpenInsertBossaModal: document.getElementById('btnOpenInsertBossaModal'),
      btnToolbarInsertBossa: document.getElementById('btnToolbarInsertBossa'),
      btnToolbarSaveAsBossa: document.getElementById('btnToolbarSaveAsBossa'),
      btnMenuInsertBossa: document.getElementById('btnMenuInsertBossa'),
      btnMenuManageBossas: document.getElementById('btnMenuManageBossas'),
      btnOpenBossaManager: document.getElementById('btnOpenBossaManager'),
      btnOpenManagerFromInsert: document.getElementById('btnOpenManagerFromInsert'),
      modalInsertBossa: document.getElementById('modalInsertBossa'),
      btnInsertBossaClose: document.getElementById('btnInsertBossaClose'),
      btnCancelInsertBossa: document.getElementById('btnCancelInsertBossa'),
      btnConfirmInsertBossa: document.getElementById('btnConfirmInsertBossa'),
      bossaListContainer: document.getElementById('bossaListContainer'),
      tabBossaLibrary: document.getElementById('tabBossaLibrary'),
      tabBossaPresets: document.getElementById('tabBossaPresets'),
      radioBossaPosEnd: document.getElementById('radioBossaPosEnd'),
      radioBossaPosSelected: document.getElementById('radioBossaPosSelected'),
      labelBossaPosSelected: document.getElementById('labelBossaPosSelected'),
      radioBossaModeLinked: document.getElementById('radioBossaModeLinked'),
      radioBossaModeUnlinked: document.getElementById('radioBossaModeUnlinked'),
      modalSaveAsBossa: document.getElementById('modalSaveAsBossa'),
      btnSaveAsBossaClose: document.getElementById('btnSaveAsBossaClose'),
      btnCancelSaveAsBossa: document.getElementById('btnCancelSaveAsBossa'),
      btnConfirmSaveAsBossa: document.getElementById('btnConfirmSaveAsBossa'),
      saveAsBossaCount: document.getElementById('saveAsBossaCount'),
      inputBossaName: document.getElementById('inputBossaName'),
      radioSaveTypeBossa: document.getElementById('radioSaveTypeBossa'),
      radioSaveTypePiece: document.getElementById('radioSaveTypePiece'),
      labelSaveItemName: document.getElementById('labelSaveItemName'),
      modalSaveAsBossaHeading: document.getElementById('modalSaveAsBossaHeading'),
      btnConfirmSaveAsBossaText: document.getElementById('btnConfirmSaveAsBossaText'),
      // Página Dedicada do Gerenciador de Bossas (SPA)
      viewSimulator: document.getElementById('viewSimulator'),
      viewBossaManager: document.getElementById('viewBossaManager'),
      modalBossaManager: document.getElementById('viewBossaManager'), // fallback compatível
      btnNavSimulator: document.getElementById('btnNavSimulator'),
      btnNavRepertoire: document.getElementById('btnNavRepertoire'),
      btnBackToSimulator: document.getElementById('btnBackToSimulator'),
      btnBackToSimulatorBottom: document.getElementById('btnBackToSimulatorBottom'),
      btnThemeToggleBossaMgr: document.getElementById('btnThemeToggleBossaMgr'),
      themeIconBossaMgr: document.getElementById('themeIconBossaMgr'),
      tabNavBossas: document.getElementById('tabNavBossas'),
      statTotalBossas: document.getElementById('statTotalBossas'),
      statMyPieces: document.getElementById('statMyPieces'),
      statMyBossas: document.getElementById('statMyBossas'),
      statCloudBossas: document.getElementById('statCloudBossas'),
      statPresetBossas: document.getElementById('statPresetBossas'),
      bossaMgrSyncIndicator: document.getElementById('bossaMgrSyncIndicator'),
      bossaSyncDot: document.getElementById('bossaSyncDot'),
      bossaMgrSyncText: document.getElementById('bossaMgrSyncText'),
      btnMgrCreateNewBlankPiece: document.getElementById('btnMgrCreateNewBlankPiece'),
      btnMgrSaveCurrentPiece: document.getElementById('btnMgrSaveCurrentPiece'),
      btnMgrNewBossaFromCurrent: document.getElementById('btnMgrNewBossaFromCurrent'),
      fileImportBossa: document.getElementById('fileImportBossa'),
      inputSearchBossas: document.getElementById('inputSearchBossas'),
      btnClearSearchBossas: document.getElementById('btnClearSearchBossas'),
      bossaMgrCardsContainer: document.getElementById('bossaMgrCardsContainer'),
      bossaMgrStats: document.getElementById('bossaMgrStats'),
      countFilterAll: document.getElementById('countFilterAll'),
      countFilterPieces: document.getElementById('countFilterPieces'),
      countFilterBossas: document.getElementById('countFilterBossas'),
      countFilterMy: document.getElementById('countFilterMy'),
      countFilterCloud: document.getElementById('countFilterCloud'),
      countFilterPresets: document.getElementById('countFilterPresets'),
      btnClearAllPresets: document.getElementById('btnClearAllPresets'),
      btnRestorePresets: document.getElementById('btnRestorePresets'),
      btnDeleteCurrentPiece: document.getElementById('btnDeleteCurrentPiece'),
      modalRenameBossa: document.getElementById('modalRenameBossa'),
      btnRenameBossaClose: document.getElementById('btnRenameBossaClose'),
      btnCancelRenameBossa: document.getElementById('btnCancelRenameBossa'),
      btnConfirmRenameBossa: document.getElementById('btnConfirmRenameBossa'),
      formRenameBossa: document.getElementById('formRenameBossa'),
      renameBossaId: document.getElementById('renameBossaId'),
      inputRenameBossaName: document.getElementById('inputRenameBossaName')
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
      if (this.dom.playIcon) this.dom.playIcon.style.display = 'none';
      if (this.dom.pauseIcon) this.dom.pauseIcon.style.display = 'block';
      if (this.dom.floatingPlayIcon) this.dom.floatingPlayIcon.style.display = 'none';
      if (this.dom.floatingPauseIcon) this.dom.floatingPauseIcon.style.display = 'block';
      this.dom.btnFloatingPlay?.classList.add('is-playing');
    } else {
      if (this.dom.playIcon) this.dom.playIcon.style.display = 'block';
      if (this.dom.pauseIcon) this.dom.pauseIcon.style.display = 'none';
      if (this.dom.floatingPlayIcon) this.dom.floatingPlayIcon.style.display = 'block';
      if (this.dom.floatingPauseIcon) this.dom.floatingPauseIcon.style.display = 'none';
      this.dom.btnFloatingPlay?.classList.remove('is-playing');
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
      this.highlightActiveQuickMeasure(-1);
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
          this.dom.hudTempoRatio.textContent = "1/1";
        } else {
          this.dom.hudTempoRatio.textContent = `${pos.measure.ratioNum}/${pos.measure.ratioDen}`;
        }
      } else {
        this.dom.hudTempoRatio.textContent = "Fixo";
      }

      // Realce no cartão e na esteira de pulo rápido
      this.highlightActiveMeasureCard(pos.measureIndex);
      this.highlightActiveQuickMeasure(pos.measureIndex);
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

  highlightActiveQuickMeasure(activeIndex) {
    const strip = this.dom.measureQuickStrip;
    if (!strip) return;

    const allBtns = strip.querySelectorAll('.quick-measure-btn');
    allBtns.forEach((btn, i) => {
      const isActive = (i === activeIndex);
      btn.classList.toggle('active', isActive);
      if (isActive && this.isPlaying) {
        btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    });
  }

  renderQuickMeasureStrip() {
    const strip = this.dom.measureQuickStrip;
    if (!strip) return;
    strip.innerHTML = '';
    const measures = state.measures;
    if (!measures || measures.length === 0) return;

    measures.forEach((m, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'quick-measure-btn';
      btn.dataset.index = idx;
      if (idx === this._lastMeasureIdx) {
        btn.classList.add('active');
      }

      const mColor = m.color || '#ff334b';
      btn.style.setProperty('--m-color', mColor);

      const hasNick = m.nickname && m.nickname.trim();
      const label = hasNick ? m.nickname : `${m.beats}T`;
      const repeatInfo = ((m.repeat || 1) > 1) ? `<span class="qm-rep">×${m.repeat}</span>` : '';

      btn.innerHTML = `
        <span class="qm-idx" style="color:${mColor}">c.${idx + 1}</span>
        <span class="qm-label">${label}</span>
        ${repeatInfo}
      `;

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const t = state.getFirstTimingForMeasure(idx);
        if (t) {
          this.seekTo(t.startTime);
          this.handleMeasureSelected(idx);
        }
      });

      strip.appendChild(btn);
    });
  }

  setupMobileNav() {
    this.activeMobileTab = 'stage';
    this.setMobileTab('stage');

    this.dom.tabNavStage?.addEventListener('click', () => this.setMobileTab('stage'));
    this.dom.tabNavMeasures?.addEventListener('click', () => this.setMobileTab('measures'));
    this.dom.tabNavPiece?.addEventListener('click', () => this.setMobileTab('piece'));
    this.dom.tabNavBossas?.addEventListener('click', () => this.setMobileTab('bossas'));

    this.dom.btnFloatingPlay?.addEventListener('click', () => this.togglePlayPause());
  }

  setMobileTab(tab) {
    if (tab === 'bossas') {
      this.openBossaManager(true);
      return;
    }

    if (this.currentView === 'bossas') {
      this.closeBossaManager(true);
    }

    this.activeMobileTab = tab;
    this.previousMobileTab = tab;
    document.body.setAttribute('data-mobile-tab', tab);

    this.dom.tabNavStage?.classList.toggle('active', tab === 'stage');
    this.dom.tabNavMeasures?.classList.toggle('active', tab === 'measures');
    this.dom.tabNavPiece?.classList.toggle('active', tab === 'piece');
    this.dom.tabNavBossas?.classList.toggle('active', tab === 'bossas');

    if (tab === 'stage') {
      setTimeout(() => {
        this.renderer?.resize();
      }, 50);
    }
  }

  setupRouting() {
    const handleRoute = () => {
      const hash = window.location.hash;
      if (hash === '#/bossas' || hash === '#bossas') {
        if (this.currentView !== 'bossas') {
          this.openBossaManager(false);
        }
      } else {
        if (this.currentView === 'bossas') {
          this.closeBossaManager(false);
        }
      }
    };

    window.addEventListener('hashchange', handleRoute);
    window.addEventListener('popstate', handleRoute);

    // Roteamento inicial ao carregar a página
    const initialHash = window.location.hash;
    if (initialHash === '#/bossas' || initialHash === '#bossas') {
      this.openBossaManager(false);
    }
  }

  // =========================================================================
  // SUPORTE A PWA (OFFLINE & INSTALAÇÃO)
  // =========================================================================

  setupPwa() {
    // 1. Registro do Service Worker para suporte offline
    if ('serviceWorker' in navigator && (window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
          .then((reg) => {
            console.log('[PWA] Service Worker ativo com escopo:', reg.scope);
          })
          .catch((err) => {
            console.warn('[PWA] Falha ao registrar Service Worker:', err);
          });
      });
    }

    // 2. Intercepta 'beforeinstallprompt' para botão de instalação personalizado
    let deferredPrompt = null;
    const btnInstall = this.dom.btnInstallPwa;

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      if (btnInstall) {
        btnInstall.style.display = 'inline-flex';
        btnInstall.classList.add('can-install');
      }
    });

    if (btnInstall) {
      btnInstall.addEventListener('click', async () => {
        if (deferredPrompt) {
          deferredPrompt.prompt();
          const { outcome } = await deferredPrompt.userChoice;
          if (outcome === 'accepted') {
            this.showToast('Sérgio Simulator instalado com sucesso!', '🎉');
            btnInstall.style.display = 'none';
          }
          deferredPrompt = null;
        } else {
          // Detecta se já está instalado ou se é iOS
          const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
          const isStandalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;

          if (isStandalone) {
            this.showToast('Aplicativo já instalado e operando offline!', '✅');
          } else if (isIos) {
            alert('Para instalar no iPhone/iPad:\n1. Toque no botão Compartilhar (⎋) do Safari\n2. Role para baixo e selecione "Adicionar à Tela de Início"');
          } else {
            this.showToast('App pronto para uso offline! Verifique o menu do navegador para instalar.', '📲');
          }
        }
      });
    }

    window.addEventListener('appinstalled', () => {
      this.showToast('Sérgio Simulator instalado!', '✅');
      if (btnInstall) btnInstall.style.display = 'none';
    });

    // 3. Monitoramento de Conexão Online / Offline
    const updateOnlineStatus = () => {
      if (!navigator.onLine) {
        this.showToast('Modo Offline ativado • Peças salvas no aparelho', '📡');
        this.updateSyncStatus('offline', 'Salvo local');
      } else {
        this.updateSyncStatus('synced', 'Salvo');
      }
    };

    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
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

  formatFriendlyDuration(sec) {
    if (isNaN(sec) || sec <= 0) return '0:00';
    const totalSeconds = Math.round(sec);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
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
      if (state.isReadOnly) {
        this.showToast('Esta peça está em modo apenas leitura. Crie uma cópia pessoal para salvar alterações.', '🔒');
        return;
      }
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

    // Botão Salvar Peça no Repertório (Menu Peça)
    this.dom.btnSavePieceToLibrary?.addEventListener('click', () => {
      if (this.dom.appMenuDropdown) this.dom.appMenuDropdown.style.display = 'none';
      this.handleExplicitSaveCurrentPiece();
    });

    // Clique no Pill de Salvamento no topo central
    this.dom.syncStatusPill?.addEventListener('click', () => {
      this.handleExplicitSaveCurrentPiece();
    });

    // Botão de Apagar Peça Aberta (Menu Peça)
    this.dom.btnDeleteCurrentPiece?.addEventListener('click', () => {
      if (this.dom.appMenuDropdown) this.dom.appMenuDropdown.style.display = 'none';
      const currentItem = {
        id: state.id,
        name: state.name || 'Nova Peça',
        isBossa: state.isBossa
      };
      this.handleDeletePieceOrBossa(currentItem);
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

    this.dom.inputNewPieceName?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.executeCreateNewPiece();
      }
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

      // Se há tecla modificadora (Ctrl ou Cmd), processar apenas atalhos específicos do app
      // e liberar todos os atalhos nativos do navegador (ex: Ctrl+R, Ctrl+Shift+R, Ctrl+T, Ctrl+W, Ctrl+Shift+I)
      if (hasModifier) {
        // Atalho Ctrl+Z / Cmd+Z: Desfazer
        if (key === 'z' && !e.shiftKey) {
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
        if ((key === 'z' && e.shiftKey) || key === 'y') {
          e.preventDefault();
          const action = state.redo();
          if (action) {
            this.showToast(`Refez: ${action}`, '↪');
          } else {
            this.showToast('Nada a refazer', 'ℹ️');
          }
          return;
        }

        // Atalho Ctrl+N / Cmd+N: Nova Peça
        if (key === 'n') {
          e.preventDefault();
          this.openConfirmNewModal();
          return;
        }

        // Atalho Ctrl+A / Cmd+A: Selecionar todos os compassos
        if (key === 'a') {
          e.preventDefault();
          this.selectedMeasureIndices.clear();
          for (let i = 0; i < state.measures.length; i++) {
            this.selectedMeasureIndices.add(i);
          }
          this.lastSelectedMeasureIdx = state.measures.length > 0 ? state.measures.length - 1 : null;
          this.syncSelectionUI();
          return;
        }

        // Deixar qualquer outro atalho com Ctrl/Cmd seguir pro navegador (Ctrl+R, Ctrl+Shift+R, etc.)
        return;
      }

      if (e.key === 'Escape') {
        if (this.dom.modalRenameBossa && this.dom.modalRenameBossa.style.display === 'flex') {
          this.closeRenameBossaModal();
          return;
        }
        if (this.currentView === 'bossas' || (this.dom.viewBossaManager && this.dom.viewBossaManager.style.display === 'flex')) {
          this.closeBossaManager(true);
          return;
        }
        if (this.dom.modalInsertBossa && this.dom.modalInsertBossa.style.display === 'flex') {
          this.closeInsertBossaModal();
          return;
        }
        if (this.dom.modalSaveAsBossa && this.dom.modalSaveAsBossa.style.display === 'flex') {
          this.closeSaveAsBossaModal();
          return;
        }
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

      if (e.code === 'Space') {
        e.preventDefault();
        this.togglePlayPause();
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        this.stopPlayback();
      } else if (e.key === 'm' || e.key === 'M') {
        this.dom.btnMute.click();
      } else if (e.key === 't' || e.key === 'T') {
        if (!e.altKey) {
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
        if (this.dom.btnToolbarSaveAsBossa) {
          this.dom.btnToolbarSaveAsBossa.textContent = `💾 Salvar Bossa (${count})`;
          this.dom.btnToolbarSaveAsBossa.style.display = 'inline-flex';
        }
        if (this.dom.btnToolbarInsertBossa) {
          this.dom.btnToolbarInsertBossa.style.display = 'none';
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
        if (this.dom.btnToolbarSaveAsBossa) {
          this.dom.btnToolbarSaveAsBossa.textContent = '💾 Salvar Bossa';
          this.dom.btnToolbarSaveAsBossa.style.display = 'inline-flex';
        }
        if (this.dom.btnToolbarInsertBossa) {
          this.dom.btnToolbarInsertBossa.style.display = 'inline-flex';
        }
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

    if (this.dom.tabMeasuresBadge) {
      this.dom.tabMeasuresBadge.textContent = uniqueCount;
    }
    this.renderQuickMeasureStrip();

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

      // Se for o primeiro compasso de um bloco de Bossa, renderiza o cabeçalho do bloco
      if (grp && grp.isBossaBlock && grp.startMeasure === idx) {
        const blockHeader = document.createElement('div');
        blockHeader.className = 'bossa-block-header';
        const bColor = grp.color || '#8b5cf6';
        blockHeader.style.setProperty('--bossa-color', bColor);
        const count = (grp.endMeasure - grp.startMeasure) + 1;
        blockHeader.innerHTML = `
          <div class="bossa-block-header-info">
            <span class="bossa-block-header-badge" style="background:${bColor}25; color:${bColor}">
              ${grp.isLinked ? '🔗 Bossa Vinculada' : '📦 Bloco Bossa'}
            </span>
            <span class="bossa-block-header-title">${grp.name}</span>
            <span class="bossa-block-header-range">c. ${grp.startMeasure + 1} a ${grp.endMeasure + 1} (${count} ${count === 1 ? 'compasso' : 'compassos'})</span>
          </div>
          <div class="bossa-block-header-actions">
            ${grp.isLinked ? `
              <button type="button" class="btn-bossa-block-action btn-sync-bossa-block" title="Sincronizar este bloco com a bossa original">
                🔄 Sincronizar
              </button>
              <button type="button" class="btn-bossa-block-action btn-unlink-bossa-block" title="Desvincular bloco inteiro da peça original (tornar edições independentes)">
                🔓 Desvincular Bloco
              </button>
            ` : ''}
          </div>
        `;

        const btnSync = blockHeader.querySelector('.btn-sync-bossa-block');
        if (btnSync) {
          btnSync.addEventListener('click', (e) => {
            e.stopPropagation();
            const res = state.syncBossaBlock(grp.id);
            if (res) {
              this.renderMeasuresList();
              this.showToast(`Bloco '${grp.name}' sincronizado com a bossa original!`, '🔄');
            } else {
              this.showToast(`Bossa original não encontrada na biblioteca ou presets.`, '⚠️');
            }
          });
        }

        const btnUnlink = blockHeader.querySelector('.btn-unlink-bossa-block');
        if (btnUnlink) {
          btnUnlink.addEventListener('click', (e) => {
            e.stopPropagation();
            state.unlinkBossaBlock(grp.id);
            this.renderMeasuresList();
            this.showToast(`Bloco '${grp.name}' desvinculado! Todas as edições agora são locais.`, '🔓');
          });
        }

        grid.appendChild(blockHeader);
      }

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

      let bossaPillHtml = '';
      if (m.sourcePieceId) {
        if (m.isLinked) {
          bossaPillHtml = `<span class="measure-bossa-pill linked" title="Vinculado por referência à '${m.sourcePieceName || 'Bossa'}'. Atualizações da original serão sincronizadas automaticamente.">🔗 ${m.sourcePieceName || 'Bossa'}</span>`;
        } else if (m.isLocallyModified) {
          bossaPillHtml = `<span class="measure-bossa-pill modified" title="Modificado localmente (baseado em '${m.sourcePieceName || 'Bossa'}')">✏️ Local (${m.sourcePieceName || 'Bossa'})</span>`;
        } else {
          bossaPillHtml = `<span class="measure-bossa-pill unlinked" title="Desvinculado de '${m.sourcePieceName || 'Bossa'}'">🔓 ${m.sourcePieceName || 'Bossa'}</span>`;
        }
      }

      let tempoDesc = '';
      if (m.tempoMode === "ratio") {
        tempoDesc = (m.ratioNum === 1 && m.ratioDen === 1) 
          ? `${Math.round(timing.effectiveBpm)} BPM (1/1)`
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
          <div class="measure-card-tags">
            ${bossaPillHtml}
            ${groupTagHtml}
          </div>
        </div>

        <!-- APELIDO DO COMPASSO OU NÚMERO C. X -->
        ${titleHtml}

        <div class="measure-card-details">
          <span class="measure-card-meter">${m.beats}T</span>
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
          ${m.sourcePieceId && m.isLinked ? '<button type="button" class="btn-card-icon btn-card-unlink-m" title="Desvincular compasso para edição local">🔓</button>' : ''}
          ${m.sourcePieceId && m.isLocallyModified ? '<button type="button" class="btn-card-icon btn-card-restore-m" title="Restaurar compasso da versão original da bossa">↺</button>' : ''}
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
        if (e.target.closest('.btn-card-unlink-m')) {
          e.stopPropagation();
          state.unlinkMeasure(idx);
          this.renderMeasuresList();
          this.showToast(`Compasso c. ${idx + 1} desvinculado para edição local!`, '🔓');
          return;
        }
        if (e.target.closest('.btn-card-restore-m')) {
          e.stopPropagation();
          const restored = state.restoreMeasureFromBossa(idx);
          if (restored) {
            this.renderMeasuresList();
            this.showToast(`Compasso c. ${idx + 1} restaurado para o original da bossa!`, '↺');
          } else {
            this.showToast(`Não foi possível restaurar (peça original não encontrada).`, '⚠️');
          }
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

    if (measures.length > 0) {
      const addCard = document.createElement('div');
      addCard.className = 'measure-card measure-card-add';
      addCard.setAttribute('role', 'button');
      addCard.setAttribute('tabindex', '0');
      addCard.setAttribute('aria-label', 'Adicionar compasso de 4T e 1 repetição');
      addCard.title = 'Adicionar compasso (4T, 1 repetição)';
      addCard.innerHTML = `
        <div class="card-add-inner">
          <span class="card-add-icon" aria-hidden="true">+</span>
          <span class="card-add-label">Adicionar Compasso</span>
          <span class="card-add-sub">4T • 1 repetição</span>
        </div>
      `;

      const handleAdd = () => {
        state.addMeasure(-1, {
          beats: 4,
          beatUnit: 4,
          tempoMode: 'ratio',
          ratioNum: 1,
          ratioDen: 1,
          repeat: 1,
          nickname: ''
        });
        const newIdx = state.measures.length - 1;
        this.handleMeasureSelected(newIdx);
      };

      addCard.addEventListener('click', handleAdd);
      addCard.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleAdd();
        }
      });

      addCard.addEventListener('dragover', (e) => {
        e.preventDefault();
        addCard.classList.add('is-drag-target');
      });

      addCard.addEventListener('dragleave', () => {
        addCard.classList.remove('is-drag-target');
      });

      addCard.addEventListener('drop', (e) => {
        e.preventDefault();
        addCard.classList.remove('is-drag-target');
        const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (!isNaN(fromIdx) && fromIdx < state.measures.length - 1) {
          state.moveMeasure(fromIdx, state.measures.length - 1);
          this.handleMeasureSelected(state.measures.length - 1);
        }
      });

      grid.appendChild(addCard);
    }
  }

  // =========================================================================
  // MODAL DE CONFIRMAÇÃO: NOVO ARQUIVO (DOUBLE CHECK)
  // =========================================================================

  openConfirmNewModal() {
    if (this.dom.modalConfirmNewPiece) {
      if (this.dom.inputNewPieceName) {
        this.dom.inputNewPieceName.value = 'Nova Peça';
      }
      this.dom.modalConfirmNewPiece.style.display = 'flex';
      setTimeout(() => {
        this.dom.inputNewPieceName?.focus();
        this.dom.inputNewPieceName?.select();
      }, 50);
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

    const pieceName = (this.dom.inputNewPieceName?.value || '').trim() || 'Nova Peça';
    state.createNewPiece(pieceName, 120);

    // Reconecta à nova peça no Firebase Collab com seu ID exclusivo
    collab.connectToPiece(state.id, state);

    if (this.dom.inputPieceName) this.dom.inputPieceName.value = state.name;
    if (this.dom.inputBaseBpm) this.dom.inputBaseBpm.value = state.baseBpm;
    this.initPresetsDropdown();
    this.closeConfirmNewModal();
    this.seekTo(0);
    this.renderMeasuresList();
    this.updateHUD();
    this.showToast(`Nova peça '${pieceName}' criada! A peça anterior foi salva no repertório.`, "✨");
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

    const syncRatioPresetButtons = () => {
      const num = parseInt(this.dom.editRatioNum.value, 10);
      const den = parseInt(this.dom.editRatioDen.value, 10);
      ratioBtns.forEach(b => {
        b.classList.toggle('active', parseInt(b.dataset.num, 10) === num && parseInt(b.dataset.den, 10) === den);
      });
    };

    this.dom.editRatioNum.addEventListener('input', () => {
      this.updateModalCalculatedBpm();
      syncRatioPresetButtons();
    });
    this.dom.editRatioDen.addEventListener('input', () => {
      this.updateModalCalculatedBpm();
      syncRatioPresetButtons();
    });

    const swatches = modal.querySelectorAll('.color-swatch-btn');
    swatches.forEach(btn => {
      btn.addEventListener('click', () => {
        swatches.forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        this.dom.editColorPicker.value = btn.dataset.color;
      });
    });

    this.dom.editColorPicker.addEventListener('input', () => {
      const val = this.dom.editColorPicker.value.toLowerCase();
      swatches.forEach(b => b.classList.toggle('selected', b.dataset.color?.toLowerCase() === val));
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

    this.dom.btnMeasureUnlinkModal?.addEventListener('click', () => {
      const idx = parseInt(this.dom.editMeasureIndex.value, 10);
      if (idx >= 0) {
        state.unlinkMeasure(idx);
        this.openMeasureModal(idx);
        this.renderMeasuresList();
        this.showToast('Compasso desvinculado! Alterações agora serão locais.', '🔓');
      }
    });

    this.dom.btnMeasureRestoreModal?.addEventListener('click', () => {
      const idx = parseInt(this.dom.editMeasureIndex.value, 10);
      if (idx >= 0) {
        const restored = state.restoreMeasureFromBossa(idx);
        if (restored) {
          this.openMeasureModal(idx);
          this.renderMeasuresList();
          this.showToast('Compasso restaurado para a versão da Bossa!', '↺');
        } else {
          this.showToast('Não foi possível restaurar (peça original não encontrada na biblioteca).', '⚠️');
        }
      }
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const idx = parseInt(this.dom.editMeasureIndex.value, 10);
      if (idx < 0) return;

      const tempoMode = this.dom.radioModeFixed.checked ? 'fixed' : 'ratio';
      const num = parseInt(this.dom.editRatioNum.value, 10) || 1;
      const den = parseInt(this.dom.editRatioDen.value, 10) || 1;
      const fixedBpm = parseFloat(this.dom.editCustomBpm.value) || state.baseBpm;
      const m = state.measures[idx];
      const wasLinked = m && m.isLinked;

      state.updateMeasure(idx, {
        nickname: this.dom.editNickname.value,
        beats: parseInt(this.dom.editBeats.value, 10) || 4,
        beatUnit: 4,
        repeat: Math.max(1, Math.min(999, parseInt(this.dom.editRepeat.value, 10) || 1)),
        tempoMode: tempoMode,
        ratioNum: num,
        ratioDen: den,
        customBpm: fixedBpm,
        color: this.dom.editColorPicker.value,
        ...(m && m.sourcePieceId ? {
          isLinked: false,
          isLocallyModified: true
        } : {})
      });

      if (wasLinked) {
        this.showToast('Compasso modificado localmente (desvinculado da bossa original).', '✏️');
      }

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
    if (this.dom.editBeatUnit) this.dom.editBeatUnit.value = m.beatUnit || 4;
    this.dom.editRepeat.value = m.repeat || 1;

    // Configura o banner de Bossa Embutida
    if (m.sourcePieceId) {
      if (this.dom.measureBossaBanner) this.dom.measureBossaBanner.style.display = 'flex';
      if (this.dom.bossaBannerName) this.dom.bossaBannerName.textContent = m.sourcePieceName || 'Bossa Vinculada';
      if (this.dom.btnMeasureUnlinkModal) this.dom.btnMeasureUnlinkModal.style.display = m.isLinked ? 'inline-flex' : 'none';
      if (this.dom.btnMeasureRestoreModal) this.dom.btnMeasureRestoreModal.style.display = m.isLocallyModified ? 'inline-flex' : 'none';
    } else {
      if (this.dom.measureBossaBanner) this.dom.measureBossaBanner.style.display = 'none';
    }

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

    const curNum = m.ratioNum || 1;
    const curDen = m.ratioDen || 1;
    const ratioBtns = this.dom.modalMeasureEdit.querySelectorAll('.btn-ratio-preset, .preset-ratio-btn');
    ratioBtns.forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.num, 10) === curNum && parseInt(btn.dataset.den, 10) === curDen);
    });

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

    this.dom.newGroupColorPicker.addEventListener('input', () => {
      const val = this.dom.newGroupColorPicker.value.toLowerCase();
      colorBtns.forEach(b => b.classList.toggle('selected', b.dataset.color?.toLowerCase() === val));
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
    defaultOpt.textContent = 'Carregar Peça / Modelo...';
    select.appendChild(defaultOpt);

    // 📁 Grupo de Minhas Peças Salvas Localmente
    const libraryPieces = state.getLibraryPieces ? state.getLibraryPieces() : [];
    if (libraryPieces.length > 0) {
      const libraryGroup = document.createElement('optgroup');
      libraryGroup.label = '📁 Minhas Peças & Bossas (Local)';

      libraryPieces.forEach(p => {
        const opt = document.createElement('option');
        opt.value = `lib_${p.id}`;
        const isCurrent = p.id === state.id;
        const count = p.measures?.length || 0;
        const isBossa = p.isBossa !== undefined ? Boolean(p.isBossa) : Boolean(p.id?.startsWith('piece-bossa-') || p.id?.startsWith('bossa-'));
        const typeIcon = isBossa ? '🥁 ' : '📜 ';
        opt.textContent = `${isCurrent ? '▶ ' : ''}${typeIcon}${p.name || (isBossa ? 'Bossa Sem Nome' : 'Peça Sem Nome')} (${count} comp.)`;
        if (isCurrent) opt.selected = true;
        libraryGroup.appendChild(opt);
      });

      select.appendChild(libraryGroup);
    }

    // ☁️ Grupo de Peças na Nuvem (se logado)
    if (this.authService && this.authService.isLoggedIn()) {
      collab.getUserCloudPieces().then(cloudPieces => {
        if (!cloudPieces || cloudPieces.length === 0) return;
        
        let cloudGroup = select.querySelector('optgroup[data-type="cloud"]');
        if (!cloudGroup) {
          cloudGroup = document.createElement('optgroup');
          cloudGroup.label = '☁️ Minhas Peças & Bossas na Nuvem';
          cloudGroup.dataset.type = 'cloud';
          const existingPresetsGroup = select.querySelector('optgroup[data-type="presets"]');
          select.insertBefore(cloudGroup, existingPresetsGroup || null);
        } else {
          cloudGroup.innerHTML = '';
        }

        cloudPieces.forEach(p => {
          const opt = document.createElement('option');
          opt.value = `cloud_${p.id}`;
          const isCurrent = p.id === state.id;
          const count = p.measures?.length || 0;
          const isBossa = p.isBossa !== undefined ? Boolean(p.isBossa) : Boolean(p.id?.startsWith('piece-bossa-') || p.id?.startsWith('bossa-'));
          const typeIcon = isBossa ? '🥁 ' : '📜 ';
          const lockIcon = p.access === 'private' ? '🔒 ' : (p.access === 'view_link' ? '🎧 ' : '✏️ ');
          opt.textContent = `${isCurrent ? '▶ ' : ''}${typeIcon}${lockIcon}${p.name || (isBossa ? 'Bossa Sem Nome' : 'Peça Sem Nome')} (${count} comp.)`;
          if (isCurrent) opt.selected = true;
          cloudGroup.appendChild(opt);
        });
      }).catch(() => {});
    }

    // 🎼 Grupo de Estudos Didáticos (apenas modelos não ocultados pelo usuário)
    const activePresets = this.getActivePresets();
    if (activePresets.length > 0) {
      const presetsGroup = document.createElement('optgroup');
      presetsGroup.label = '⭐ Modelos de Estudo';
      presetsGroup.dataset.type = 'presets';

      activePresets.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `⭐ ${p.name}`;
        presetsGroup.appendChild(opt);
      });

      select.appendChild(presetsGroup);
    }

    if (!select._hasChangeListener) {
      select._hasChangeListener = true;
      select.addEventListener('change', (e) => {
        const val = e.target.value;
        if (val === '__new_piece__' || val === '__empty__') {
          select.value = '';
          this.openConfirmNewModal();
          return;
        }
        if (val.startsWith('cloud_')) {
          const pieceId = val.replace('cloud_', '');
          if (pieceId !== state.id) {
            this.pausePlayback();
            collab.connectToPiece(pieceId, null).then((ok) => {
              if (ok) {
                this.seekTo(0);
                this.closeMeasureToolbar();
                this.showToast(`Peça da nuvem carregada!`, '☁️');
              }
            });
          }
          this.initPresetsDropdown();
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

    collab.onPermissionChange = (info) => {
      this.handleCollabPermissionChanged(info);
    };

    collab.onAccessDenied = (info) => {
      this.handleCollabAccessDenied(info);
    };

    // Conexão inicial: Se houver ?piece= na URL, conecta àquela peça; se não, sincroniza com o ID da peça atual
    const urlPieceId = collab.getPieceIdFromUrl();
    if (urlPieceId) {
      collab.connectToPiece(urlPieceId, state).then(success => {
        if (success) {
          this.checkJoinModalOnSharedLink(urlPieceId);
        } else {
          collab.clearUrlPieceId();
        }
      });
    } else {
      collab.connectToPiece(state.id, state);
    }
  }

  updateSyncStatus(status, text) {
    const pill = this.dom.syncStatusPill || this.dom.cloudStatusPill;
    const label = this.dom.syncStatusText || this.dom.cloudStatusText;
    const icon = this.dom.syncStatusIcon;
    if (!pill || !label) return;

    pill.className = `sync-status-pill ${status}`;
    if (status === 'synced') {
      if (icon) icon.textContent = '☁️';
      label.textContent = text || 'Salvo';
      pill.title = 'Peça salva no seu navegador e sincronizada na nuvem';
    } else if (status === 'syncing') {
      if (icon) icon.textContent = '🔄';
      label.textContent = text || 'Salvando...';
      pill.title = text || 'Sincronizando com a nuvem...';
    } else if (status === 'offline') {
      if (icon) icon.textContent = '💾';
      label.textContent = 'Salvo local';
      pill.title = 'Sem conexão com a nuvem. Alterações salvas no seu aparelho.';
    } else if (status === 'error') {
      if (icon) icon.textContent = '⚠️';
      label.textContent = 'Não sincronizado';
      pill.title = text || 'Acesso restrito ou falha de conexão na nuvem.';
    }
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
      if (u.photoURL) {
        pill.innerHTML = `<img src="${u.photoURL}" alt="${u.name}" class="presence-avatar-img">`;
      } else {
        const initial = (u.name || 'U').charAt(0).toUpperCase();
        pill.textContent = initial;
      }
      const isMe = u.id === collab.localUser.id;
      pill.title = isMe ? `${u.name} (Você)` : u.name;
      if (isMe) {
        pill.style.cursor = 'pointer';
        pill.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.authService.isLoggedIn()) {
            const isHidden = !this.dom.userMenuDropdown || this.dom.userMenuDropdown.style.display === 'none';
            if (this.dom.userMenuDropdown) {
              this.dom.userMenuDropdown.style.display = isHidden ? 'flex' : 'none';
            }
          } else {
            this.openAuthModal('login');
          }
        });
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
  }

  openShareModal() {
    if (!this.dom.modalSharePiece) return;

    // Garante que a peça atual está sincronizada na nuvem com o link gerado
    const shareLink = collab.getShareableLink(state.id);
    if (this.dom.inputShareUrl) {
      this.dom.inputShareUrl.value = shareLink;
    }

    this.renderCollabModalUsers(collab.activeCollaborators);
    this.updateShareModalLinkDisplay();

    this.dom.modalSharePiece.style.display = 'flex';
  }

  closeShareModal() {
    if (this.dom.modalSharePiece) {
      this.dom.modalSharePiece.style.display = 'none';
    }
  }

  /* ==========================================================================
     SISTEMA DE AUTENTICAÇÃO & CONTROLE DE ACESSO (GOOGLE, E-MAIL & CONVIDADO)
     ========================================================================== */

  setupAuth() {
    this.authService.onUserChange((user, isLoggedIn) => {
      this.updateAuthUi(user, isLoggedIn);
      this.initPresetsDropdown();

      // Sincroniza biblioteca e bossas com a nuvem automaticamente ao autenticar (tempo real Google Docs)
      if (isLoggedIn) {
        collab.listenToUserLibrary(state, () => {
          this.initPresetsDropdown();
          if (this.currentView === 'bossas' || (this.dom.viewBossaManager && this.dom.viewBossaManager.style.display === 'flex')) {
            this.renderBossaManagerCards();
          }
          this.updateBossaManagerSyncIndicator('idle', 'Sincronizado automaticamente');
        });

        collab.syncUserLibraryWithCloud(state).then(() => {
          this.initPresetsDropdown();
          if (this.currentView === 'bossas' || (this.dom.viewBossaManager && this.dom.viewBossaManager.style.display === 'flex')) {
            this.renderBossaManagerCards();
          }
          this.updateBossaManagerSyncIndicator('idle', 'Sincronizado automaticamente');
        }).catch(err => {
          console.warn("Erro ao sincronizar bossas com a nuvem:", err);
          this.updateBossaManagerSyncIndicator('idle', 'Salvo localmente');
        });
      } else {
        collab.stopListeningToUserLibrary();
        this.updateBossaManagerSyncIndicator('idle', 'Salvo no dispositivo');
      }

      // Se havia uma peça privada que foi negada antes e o usuário acabou de logar, tenta reconectar
      if (isLoggedIn && this.pendingDeniedPieceId) {
        const retryId = this.pendingDeniedPieceId;
        this.pendingDeniedPieceId = null;
        if (this.dom.modalAccessDenied) this.dom.modalAccessDenied.style.display = 'none';
        collab.connectToPiece(retryId, state).then(success => {
          if (success) {
            this.showToast('Acesso autorizado! Peça carregada da sua conta.', '🔓');
          }
        });
      }
    });

    // Abrir menu de usuário ou modal de login ao clicar no botão do cabeçalho
    this.dom.btnAuth?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.authService.isLoggedIn()) {
        const isHidden = !this.dom.userMenuDropdown || this.dom.userMenuDropdown.style.display === 'none';
        if (this.dom.userMenuDropdown) {
          this.dom.userMenuDropdown.style.display = isHidden ? 'flex' : 'none';
        }
        if (this.dom.appMenuDropdown) {
          this.dom.appMenuDropdown.style.display = 'none';
          this.dom.btnAppMenu?.classList.remove('active');
        }
      } else {
        this.openAuthModal('login');
      }
    });

    // Abrir menu principal / hamburguinho de configurações & arquivo
    this.dom.btnAppMenu?.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = !this.dom.appMenuDropdown || this.dom.appMenuDropdown.style.display === 'none';
      if (this.dom.appMenuDropdown) {
        this.dom.appMenuDropdown.style.display = isHidden ? 'flex' : 'none';
        this.dom.btnAppMenu.classList.toggle('active', isHidden);
      }
      if (this.dom.userMenuDropdown) {
        this.dom.userMenuDropdown.style.display = 'none';
      }
    });

    // Fechar dropdowns ao clicar fora
    document.addEventListener('click', (e) => {
      if (this.dom.userMenuDropdown && !this.dom.userMenuDropdown.contains(e.target) && !this.dom.btnAuth?.contains(e.target)) {
        this.dom.userMenuDropdown.style.display = 'none';
      }
      if (this.dom.appMenuDropdown && !this.dom.appMenuDropdown.contains(e.target) && !this.dom.btnAppMenu?.contains(e.target)) {
        this.dom.appMenuDropdown.style.display = 'none';
        this.dom.btnAppMenu?.classList.remove('active');
      }
    });

    // Fechar menu de arquivo ao selecionar ou disparar ações
    const closeAppMenu = () => {
      if (this.dom.appMenuDropdown) {
        this.dom.appMenuDropdown.style.display = 'none';
        this.dom.btnAppMenu?.classList.remove('active');
      }
    };
    this.dom.btnNewPiece?.addEventListener('click', closeAppMenu);
    this.dom.btnDeleteCurrentPiece?.addEventListener('click', closeAppMenu);
    this.dom.btnOpenHistory?.addEventListener('click', closeAppMenu);
    this.dom.btnExport?.addEventListener('click', closeAppMenu);
    this.dom.fileImport?.addEventListener('change', closeAppMenu);
    this.dom.selectPreset?.addEventListener('change', closeAppMenu);

    // Botão de Gerenciar Bossas no menu de usuário
    this.dom.btnUserManageBossas?.addEventListener('click', () => {
      if (this.dom.userMenuDropdown) this.dom.userMenuDropdown.style.display = 'none';
      this.openBossaManager();
    });

    // Botão de Logout
    this.dom.btnUserLogout?.addEventListener('click', async () => {
      try {
        await this.authService.logout();
        if (this.dom.userMenuDropdown) this.dom.userMenuDropdown.style.display = 'none';

        // Se a peça aberta for privada ou restrita, limpa imediatamente da tela
        if (state.access === 'private' || collab.currentPieceAccess === 'private' || collab.isPrivateAccessDenied) {
          this.stopPlayback();
          collab.clearUrlPieceId();
          state.resetToDefault();
          this.renderMeasuresList();
          this.updateHUD(0);
          this.closeMeasureToolbar();
          if (this.renderer) {
            this.renderer.setSelectedMeasures([]);
            this.renderer.render(0);
          }
          this.preparePieceAudio();
          collab.connectToPiece(state.id, state);
          this.seekTo(0);
        }

        this.showToast('Você saiu da sua conta', '👋');
      } catch (err) {
        this.showToast(err.message, '⚠️');
      }
    });

    // Botão "Minhas Peças na Nuvem" no menu de usuário
    this.dom.btnUserCloudPieces?.addEventListener('click', () => {
      if (this.dom.userMenuDropdown) this.dom.userMenuDropdown.style.display = 'none';
      if (this.dom.appMenuDropdown) {
        this.dom.appMenuDropdown.style.display = 'flex';
        this.dom.btnAppMenu?.classList.add('active');
      }
      if (this.dom.selectPreset) {
        this.dom.selectPreset.focus();
        this.showToast('Selecione uma peça na lista de Peças & Modelos', '☁️');
      }
    });

    // Modal de Autenticação
    this.dom.btnAuthModalClose?.addEventListener('click', () => this.closeAuthModal());
    this.dom.modalAuth?.addEventListener('click', (e) => {
      if (e.target === this.dom.modalAuth) this.closeAuthModal();
    });

    this.dom.btnGoogleSignIn?.addEventListener('click', () => this.handleGoogleLogin());
    this.dom.formAuthEmail?.addEventListener('submit', (e) => this.handleEmailAuthSubmit(e));
    this.dom.btnAuthToggleMode?.addEventListener('click', () => this.toggleAuthModalMode());
    this.dom.btnForgotPass?.addEventListener('click', () => this.handleForgotPassword());

    // Botão de duplicar peça pessoal no banner de modo ouvinte
    this.dom.btnForkPiece?.addEventListener('click', () => this.handleForkCurrentPiece());

    // Modal de Acesso Negado
    this.dom.btnAccessDeniedGoHome?.addEventListener('click', () => {
      if (this.dom.modalAccessDenied) this.dom.modalAccessDenied.style.display = 'none';
      this.pendingDeniedPieceId = null;
      collab.clearUrlPieceId();
      state.resetToDefault();
      collab.connectToPiece(state.id, state);
      this.seekTo(0);
      this.showToast('Carregou estudo padrão', '🔄');
    });

    this.dom.btnAccessDeniedLogin?.addEventListener('click', () => {
      if (this.dom.modalAccessDenied) this.dom.modalAccessDenied.style.display = 'none';
      this.openAuthModal('login');
    });

    // Aviso de login no seletor de acesso
    this.dom.btnNoticeLogin?.addEventListener('click', () => {
      this.closeShareModal();
      this.openAuthModal('login');
    });
  }

  updateAuthUi(user, isLoggedIn) {
    if (isLoggedIn && user) {
      this.dom.btnAuth?.classList.add('logged-in');
      const name = this.authService.getDisplayName();
      if (this.dom.userAuthLabel) this.dom.userAuthLabel.textContent = name;
      
      const photo = this.authService.getPhotoURL();
      if (this.dom.userAuthAvatar) {
        if (photo) {
          this.dom.userAuthAvatar.innerHTML = `<img src="${photo}" alt="${name}">`;
        } else {
          this.dom.userAuthAvatar.textContent = (name || 'U').charAt(0).toUpperCase();
        }
      }

      if (this.dom.userMenuName) this.dom.userMenuName.textContent = name;
      if (this.dom.userMenuEmail) this.dom.userMenuEmail.textContent = user.email || 'Conta Conectada';
      if (this.dom.userMenuAvatarLarge) {
        if (photo) {
          this.dom.userMenuAvatarLarge.innerHTML = `<img src="${photo}" alt="${name}">`;
        } else {
          this.dom.userMenuAvatarLarge.textContent = (name || 'U').charAt(0).toUpperCase();
        }
      }
    } else {
      this.dom.btnAuth?.classList.remove('logged-in');
      if (this.dom.userAuthLabel) this.dom.userAuthLabel.textContent = 'Entrar';
      if (this.dom.userAuthAvatar) this.dom.userAuthAvatar.innerHTML = '👤';
      if (this.dom.userMenuDropdown) this.dom.userMenuDropdown.style.display = 'none';
    }
  }

  openAuthModal(mode = 'login') {
    this.authModalMode = mode;
    this.clearAuthAlert();
    if (this.dom.formAuthEmail) this.dom.formAuthEmail.reset();

    if (mode === 'register') {
      if (this.dom.authModalTitle) this.dom.authModalTitle.textContent = 'Criar Nova Conta';
      if (this.dom.authModalSubtitle) this.dom.authModalSubtitle.textContent = 'Cadastre-se gratuitamente para criar peças privadas e salvar na nuvem.';
      if (this.dom.groupAuthName) this.dom.groupAuthName.style.display = 'block';
      if (this.dom.groupAuthPassword) this.dom.groupAuthPassword.style.display = 'block';
      if (this.dom.btnForgotPass) this.dom.btnForgotPass.style.display = 'none';
      if (this.dom.inputAuthPassword) {
        this.dom.inputAuthPassword.placeholder = 'Crie uma senha (mínimo 8 caracteres)';
        this.dom.inputAuthPassword.minLength = 8;
        this.dom.inputAuthPassword.autocomplete = 'new-password';
      }
      if (this.dom.btnAuthSubmit) this.dom.btnAuthSubmit.textContent = 'Criar Conta';
      if (this.dom.authTogglePrompt) this.dom.authTogglePrompt.textContent = 'Já tem uma conta?';
      if (this.dom.btnAuthToggleMode) this.dom.btnAuthToggleMode.textContent = 'Fazer Login';
    } else if (mode === 'forgot') {
      if (this.dom.authModalTitle) this.dom.authModalTitle.textContent = 'Recuperar Senha';
      if (this.dom.authModalSubtitle) this.dom.authModalSubtitle.textContent = 'Digite seu e-mail para receber um link de redefinição de senha.';
      if (this.dom.groupAuthName) this.dom.groupAuthName.style.display = 'none';
      if (this.dom.groupAuthPassword) this.dom.groupAuthPassword.style.display = 'none';
      if (this.dom.btnAuthSubmit) this.dom.btnAuthSubmit.textContent = 'Enviar Link de Redefinição';
      if (this.dom.authTogglePrompt) this.dom.authTogglePrompt.textContent = 'Lembrou sua senha?';
      if (this.dom.btnAuthToggleMode) this.dom.btnAuthToggleMode.textContent = 'Voltar ao Login';
    } else {
      if (this.dom.authModalTitle) this.dom.authModalTitle.textContent = 'Entrar na Conta';
      if (this.dom.authModalSubtitle) this.dom.authModalSubtitle.textContent = 'Acesse suas peças privadas em qualquer aparelho e salve suas composições na nuvem.';
      if (this.dom.groupAuthName) this.dom.groupAuthName.style.display = 'none';
      if (this.dom.groupAuthPassword) this.dom.groupAuthPassword.style.display = 'block';
      if (this.dom.btnForgotPass) this.dom.btnForgotPass.style.display = 'inline-block';
      if (this.dom.inputAuthPassword) {
        this.dom.inputAuthPassword.placeholder = 'Sua senha';
        this.dom.inputAuthPassword.removeAttribute('minlength');
        this.dom.inputAuthPassword.autocomplete = 'current-password';
      }
      if (this.dom.btnAuthSubmit) this.dom.btnAuthSubmit.textContent = 'Entrar';
      if (this.dom.authTogglePrompt) this.dom.authTogglePrompt.textContent = 'Não tem uma conta?';
      if (this.dom.btnAuthToggleMode) this.dom.btnAuthToggleMode.textContent = 'Criar Conta';
    }

    if (this.dom.modalAuth) {
      this.dom.modalAuth.style.display = 'flex';
      setTimeout(() => this.dom.inputAuthEmail?.focus(), 100);
    }
  }

  closeAuthModal() {
    if (this.dom.modalAuth) {
      this.dom.modalAuth.style.display = 'none';
    }
  }

  toggleAuthModalMode() {
    if (this.authModalMode === 'login') {
      this.openAuthModal('register');
    } else {
      this.openAuthModal('login');
    }
  }

  showAuthAlert(message, type = 'error') {
    if (!this.dom.authAlertBox) return;
    this.dom.authAlertBox.textContent = message;
    this.dom.authAlertBox.className = `auth-alert ${type}`;
    this.dom.authAlertBox.style.display = 'block';
  }

  clearAuthAlert() {
    if (!this.dom.authAlertBox) return;
    this.dom.authAlertBox.style.display = 'none';
    this.dom.authAlertBox.textContent = '';
  }

  async handleGoogleLogin() {
    this.clearAuthAlert();
    try {
      const user = await this.authService.loginWithGoogle();
      this.closeAuthModal();
      this.showToast(`Bem-vindo, ${user.displayName || 'Músico'}!`, '👋');
      await collab.claimOwnership();
      this.initPresetsDropdown();
    } catch (err) {
      this.showAuthAlert(err.message, 'error');
    }
  }

  async handleEmailAuthSubmit(e) {
    if (e) e.preventDefault();
    this.clearAuthAlert();

    const email = this.dom.inputAuthEmail?.value || '';
    const password = this.dom.inputAuthPassword?.value || '';
    const name = this.dom.inputAuthName?.value || '';

    if (!email) {
      this.showAuthAlert('Por favor, informe seu e-mail.', 'error');
      return;
    }

    if (this.authModalMode === 'forgot') {
      try {
        await this.authService.resetPassword(email);
        this.showAuthAlert('E-mail de redefinição enviado! Verifique sua caixa de entrada.', 'success');
      } catch (err) {
        this.showAuthAlert(err.message, 'error');
      }
      return;
    }

    if (!password) {
      this.showAuthAlert('Por favor, digite sua senha.', 'error');
      return;
    }

    try {
      if (this.authModalMode === 'register') {
        if (password.length < 8) {
          this.showAuthAlert('A senha deve ter no mínimo 8 caracteres.', 'error');
          return;
        }
        const user = await this.authService.registerWithEmail(email, password, name);
        this.closeAuthModal();
        this.showToast(`Conta criada! Bem-vindo, ${user.displayName || 'Músico'}!`, '🎉');
        await collab.claimOwnership();
        this.initPresetsDropdown();
      } else {
        const user = await this.authService.loginWithEmail(email, password);
        this.closeAuthModal();
        this.showToast(`Login realizado! Bem-vindo, ${user.displayName || 'Músico'}!`, '👋');
        await collab.claimOwnership();
        this.initPresetsDropdown();
      }
    } catch (err) {
      this.showAuthAlert(err.message, 'error');
    }
  }

  handleForgotPassword() {
    this.openAuthModal('forgot');
  }

  handleForkCurrentPiece() {
    const newId = state.duplicateCurrentPiece();
    collab.connectToPiece(newId, state);
    this.seekTo(0);
    this.showToast(`Cópia criada: '${state.name}'! Agora você pode editar.`, '🍴');
  }

  setupAccessControlUi() {
    const radios = [
      this.dom.radioAccessPrivate,
      this.dom.radioAccessView,
      this.dom.radioAccessEdit
    ];

    radios.forEach(radio => {
      radio?.addEventListener('change', async (e) => {
        if (!e.target.checked) return;
        const val = e.target.value;

        if (val === 'private' && !this.authService.isLoggedIn()) {
          e.target.checked = false;
          if (this.dom.radioAccessEdit) this.dom.radioAccessEdit.checked = true;
          if (this.dom.accessLoginRequiredNotice) {
            this.dom.accessLoginRequiredNotice.style.display = 'flex';
          }
          return;
        }

        try {
          await collab.updatePieceAccess(val);
          this.updateShareModalLinkDisplay();
          this.showToast('Visibilidade da peça atualizada!', '🔒');
        } catch (err) {
          this.showToast('Erro ao atualizar visibilidade na nuvem.', '⚠️');
        }
      });
    });
  }

  updateShareModalLinkDisplay() {
    const access = collab.currentPieceAccess;
    if (this.dom.radioAccessPrivate) this.dom.radioAccessPrivate.checked = (access === 'private');
    if (this.dom.radioAccessView) this.dom.radioAccessView.checked = (access === 'view_link');
    if (this.dom.radioAccessEdit) this.dom.radioAccessEdit.checked = (access === 'edit_link' || !access);

    if (this.dom.accessLoginRequiredNotice) {
      this.dom.accessLoginRequiredNotice.style.display = this.authService.isLoggedIn() ? 'none' : 'flex';
    }

    if (access === 'private') {
      if (this.dom.labelShareUrl) this.dom.labelShareUrl.textContent = 'Link Privado (Apenas você pode abrir)';
      if (this.dom.hintShareUrl) this.dom.hintShareUrl.textContent = 'Esta peça é privada. Outras pessoas que abrirem este link verão aviso de acesso restrito.';
    } else if (access === 'view_link') {
      if (this.dom.labelShareUrl) this.dom.labelShareUrl.textContent = 'Link de Ouvinte (Apenas Leitura)';
      if (this.dom.hintShareUrl) this.dom.hintShareUrl.textContent = 'Músicos com este link poderão ouvir e treinar, sem poder alterar sua partitura.';
    } else {
      if (this.dom.labelShareUrl) this.dom.labelShareUrl.textContent = 'Link de Colaboração (Qualquer pessoa pode editar)';
      if (this.dom.hintShareUrl) this.dom.hintShareUrl.textContent = 'Músicos com este link poderão compor e editar junto com você em tempo real.';
    }
  }

  handleCollabPermissionChanged(info) {
    if (this.dom.readOnlyBanner) {
      this.dom.readOnlyBanner.style.display = info.isReadOnly ? 'flex' : 'none';
    }
    if (info.isPrivateAccessDenied) {
      this.handleCollabAccessDenied({ pieceId: collab.currentPieceId });
    }
  }

  handleCollabAccessDenied(info) {
    this.pendingDeniedPieceId = info?.pieceId || this.pendingDeniedPieceId || null;
    this.stopPlayback();
    collab.clearUrlPieceId();
    if (this.dom.modalJoinCollab) {
      this.dom.modalJoinCollab.style.display = 'none';
    }

    // SEGURANÇA BACKEND & FRONTEND: Descarrega completamente a peça privada da tela!
    // Garante que nenhum compasso, nome, andamento ou canvas da peça privada fique visível atrás do modal.
    state.resetToDefault();
    this.renderMeasuresList();
    this.updateHUD(0);
    this.closeMeasureToolbar();
    if (this.renderer) {
      this.renderer.setSelectedMeasures([]);
      this.renderer.render(0);
    }
    this.preparePieceAudio();

    if (this.dom.modalAccessDenied) {
      this.dom.modalAccessDenied.style.display = 'flex';
    }
  }

  /* ==========================================================================
     MODAL DE ENTRADA NA SESSÃO COMPARTILHADA (IDENTIFICAÇÃO NOME & COR)
     ========================================================================== */

  checkJoinModalOnSharedLink(urlPieceId) {
    if (!urlPieceId) return;
    // Usuários autenticados no sistema já possuem identidade unificada (nome e avatar)
    if (this.authService.isLoggedIn()) {
      return;
    }

    const sessionKey = `sergio_session_joined_${urlPieceId}`;
    try {
      const alreadyJoinedInThisTab = sessionStorage.getItem(sessionKey);
      if (!alreadyJoinedInThisTab) {
        // Se o usuário convidado já tem nome salvo, entra direto sem segundo modal
        if (collab.localUser.isCustomized && collab.localUser.name && collab.localUser.name !== 'Convidado') {
          return;
        }
        this.openJoinModal(urlPieceId);
      }
    } catch (_) {
      if (!collab.localUser.isCustomized) {
        this.openJoinModal(urlPieceId);
      }
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

  async openHistoryModal() {
    if (!this.dom.modalVersionHistory) return;
    this.renderHistoryList(collab.historyList);
    this.dom.modalVersionHistory.style.display = 'flex';
    // Carrega histórico da nuvem sob demanda apenas ao abrir o modal (economiza milhares de leituras)
    await collab.loadHistory();
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

  // =========================================================================
  // GESTÃO DE BOSSAS E PEÇAS EMBUTIDAS (MODAL DE INSERÇÃO & EXPORTAÇÃO)
  // =========================================================================

  setupBossaModals() {
    // 1. Abertura do modal de inserção de bossa
    this.dom.btnMenuInsertBossa?.addEventListener('click', () => {
      if (this.dom.appMenuDropdown) this.dom.appMenuDropdown.style.display = 'none';
      this.openInsertBossaModal();
    });

    this.dom.btnOpenInsertBossaModal?.addEventListener('click', () => {
      this.openInsertBossaModal();
    });

    this.dom.btnToolbarInsertBossa?.addEventListener('click', () => {
      const idx = this.renderer?.selectedMeasureIndex ?? (this.selectedMeasureIndices.size > 0 ? Math.max(...this.selectedMeasureIndices) : null);
      this.openInsertBossaModal(idx);
    });

    this.dom.btnToolbarSaveAsBossa?.addEventListener('click', () => {
      const indices = this.selectedMeasureIndices.size > 0
        ? Array.from(this.selectedMeasureIndices)
        : (this.renderer?.selectedMeasureIndex !== null ? [this.renderer.selectedMeasureIndex] : []);
      this.openSaveAsBossaModal(indices);
    });

    // Abrir a Página do Gerenciador de Bossas
    this.dom.btnOpenBossaManager?.addEventListener('click', () => {
      this.openBossaManager(true);
    });

    this.dom.btnMenuManageBossas?.addEventListener('click', () => {
      this.openBossaManager(true);
    });

    this.dom.btnOpenManagerFromInsert?.addEventListener('click', () => {
      this.closeInsertBossaModal();
      this.openBossaManager(true);
    });

    // Navegação Direta no Topo Esquerdo (Simulador vs Repertório)
    this.dom.btnNavSimulator?.addEventListener('click', () => {
      if (this.currentView === 'bossas') this.closeBossaManager(true);
    });

    this.dom.btnNavRepertoire?.addEventListener('click', () => {
      if (this.currentView !== 'bossas') this.openBossaManager(true);
    });

    // Fechar Gerenciador de Bossas / Voltar ao Simulador
    this.dom.btnBackToSimulator?.addEventListener('click', () => this.closeBossaManager(true));
    this.dom.btnBackToSimulatorBottom?.addEventListener('click', () => this.closeBossaManager(true));

    // Indicador de Sincronização Automática na Nuvem
    this.dom.bossaMgrSyncIndicator?.addEventListener('click', () => {
      if (!this.authService || !this.authService.isLoggedIn()) {
        this.openAuthModal('login');
      } else {
        this.handleSyncBossas(false);
      }
    });

    // Ações Rápidas do Gerenciador
    this.dom.btnMgrCreateNewBlankPiece?.addEventListener('click', () => {
      this.closeBossaManager(true);
      this.openConfirmNewModal();
    });

    this.dom.btnMgrSaveCurrentPiece?.addEventListener('click', () => {
      this.handleExplicitSaveCurrentPiece();
    });

    this.dom.btnMgrNewBossaFromCurrent?.addEventListener('click', () => {
      this.handleCreateBossaFromCurrent();
    });

    this.dom.btnClearAllPresets?.addEventListener('click', () => {
      this.handleClearAllPresets();
    });

    this.dom.btnRestorePresets?.addEventListener('click', () => {
      this.handleRestorePresets();
    });

    this.dom.fileImportBossa?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) {
        this.handleImportBossaFile(file);
        e.target.value = '';
      }
    });

    // Busca e Filtros no Gerenciador
    this.dom.inputSearchBossas?.addEventListener('input', (e) => {
      this.mgrSearchQuery = e.target.value;
      if (this.dom.btnClearSearchBossas) {
        this.dom.btnClearSearchBossas.style.display = this.mgrSearchQuery ? 'block' : 'none';
      }
      this.renderBossaManagerCards();
    });

    this.dom.btnClearSearchBossas?.addEventListener('click', () => {
      if (this.dom.inputSearchBossas) this.dom.inputSearchBossas.value = '';
      this.mgrSearchQuery = '';
      this.dom.btnClearSearchBossas.style.display = 'none';
      this.renderBossaManagerCards();
      this.dom.inputSearchBossas?.focus();
    });

    // Filtros de abas / pílulas no Gerenciador
    const filterPills = this.dom.viewBossaManager?.querySelectorAll('.bossa-filter-pill');
    filterPills?.forEach(pill => {
      pill.addEventListener('click', () => {
        filterPills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        this.currentMgrFilter = pill.dataset.filter || 'all';
        this.renderBossaManagerCards();
      });
    });

    // Modal de Renomear Bossa
    this.dom.btnRenameBossaClose?.addEventListener('click', () => this.closeRenameBossaModal());
    this.dom.btnCancelRenameBossa?.addEventListener('click', () => this.closeRenameBossaModal());
    this.dom.modalRenameBossa?.addEventListener('click', (e) => {
      if (e.target === this.dom.modalRenameBossa) this.closeRenameBossaModal();
    });
    this.dom.formRenameBossa?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleConfirmRenameBossa();
    });

    // 2. Fechar modal de inserção de bossa
    this.dom.btnInsertBossaClose?.addEventListener('click', () => this.closeInsertBossaModal());
    this.dom.btnCancelInsertBossa?.addEventListener('click', () => this.closeInsertBossaModal());
    this.dom.modalInsertBossa?.addEventListener('click', (e) => {
      if (e.target === this.dom.modalInsertBossa) this.closeInsertBossaModal();
    });

    // 3. Abas do modal de inserção (Minhas Peças vs Bossas & Modelos Prontos)
    this.dom.tabBossaLibrary?.addEventListener('click', () => {
      this.currentBossaTab = 'library';
      this.dom.tabBossaLibrary.classList.add('active');
      this.dom.tabBossaPresets?.classList.remove('active');
      this.renderBossaModalList();
    });

    this.dom.tabBossaPresets?.addEventListener('click', () => {
      this.currentBossaTab = 'presets';
      this.dom.tabBossaPresets.classList.add('active');
      this.dom.tabBossaLibrary?.classList.remove('active');
      this.renderBossaModalList();
    });

    // 4. Confirmar inserção
    this.dom.btnConfirmInsertBossa?.addEventListener('click', () => {
      this.handleConfirmInsertBossa();
    });

    // 5. Modal de salvar como Bossa
    this.dom.btnSaveAsBossaClose?.addEventListener('click', () => this.closeSaveAsBossaModal());
    this.dom.btnCancelSaveAsBossa?.addEventListener('click', () => this.closeSaveAsBossaModal());
    this.dom.modalSaveAsBossa?.addEventListener('click', (e) => {
      if (e.target === this.dom.modalSaveAsBossa) this.closeSaveAsBossaModal();
    });

    this.dom.btnConfirmSaveAsBossa?.addEventListener('click', () => {
      this.handleConfirmSaveAsBossa();
    });

    this.dom.radioSaveTypeBossa?.addEventListener('change', () => {
      this.updateSaveAsItemModalUI();
    });

    this.dom.radioSaveTypePiece?.addEventListener('change', () => {
      this.updateSaveAsItemModalUI();
    });

    this.dom.inputBossaName?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.handleConfirmSaveAsBossa();
      }
    });
  }

  openInsertBossaModal(targetIdx = null) {
    if (!this.dom.modalInsertBossa) return;

    if (targetIdx !== null && targetIdx !== undefined && targetIdx >= 0) {
      this.bossaTargetIndex = targetIdx;
    } else if (this.selectedMeasureIndices.size > 0) {
      this.bossaTargetIndex = Math.max(...this.selectedMeasureIndices);
    } else {
      this.bossaTargetIndex = null;
    }

    if (this.bossaTargetIndex !== null && this.bossaTargetIndex < state.measures.length) {
      if (this.dom.radioBossaPosSelected) {
        this.dom.radioBossaPosSelected.disabled = false;
        this.dom.radioBossaPosSelected.checked = true;
      }
      if (this.dom.labelBossaPosSelected) {
        this.dom.labelBossaPosSelected.textContent = `Após o compasso selecionado (c. ${this.bossaTargetIndex + 1})`;
      }
    } else {
      if (this.dom.radioBossaPosSelected) {
        this.dom.radioBossaPosSelected.disabled = true;
        this.dom.radioBossaPosSelected.checked = false;
      }
      if (this.dom.radioBossaPosEnd) {
        this.dom.radioBossaPosEnd.checked = true;
      }
      if (this.dom.labelBossaPosSelected) {
        this.dom.labelBossaPosSelected.textContent = 'Após o compasso selecionado (nenhum selecionado)';
      }
    }

    this.selectedBossaPiece = null;
    if (this.dom.btnConfirmInsertBossa) {
      this.dom.btnConfirmInsertBossa.disabled = true;
    }

    // Inicializa na aba correta
    if (this.currentBossaTab === 'presets') {
      this.dom.tabBossaPresets?.classList.add('active');
      this.dom.tabBossaLibrary?.classList.remove('active');
    } else {
      this.currentBossaTab = 'library';
      this.dom.tabBossaLibrary?.classList.add('active');
      this.dom.tabBossaPresets?.classList.remove('active');
    }

    this.renderBossaModalList();
    this.dom.modalInsertBossa.style.display = 'flex';
  }

  closeInsertBossaModal() {
    if (this.dom.modalInsertBossa) {
      this.dom.modalInsertBossa.style.display = 'none';
    }
  }

  renderBossaModalList() {
    const container = this.dom.bossaListContainer;
    if (!container) return;

    container.innerHTML = '';
    let pieces = [];

    if (this.currentBossaTab === 'library') {
      const allLibrary = state.getLibraryPieces();
      // Não mostra a própria peça aberta para evitar autorreferência direta
      pieces = allLibrary.filter(p => p.id !== state.id);

      if (pieces.length === 0) {
        container.innerHTML = `
          <div class="bossa-empty-state">
            <span class="bossa-empty-icon">📂</span>
            <h4>Nenhuma outra peça na biblioteca</h4>
            <p>Você pode salvar compassos da apresentação atual como Bossa (botão "Salvar como Bossa") ou explorar os modelos na aba "Bossas & Modelos Prontos".</p>
          </div>
        `;
        return;
      }
    } else {
      // Aba de Presets / Modelos Prontos
      const activePresets = this.getActivePresets();
      pieces = [...activePresets].sort((a, b) => {
        const aIsBossa = a.id?.startsWith('bossa-') ? 1 : 0;
        const bIsBossa = b.id?.startsWith('bossa-') ? 1 : 0;
        return bIsBossa - aIsBossa;
      });

      if (pieces.length === 0) {
        container.innerHTML = `
          <div class="bossa-empty-state">
            <span class="bossa-empty-icon">⭐</span>
            <h4>Nenhum modelo disponível</h4>
            <p>Você removeu os modelos de exemplo do seu repertório. Você pode restaurá-los na página de Repertório se desejar.</p>
          </div>
        `;
        return;
      }
    }

    pieces.forEach(p => {
      const card = document.createElement('div');
      card.className = 'bossa-card-item';
      if (this.selectedBossaPiece?.id === p.id) {
        card.classList.add('selected');
      }

      const measureCount = Array.isArray(p.measures) ? p.measures.length : 0;
      const bpm = p.presentationBpm || p.baseBpm || 120;
      const { totalDuration: modalDuration } = state.calculateTimingsForMeasures(p.measures, bpm);
      const modalDurationStr = this.formatFriendlyDuration(modalDuration);
      const isPresetBossa = p.id?.startsWith('bossa-') || Boolean(p.isBossa && PRESETS.some(pr => pr.id === p.id));
      const isCloudBossa = Boolean(p.ownerId);
      const badgeText = isPresetBossa ? '🥁 Modelo Pronto' : (p.isBossa ? (isCloudBossa ? '🥁 Bossa ☁️' : '🥁 Bossa 💾') : '🎵 Peça');

      card.innerHTML = `
        <div class="bossa-card-item-top">
          <div class="bossa-card-title-wrap">
            <span class="bossa-card-badge">${badgeText}</span>
            <span class="bossa-card-title">${escapeHtml(p.name || 'Sem título')}</span>
          </div>
          <span class="bossa-card-meta">${measureCount} comp. • ${bpm} BPM • ⏱️ ${modalDurationStr}</span>
        </div>
        ${p.description ? `<p class="bossa-card-desc">${escapeHtml(p.description)}</p>` : ''}
      `;

      card.addEventListener('click', () => {
        container.querySelectorAll('.bossa-card-item').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        this.selectedBossaPiece = p;
        if (this.dom.btnConfirmInsertBossa) {
          this.dom.btnConfirmInsertBossa.disabled = false;
        }
      });

      card.addEventListener('dblclick', () => {
        this.selectedBossaPiece = p;
        this.handleConfirmInsertBossa();
      });

      container.appendChild(card);
    });
  }

  handleConfirmInsertBossa() {
    if (!this.selectedBossaPiece) return;

    let targetIndex = state.measures.length;
    if (this.dom.radioBossaPosSelected && this.dom.radioBossaPosSelected.checked && this.bossaTargetIndex !== null) {
      targetIndex = this.bossaTargetIndex + 1;
    }

    const isLinked = this.dom.radioBossaModeLinked ? this.dom.radioBossaModeLinked.checked : true;

    const result = state.insertBossa(this.selectedBossaPiece, targetIndex, isLinked);
    this.closeInsertBossaModal();

    if (result) {
      this.renderMeasuresList();
      this.handleMeasureSelected(result.startIndex);
      const t = state.getFirstTimingForMeasure(result.startIndex);
      if (t) this.seekTo(t.startTime);
      this.showToast(
        isLinked
          ? `Bossa '${this.selectedBossaPiece.name}' vinculada com sucesso! Atualizações serão refletidas automaticamente.`
          : `Bossa '${this.selectedBossaPiece.name}' inserida como cópia independente!`,
        '🔗'
      );
    }
  }

  openSaveAsBossaModal(indices = [], defaultType = 'bossa') {
    if (!this.dom.modalSaveAsBossa) return;

    if (!indices || indices.length === 0) {
      if (this.renderer?.selectedMeasureIndex !== null && this.renderer?.selectedMeasureIndex !== undefined) {
        indices = [this.renderer.selectedMeasureIndex];
      } else {
        this.showToast('Selecione ao menos um compasso na partitura para salvar.', '⚠️');
        return;
      }
    }

    this._saveBossaIndices = indices.sort((a, b) => a - b);
    const count = this._saveBossaIndices.length;

    if (this.dom.saveAsBossaCount) {
      this.dom.saveAsBossaCount.textContent = `${count} ${count === 1 ? 'compasso selecionado' : 'compassos selecionados'}`;
    }

    const isBossa = defaultType === 'bossa';
    if (this.dom.radioSaveTypeBossa) this.dom.radioSaveTypeBossa.checked = isBossa;
    if (this.dom.radioSaveTypePiece) this.dom.radioSaveTypePiece.checked = !isBossa;

    const minNum = this._saveBossaIndices[0] + 1;
    const maxNum = this._saveBossaIndices[count - 1] + 1;
    const rangeStr = count === 1 ? `c. ${minNum}` : `c. ${minNum}-${maxNum}`;

    if (this.dom.inputBossaName) {
      this.dom.inputBossaName.value = isBossa
        ? `Bossa - ${state.name} (${rangeStr})`
        : `${state.name} (Trecho ${rangeStr})`;
    }

    this.updateSaveAsItemModalUI();

    this.dom.modalSaveAsBossa.style.display = 'flex';
    setTimeout(() => {
      this.dom.inputBossaName?.focus();
      this.dom.inputBossaName?.select();
    }, 50);
  }

  updateSaveAsItemModalUI() {
    const isPiece = this.dom.radioSaveTypePiece?.checked;
    if (this.dom.modalSaveAsBossaHeading) {
      this.dom.modalSaveAsBossaHeading.textContent = isPiece ? 'Salvar como Peça Completa' : 'Salvar como Bossa / Paradinha';
    }
    if (this.dom.labelSaveItemName) {
      this.dom.labelSaveItemName.textContent = isPiece ? 'Nome da Peça:' : 'Nome da Bossa:';
    }
    if (this.dom.btnConfirmSaveAsBossaText) {
      this.dom.btnConfirmSaveAsBossaText.textContent = isPiece ? 'Salvar Peça no Repertório' : 'Salvar Bossa na Biblioteca';
    }
  }

  closeSaveAsBossaModal() {
    if (this.dom.modalSaveAsBossa) {
      this.dom.modalSaveAsBossa.style.display = 'none';
    }
  }

  handleConfirmSaveAsBossa() {
    if (!this._saveBossaIndices || this._saveBossaIndices.length === 0) return;

    const isBossa = !this.dom.radioSaveTypePiece?.checked;
    const typeLabel = isBossa ? 'Bossa' : 'Peça';
    const defaultName = isBossa ? 'Nova Bossa' : 'Nova Peça';
    const name = (this.dom.inputBossaName?.value || '').trim() || defaultName;

    const newItem = state.saveMeasuresAsItem(this._saveBossaIndices, name, isBossa);

    this.closeSaveAsBossaModal();

    if (newItem) {
      if (this.authService && this.authService.isLoggedIn()) {
        collab.saveBossaToCloud(newItem).then(() => {
          this.showToast(`${typeLabel} '${name}' salva e sincronizada na nuvem! ☁️`, '💾');
        }).catch(err => {
          console.warn(`Erro ao salvar ${typeLabel} na nuvem:`, err);
          this.showToast(`${typeLabel} '${name}' salva na sua biblioteca local!`, '💾');
        });
      } else {
        this.showToast(`${typeLabel} '${name}' salva localmente! Conecte-se para sincronizar.`, '💾');
      }
      this.initPresetsDropdown();
      if (this.currentView === 'bossas' || (this.dom.viewBossaManager && this.dom.viewBossaManager.style.display === 'flex')) {
        this.renderBossaManagerCards();
      }
    }
  }

  /* =========================================================================
     GERENCIADOR DE BOSSAS & REPERTÓRIO (PAINEL DEDICADO, PRÉVIA & NUVEM)
     ========================================================================= */

  openBossaManager(updateHash = true) {
    if (!this.dom.viewBossaManager) return;
    if (this.dom.appMenuDropdown) this.dom.appMenuDropdown.style.display = 'none';
    if (this.dom.userMenuDropdown) this.dom.userMenuDropdown.style.display = 'none';

    // Salva qual aba mobile estava ativa antes de ir pro repertório
    if (this.activeMobileTab && this.activeMobileTab !== 'bossas') {
      this.previousMobileTab = this.activeMobileTab;
    }

    this.currentView = 'bossas';
    if (this.dom.viewSimulator) {
      this.dom.viewSimulator.style.display = 'none';
      this.dom.viewSimulator.classList.remove('active');
    }
    this.dom.viewBossaManager.style.display = 'flex';
    this.dom.viewBossaManager.classList.add('active');

    // Atualiza navegadores no topo esquerdo
    this.dom.btnNavSimulator?.classList.remove('active');
    this.dom.btnNavRepertoire?.classList.add('active');

    // Atualiza tab do rodapé mobile
    this.dom.tabNavStage?.classList.remove('active');
    this.dom.tabNavMeasures?.classList.remove('active');
    this.dom.tabNavPiece?.classList.remove('active');
    this.dom.tabNavBossas?.classList.add('active');
    document.body.setAttribute('data-view', 'bossas');

    if (updateHash && window.location.hash !== '#bossas' && window.location.hash !== '#/bossas') {
      history.pushState({ view: 'bossas' }, '', '#/bossas');
    }

    this.updateBossaManagerSyncIndicator();
    this.renderBossaManagerCards();

    // Sincroniza em segundo plano ao abrir o gerenciador
    if (this.authService && this.authService.isLoggedIn()) {
      this.handleSyncBossas(false);
    }

    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  closeBossaManager(updateHash = true) {
    this.stopBossaPreview();
    this.currentView = 'simulator';

    if (this.dom.viewBossaManager) {
      this.dom.viewBossaManager.style.display = 'none';
      this.dom.viewBossaManager.classList.remove('active');
    }
    if (this.dom.viewSimulator) {
      this.dom.viewSimulator.style.display = 'flex';
      this.dom.viewSimulator.style.flexDirection = 'column';
      this.dom.viewSimulator.classList.add('active');
    }

    // Atualiza navegadores no topo esquerdo
    this.dom.btnNavRepertoire?.classList.remove('active');
    this.dom.btnNavSimulator?.classList.add('active');

    this.dom.tabNavBossas?.classList.remove('active');
    document.body.removeAttribute('data-view');

    // Restaura a aba mobile correta
    const targetMobileTab = this.previousMobileTab || 'stage';
    this.setMobileTab(targetMobileTab);

    if (updateHash && (window.location.hash === '#bossas' || window.location.hash === '#/bossas')) {
      history.pushState({ view: 'simulator' }, '', '#/');
    }

    requestAnimationFrame(() => {
      this.renderer?.resize();
      this.renderMeasuresList();
      this.renderQuickMeasureStrip();
      this.updateHUD(this.playbackTime || 0);
    });
  }

  updateBossaManagerSyncIndicator(status = 'idle', message = null) {
    const dot = this.dom.bossaSyncDot;
    const text = this.dom.bossaMgrSyncText;
    const container = this.dom.bossaMgrSyncIndicator;
    if (!dot || !text) return;

    if (status === 'syncing') {
      dot.className = 'sync-dot syncing';
      text.textContent = message || 'Sincronizando com a nuvem...';
      if (container) {
        container.classList.remove('clickable');
        container.title = 'Sincronizando biblioteca com a nuvem...';
      }
      return;
    }

    if (this.authService && this.authService.isLoggedIn()) {
      dot.className = 'sync-dot';
      text.textContent = message || 'Sincronizado automaticamente';
      if (container) {
        container.classList.remove('clickable');
        container.title = 'Suas músicas sincronizam automaticamente com a nuvem.';
      }
    } else {
      dot.className = 'sync-dot offline';
      text.textContent = message || 'Salvo no dispositivo (conectar nuvem)';
      if (container) {
        container.classList.add('clickable');
        container.title = 'Clique para entrar com sua conta e ativar a sincronização automática.';
      }
    }
  }

  async handleSyncBossas(showToastNotice = false) {
    if (!this.authService || !this.authService.isLoggedIn()) {
      if (showToastNotice) {
        this.openAuthModal('login');
        this.showToast('Faça login para sincronizar suas bossas na nuvem!', '☁️');
      }
      return;
    }

    this.updateBossaManagerSyncIndicator('syncing');

    try {
      await collab.syncUserLibraryWithCloud(state);
      this.updateBossaManagerSyncIndicator('idle', 'Sincronizado automaticamente');
      this.renderBossaManagerCards();
      this.initPresetsDropdown();
      if (showToastNotice) {
        this.showToast('Bossas sincronizadas com sua conta na nuvem!', '☁️');
      }
    } catch (err) {
      console.warn("Erro ao sincronizar bossas:", err);
      this.updateBossaManagerSyncIndicator('idle', 'Salvo localmente (offline)');
      if (showToastNotice) {
        this.showToast('Não foi possível sincronizar no momento.', '⚠️');
      }
    }
  }

  // Retorna os modelos pré-definidos (PRESETS) excluindo os que o usuário removeu/ocultou
  getActivePresets() {
    try {
      const raw = localStorage.getItem('sergio_hidden_presets');
      const hidden = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(hidden) || hidden.length === 0) return [...PRESETS];
      const hiddenSet = new Set(hidden);
      return PRESETS.filter(p => !hiddenSet.has(p.id));
    } catch (_) {
      return [...PRESETS];
    }
  }

  getHiddenPresetIds() {
    try {
      const raw = localStorage.getItem('sergio_hidden_presets');
      const hidden = raw ? JSON.parse(raw) : [];
      return Array.isArray(hidden) ? hidden : [];
    } catch (_) {
      return [];
    }
  }

  setHiddenPresetIds(ids) {
    try {
      localStorage.setItem('sergio_hidden_presets', JSON.stringify(ids));
    } catch (_) {}
  }

  // Remove individualmente um modelo pré-definido (PRESET) do repertório do usuário
  handleDeletePreset(preset) {
    if (!preset || !preset.id) return;
    const confirmMsg = `Deseja remover o modelo "${preset.name || 'Modelo'}" do seu repertório?\n\n(Você poderá restaurá-lo depois se quiser).`;
    if (!window.confirm(confirmMsg)) return;

    if (this.activePreviewBossaId === preset.id) {
      this.stopBossaPreview();
    }

    const hiddenIds = this.getHiddenPresetIds();
    if (!hiddenIds.includes(preset.id)) {
      hiddenIds.push(preset.id);
      this.setHiddenPresetIds(hiddenIds);
    }

    // Se estiver com este preset aberto no palco, reseta para uma peça nova em branco
    if (state.id === preset.id) {
      state.createNewPiece("Nova Peça", 120);
      collab.cleanupUrlPieceParam();
      this.seekTo(0);
      this.renderMeasuresList();
      this.renderQuickMeasureStrip();
      this.updateHUD(0);
      if (this.renderer) {
        this.renderer.resize();
        this.renderer.render(0);
      }
    }

    this.renderBossaManagerCards();
    this.initPresetsDropdown();
    this.showToast(`Modelo '${preset.name || 'Item'}' removido do repertório!`, '🗑️');
  }

  // Limpa/oculta todos os modelos de exemplo de uma só vez
  handleClearAllPresets() {
    const confirmMsg = 'Deseja limpar todos os modelos de exemplo do seu repertório?\n\nSuas próprias peças e bossas continuarão salvas normalmente, e você poderá restaurar os modelos a qualquer momento.';
    if (!window.confirm(confirmMsg)) return;

    if (this.activePreviewBossaId && PRESETS.some(p => p.id === this.activePreviewBossaId)) {
      this.stopBossaPreview();
    }

    const allPresetIds = PRESETS.map(p => p.id);
    this.setHiddenPresetIds(allPresetIds);

    // Se estiver com qualquer preset aberto no palco, inicia uma peça limpa
    if (PRESETS.some(p => p.id === state.id)) {
      state.createNewPiece("Nova Peça", 120);
      collab.cleanupUrlPieceParam();
      this.seekTo(0);
      this.renderMeasuresList();
      this.renderQuickMeasureStrip();
      this.updateHUD(0);
      if (this.renderer) {
        this.renderer.resize();
        this.renderer.render(0);
      }
    }

    this.renderBossaManagerCards();
    this.initPresetsDropdown();
    this.showToast('Todos os modelos de exemplo foram removidos do seu repertório! 🧹', '✨');
  }

  // Restaura todos os modelos originais
  handleRestorePresets() {
    try {
      localStorage.removeItem('sergio_hidden_presets');
    } catch (_) {}

    this.renderBossaManagerCards();
    this.initPresetsDropdown();
    this.showToast('Modelos de exemplo restaurados com sucesso! ⭐', '↺');
  }

  renderBossaManagerCards() {
    const container = this.dom.bossaMgrCardsContainer;
    if (!container) return;

    const isItemBossa = (p) => p.isBossa !== undefined ? Boolean(p.isBossa) : Boolean(p.id?.startsWith('piece-bossa-') || p.id?.startsWith('bossa-'));

    const localLibrary = state.getLibraryPieces ? state.getLibraryPieces() : [];
    const myPieces = localLibrary.filter(p => !isItemBossa(p));
    const myBossas = localLibrary.filter(p => isItemBossa(p));
    const allUserItems = [...localLibrary];
    const cloudItems = allUserItems.filter(p => Boolean(p.ownerId));
    const presetItems = this.getActivePresets();
    const hiddenPresetIds = this.getHiddenPresetIds();

    // Visibilidade dos botões de controle de modelos
    if (this.dom.btnClearAllPresets) {
      this.dom.btnClearAllPresets.style.display = presetItems.length > 0 ? 'inline-flex' : 'none';
    }
    if (this.dom.btnRestorePresets) {
      this.dom.btnRestorePresets.style.display = hiddenPresetIds.length > 0 ? 'inline-flex' : 'none';
    }

    // Atualiza contadores dos filtros
    const totalCount = allUserItems.length + presetItems.length;
    if (this.dom.countFilterAll) this.dom.countFilterAll.textContent = totalCount;
    if (this.dom.countFilterPieces) this.dom.countFilterPieces.textContent = myPieces.length;
    if (this.dom.countFilterBossas) this.dom.countFilterBossas.textContent = myBossas.length;
    if (this.dom.countFilterMy) this.dom.countFilterMy.textContent = allUserItems.length;
    if (this.dom.countFilterCloud) this.dom.countFilterCloud.textContent = cloudItems.length;
    if (this.dom.countFilterPresets) this.dom.countFilterPresets.textContent = presetItems.length;

    // Atualiza cards de métricas no topo da página
    if (this.dom.statTotalBossas) this.dom.statTotalBossas.textContent = totalCount;
    if (this.dom.statMyPieces) this.dom.statMyPieces.textContent = myPieces.length;
    if (this.dom.statMyBossas) this.dom.statMyBossas.textContent = myBossas.length;
    if (this.dom.statCloudBossas) this.dom.statCloudBossas.textContent = cloudItems.length;
    if (this.dom.statPresetBossas) this.dom.statPresetBossas.textContent = presetItems.length;

    // Seleção de itens conforme filtro ativo
    let items = [];
    if (this.currentMgrFilter === 'pieces') {
      items = [...myPieces];
    } else if (this.currentMgrFilter === 'bossas') {
      items = [...myBossas];
    } else if (this.currentMgrFilter === 'cloud') {
      items = [...cloudItems];
    } else if (this.currentMgrFilter === 'presets') {
      items = [...presetItems];
    } else if (this.currentMgrFilter === 'my') {
      items = [...allUserItems];
    } else {
      items = [...allUserItems, ...presetItems];
    }

    // Busca textual
    const query = (this.mgrSearchQuery || '').trim().toLowerCase();
    if (query) {
      items = items.filter(item => {
        const nameMatch = (item.name || '').toLowerCase().includes(query);
        const descMatch = (item.description || '').toLowerCase().includes(query);
        const bpmMatch = String(item.presentationBpm || item.baseBpm || '').includes(query);
        return nameMatch || descMatch || bpmMatch;
      });
    }

    // Atualiza estatísticas do rodapé
    if (this.dom.bossaMgrStats) {
      this.dom.bossaMgrStats.textContent = `Exibindo ${items.length} de ${totalCount} itens no repertório`;
    }

    container.innerHTML = '';

    if (items.length === 0) {
      const isPresetTab = this.currentMgrFilter === 'presets';
      const hasHiddenPresets = hiddenPresetIds.length > 0;
      container.innerHTML = `
        <div class="bossa-empty-state">
          <span class="bossa-empty-icon">${isPresetTab ? '⭐' : '🗂️'}</span>
          <h4>${isPresetTab ? 'Nenhum modelo de exemplo' : 'Nenhum item encontrado'}</h4>
          <p>${isPresetTab 
            ? (hasHiddenPresets ? 'Você removeu os modelos do seu repertório.' : 'Não há modelos disponíveis.')
            : 'Você pode criar novas peças ou bossas usando o botão "+ Nova Peça em Branco" ou importar um arquivo .json.'}
          </p>
          ${isPresetTab && hasHiddenPresets ? `
            <button type="button" class="btn-card-action insert btn-empty-restore" style="margin-top:12px;">
              <span class="btn-icon">↺</span> Restaurar Modelos Padrão
            </button>
          ` : ''}
        </div>
      `;
      container.querySelector('.btn-empty-restore')?.addEventListener('click', () => {
        this.handleRestorePresets();
      });
      return;
    }

    items.forEach(item => {
      const isPreset = PRESETS.some(p => p.id === item.id);
      const isCloud = Boolean(item.ownerId);
      const isBossa = isItemBossa(item);
      const isPlaying = this.activePreviewBossaId === item.id;
      const isCurrentOpen = state.id === item.id;
      const measures = Array.isArray(item.measures) ? item.measures : [];
      const bpm = item.presentationBpm || item.baseBpm || 120;

      const { totalDuration } = state.calculateTimingsForMeasures(measures, bpm);
      const durationStr = this.formatFriendlyDuration(totalDuration);

      // Badges de origem e tipo
      let badgesHtml = '';
      if (isPreset) {
        badgesHtml += `<span class="bossa-origin-badge preset">⭐ Modelo</span>`;
      } else if (isBossa) {
        badgesHtml += isCloud
          ? `<span class="bossa-origin-badge cloud">☁️ Bossa</span>`
          : `<span class="bossa-origin-badge local">🥁 Bossa Local</span>`;
      } else {
        badgesHtml += isCloud
          ? `<span class="bossa-origin-badge cloud">☁️ Peça</span>`
          : `<span class="bossa-origin-badge local">📜 Minha Peça</span>`;
      }

      if (isCurrentOpen) {
        badgesHtml += ` <span class="bossa-origin-badge" style="background:rgba(16, 185, 129, 0.2); color:#34d399; border:1px solid rgba(16,185,129,0.4);">▶ Aberta</span>`;
      }

      const card = document.createElement('div');
      card.className = `bossa-mgr-card ${isPlaying ? 'is-playing' : ''} ${isCurrentOpen ? 'is-current-piece' : ''}`;
      card.dataset.bossaId = item.id;

      card.innerHTML = `
        <div class="bossa-mgr-card-header">
          <div class="bossa-mgr-card-title-group">
            <h4 class="bossa-mgr-card-title">${escapeHtml(item.name || (isBossa ? 'Bossa Sem Título' : 'Peça Sem Título'))}</h4>
            ${badgesHtml}
          </div>
          <div class="bossa-mgr-card-meta">
            <span><strong>${measures.length}</strong> ${measures.length === 1 ? 'compasso' : 'compassos'}</span>
            <span>•</span>
            <span><strong>${bpm}</strong> BPM</span>
            <span>•</span>
            <span title="Tempo total: ${durationStr}">⏱️ <strong>${durationStr}</strong></span>
          </div>
        </div>

        ${item.description ? `<p class="bossa-card-desc">${escapeHtml(item.description)}</p>` : ''}

        <div class="bossa-card-actions">
          <div class="bossa-actions-left">
            <button type="button" class="btn-card-action preview ${isPlaying ? 'playing' : ''}" data-action="preview" data-id="${item.id}" title="Ouvir o áudio sintetizado">
              <span class="btn-icon">${isPlaying ? '⏹' : '▶'}</span> ${isPlaying ? 'Parar' : 'Ouvir Prévia'}
            </button>
            <button type="button" class="btn-card-action insert" data-action="insert" data-id="${item.id}" title="Inserir estes compassos na peça atual">
              <span class="btn-icon">🔗</span> Inserir na Peça
            </button>
            <button type="button" class="btn-card-action open" data-action="open" data-id="${item.id}" title="Abrir no simulador para tocar ou editar">
              <span class="btn-icon">📂</span> Abrir ${isBossa ? 'Bossa' : 'Peça'}
            </button>
          </div>
          <div class="bossa-actions-right">
            ${!isPreset ? `
              <button type="button" class="btn-card-action toggle-type" data-action="toggle-type" data-id="${item.id}" title="${isBossa ? 'Transformar em Peça Completa (mover para Minhas Peças)' : 'Transformar em Bossa / Paradinha (mover para Minhas Bossas)'}">
                <span class="btn-icon">🔄</span> ${isBossa ? 'Virar Peça' : 'Virar Bossa'}
              </button>
              <button type="button" class="btn-card-action icon-only" data-action="rename" data-id="${item.id}" title="Renomear">
                ✏️
              </button>
            ` : ''}
            <button type="button" class="btn-card-action icon-only" data-action="export" data-id="${item.id}" title="Exportar como JSON">
              💾
            </button>
            <button type="button" class="btn-card-action icon-only danger" data-action="delete" data-id="${item.id}" title="${isPreset ? 'Remover este modelo do repertório' : 'Apagar definitivamente da biblioteca e da nuvem'}">
              🗑️
            </button>
          </div>
        </div>
      `;

      card.querySelectorAll('button[data-action]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const action = btn.dataset.action;
          if (action === 'preview') this.playBossaPreview(item);
          else if (action === 'insert') this.handleInsertBossaFromManager(item);
          else if (action === 'open') this.handleOpenBossaAsPiece(item);
          else if (action === 'toggle-type') this.handleToggleItemType(item);
          else if (action === 'rename') this.handleOpenRenameBossaModal(item);
          else if (action === 'export') this.handleExportBossa(item);
          else if (action === 'delete') this.handleDeletePieceOrBossa(item);
        });
      });

      container.appendChild(card);
    });
  }

  async playBossaPreview(bossa) {
    if (this.activePreviewBossaId === bossa.id) {
      this.stopBossaPreview();
      return;
    }

    this.stopBossaPreview();
    if (!bossa || !Array.isArray(bossa.measures) || bossa.measures.length === 0) return;

    try {
      this.activePreviewBossaId = bossa.id;
      this.updateBossaCardPlayingState(bossa.id, true);

      const baseBpm = bossa.presentationBpm || bossa.baseBpm || 120;
      const { timings, totalDuration } = state.calculateTimingsForMeasures(bossa.measures, baseBpm);

      await this.audio.init();
      const buffer = await this.audio.renderPieceBuffer(timings, totalDuration);

      if (!buffer || this.activePreviewBossaId !== bossa.id) return;

      this.audio.play(
        buffer,
        0,
        1.0,
        false,
        totalDuration,
        () => {
          if (this.activePreviewBossaId === bossa.id) {
            this.stopBossaPreview();
          }
        }
      );
    } catch (err) {
      console.warn("Erro ao reproduzir prévia da bossa:", err);
      this.stopBossaPreview();
    }
  }

  stopBossaPreview() {
    if (this.activePreviewBossaId) {
      this.updateBossaCardPlayingState(this.activePreviewBossaId, false);
      this.activePreviewBossaId = null;
      this.audio.stop();
    }
  }

  updateBossaCardPlayingState(bossaId, isPlaying) {
    const card = this.dom.bossaMgrCardsContainer?.querySelector(`.bossa-mgr-card[data-bossa-id="${bossaId}"]`);
    if (card) {
      card.classList.toggle('is-playing', isPlaying);
      const btn = card.querySelector('button[data-action="preview"]');
      if (btn) {
        btn.classList.toggle('playing', isPlaying);
        btn.innerHTML = `<span class="btn-icon">${isPlaying ? '⏹' : '▶'}</span> ${isPlaying ? 'Parar' : 'Ouvir Prévia'}`;
      }
    }
  }

  handleInsertBossaFromManager(bossa) {
    if (!bossa || !bossa.measures) return;
    this.closeBossaManager();

    const targetIdx = (this.renderer?.selectedMeasureIndex !== null && this.renderer?.selectedMeasureIndex !== undefined)
      ? this.renderer.selectedMeasureIndex
      : (this.selectedMeasureIndices.size > 0 ? Math.max(...this.selectedMeasureIndices) : null);

    state.insertBossaBlock(bossa, targetIdx, true);
    this.closeMeasureToolbar();
    this.showToast(`Bossa '${bossa.name}' inserida na partitura!`, '🔗');
  }

  handleOpenBossaAsPiece(bossa) {
    if (!bossa || !bossa.measures) return;
    this.closeBossaManager(true);
    this.pausePlayback();

    // Salva a peça atual na biblioteca antes de alternar
    if (state.measures && state.measures.length > 0) {
      state.saveCurrentPieceToLibrary();
    }

    state.loadPieceData(JSON.parse(JSON.stringify(bossa)));
    collab.connectToPiece(state.id, state);
    this.seekTo(0);
    this.closeMeasureToolbar();
    this.initPresetsDropdown();
    const isBossa = bossa.isBossa !== undefined ? Boolean(bossa.isBossa) : Boolean(bossa.id?.startsWith('piece-bossa-') || bossa.id?.startsWith('bossa-'));
    this.showToast(`${isBossa ? 'Bossa' : 'Peça'} '${bossa.name}' aberta para edição!`, '📂');
  }

  handleOpenRenameBossaModal(bossa) {
    if (!this.dom.modalRenameBossa) return;
    if (this.dom.renameBossaId) this.dom.renameBossaId.value = bossa.id;
    if (this.dom.inputRenameBossaName) this.dom.inputRenameBossaName.value = bossa.name || '';
    this.dom.modalRenameBossa.style.display = 'flex';
    setTimeout(() => {
      this.dom.inputRenameBossaName?.focus();
      this.dom.inputRenameBossaName?.select();
    }, 50);
  }

  closeRenameBossaModal() {
    if (this.dom.modalRenameBossa) {
      this.dom.modalRenameBossa.style.display = 'none';
    }
  }

  handleConfirmRenameBossa() {
    const id = this.dom.renameBossaId?.value;
    const newName = (this.dom.inputRenameBossaName?.value || '').trim();
    if (!id || !newName) return;

    state.renameBossa(id, newName);

    // Se estiver logado, atualiza também na nuvem
    if (this.authService && this.authService.isLoggedIn()) {
      collab.updateBossaInCloud(id, { name: newName }).catch(err => {
        console.warn("Erro ao renomear bossa na nuvem:", err);
      });
    }

    this.closeRenameBossaModal();
    this.renderBossaManagerCards();
    this.initPresetsDropdown();
    this.showToast(`Bossa renomeada para '${newName}'!`, '✏️');
  }

  handleExportBossa(bossa) {
    if (!bossa) return;
    const jsonStr = JSON.stringify(bossa, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeName = (bossa.name || 'bossa').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    a.href = url;
    a.download = `bossa-${safeName}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this.showToast(`Bossa '${bossa.name}' exportada em JSON!`, '💾');
  }

  async handleDeletePieceOrBossa(item) {
    if (!item) return;
    if (PRESETS.some(p => p.id === item.id)) {
      return this.handleDeletePreset(item);
    }
    const isBossa = Boolean(item.isBossa || item.id?.startsWith('piece-bossa-') || item.id?.startsWith('bossa-'));
    const typeLabel = isBossa ? 'a bossa' : 'a peça';
    const confirmMsg = `Deseja realmente apagar ${typeLabel} "${item.name || 'Sem Título'}"?\n\nEsta ação removerá o item da biblioteca local e da nuvem.`;
    if (!window.confirm(confirmMsg)) return;

    if (this.activePreviewBossaId === item.id) {
      this.stopBossaPreview();
    }

    // 1. Remove da biblioteca local
    state.deletePieceFromLibrary(item.id);

    // 2. Remove da nuvem se autenticado
    if (this.authService && this.authService.isLoggedIn()) {
      await collab.deletePieceFromCloud(item.id).catch(err => {
        console.warn("Erro ao excluir item da nuvem:", err);
      });
    }

    // 3. Se a peça apagada for a peça atualmente aberta no palco, reseta para uma peça nova em branco
    if (state.id === item.id) {
      state.createNewPiece("Nova Peça", 120);
      collab.cleanupUrlPieceParam();
      this.updateHUD(0);
      this.renderMeasuresList();
      this.renderQuickMeasureStrip();
      if (this.renderer) {
        this.renderer.resize();
        this.renderer.render(0);
      }
    }

    this.renderBossaManagerCards();
    this.initPresetsDropdown();
    this.showToast(`${isBossa ? 'Bossa' : 'Peça'} '${item.name || 'Item'}' apagada com sucesso!`, '🗑️');
  }

  async handleDeleteBossa(bossa) {
    return this.handleDeletePieceOrBossa(bossa);
  }

  // Alterna o tipo do item entre Bossa / Paradinha e Peça Completa
  async handleToggleItemType(item) {
    if (!item || !item.id) return;

    const isBossa = item.isBossa !== undefined ? Boolean(item.isBossa) : Boolean(item.id.startsWith('piece-bossa-') || item.id.startsWith('bossa-'));
    const newIsBossa = !isBossa;
    const targetTypeLabel = newIsBossa ? 'Bossa / Paradinha' : 'Peça Completa';

    // 1. Atualiza na biblioteca local
    const localLibrary = state.getLibraryPieces ? state.getLibraryPieces() : [];
    const found = localLibrary.find(p => p.id === item.id);
    if (found) {
      found.isBossa = newIsBossa;
      found.updatedAt = Date.now();
      state.setLibraryPieces(localLibrary);
    }

    // 2. Se for a peça aberta atualmente no simulador, sincroniza state
    if (state.id === item.id) {
      state.isBossa = newIsBossa;
    }

    // 3. Se estiver na nuvem ou logado, atualiza no Firestore
    if (item.ownerId || (this.authService && this.authService.isLoggedIn())) {
      try {
        await collab.updateBossaInCloud(item.id, { isBossa: newIsBossa });
      } catch (err) {
        console.warn("Aviso ao atualizar tipo de item na nuvem:", err);
      }
    }

    // 4. Re-renderiza cartões e atualiza dropdowns
    this.renderBossaManagerCards();
    this.initPresetsDropdown();

    const toastEmoji = newIsBossa ? '🥁' : '📜';
    this.showToast(`"${item.name || 'Item'}" agora é uma ${targetTypeLabel}!`, toastEmoji);
  }

  // Salva explicitamente a peça atualmente aberta no repertório (local & nuvem)
  async handleExplicitSaveCurrentPiece() {
    if (!state.measures || state.measures.length === 0) {
      this.showToast('A peça está vazia. Adicione ao menos um compasso.', '⚠️');
      return;
    }

    // Atualiza nome da peça se editado no input
    if (this.dom.inputPieceName) {
      const cleanName = this.dom.inputPieceName.value.trim();
      if (cleanName) state.name = cleanName;
    }

    const saved = state.saveCurrentPieceToLibrary();

    if (saved && this.authService && this.authService.isLoggedIn()) {
      try {
        await collab.savePieceToCloud(saved);
        this.updateSyncStatus('synced', 'Salvo na Nuvem');
        this.showToast(`Peça '${state.name}' salva e sincronizada na nuvem! ☁️`, '💾');
      } catch (err) {
        console.warn("Aviso ao salvar peça na nuvem:", err);
        this.showToast(`Peça '${state.name}' salva no repertório local!`, '💾');
      }
    } else {
      this.showToast(`Peça '${state.name}' salva no repertório local!`, '💾');
    }

    this.initPresetsDropdown();
    if (this.currentView === 'bossas' || (this.dom.viewBossaManager && this.dom.viewBossaManager.style.display === 'flex')) {
      this.renderBossaManagerCards();
    }
  }

  handleCreateBossaFromCurrent() {
    let indices = this.selectedMeasureIndices.size > 0
      ? Array.from(this.selectedMeasureIndices)
      : (this.renderer?.selectedMeasureIndex !== null && this.renderer?.selectedMeasureIndex !== undefined ? [this.renderer.selectedMeasureIndex] : []);

    if (indices.length === 0 && state.measures && state.measures.length > 0) {
      indices = state.measures.map((_, i) => i);
    }

    if (indices.length === 0) {
      this.showToast('Nenhum compasso na peça para extrair.', '⚠️');
      return;
    }

    this.closeBossaManager(true);
    this.openSaveAsBossaModal(indices, 'bossa');
  }

  handleImportBossaFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const parsed = JSON.parse(e.target.result);
        const bossaData = parsed.piece || parsed;
        if (!bossaData || !Array.isArray(bossaData.measures) || bossaData.measures.length === 0) {
          throw new Error('Arquivo não contém uma estrutura de compassos válida.');
        }

        const newId = `piece-bossa-${Date.now()}`;
        const importedBossa = {
          ...bossaData,
          id: newId,
          name: bossaData.name || 'Bossa Importada',
          isBossa: true,
          updatedAt: Date.now(),
          createdAt: Date.now()
        };

        const library = state.getLibraryPieces();
        library.unshift(importedBossa);
        state.setLibraryPieces(library);

        if (this.authService && this.authService.isLoggedIn()) {
          await collab.saveBossaToCloud(importedBossa);
        }

        this.renderBossaManagerCards();
        this.initPresetsDropdown();
        this.showToast(`Bossa '${importedBossa.name}' importada com sucesso!`, '📥');
      } catch (err) {
        alert(`Erro ao importar arquivo de bossa: ${err.message}`);
      }
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
