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
import { iconSvg, initIcons } from './icons.js';

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
    this._editingMeasureIndices = [];
    this._nicknameDirty = false;

    // Área de transferência de compassos (Ctrl+C, Ctrl+X, Ctrl+V)
    this.clipboardMeasures = [];
    try {
      const savedClip = localStorage.getItem('sergio_clipboard_measures');
      if (savedClip) {
        const parsed = JSON.parse(savedClip);
        if (Array.isArray(parsed)) this.clipboardMeasures = parsed;
      }
    } catch (_) {}

    // Gestão de Bossas Embutidas & Gerenciador
    this.selectedBossaPiece = null;
    this.currentBossaTab = 'library';
    this.bossaTargetIndex = null;
    this._saveBossaIndices = [];
    this.currentMgrFilter = 'all';
    this.mgrSearchQuery = '';
    this.insertBossaSearchQuery = '';
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
    initIcons();

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

    // Sincronização em segundo plano: o listener em tempo real já cobre mudanças remotas,
    // então aqui só fazemos um refresh ao voltar para a aba/reconectar (throttled no collab).
    const backgroundSync = () => {
      if (!document.hidden && this.authService && this.authService.isLoggedIn()) {
        this.handleSyncBossas(false);
      }
    };
    document.addEventListener('visibilitychange', backgroundSync);
    window.addEventListener('online', backgroundSync);

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

    this.toggleTheme = toggleTheme;
    this.dom.btnThemeToggle?.addEventListener('click', toggleTheme);
    this.dom.btnThemeToggleBossaMgr?.addEventListener('click', toggleTheme);
    this.dom.btnUserThemeToggle?.addEventListener('click', () => {
      toggleTheme();
      if (this.dom.userMenuDropdown) this.dom.userMenuDropdown.style.display = 'none';
    });
    this.dom.btnAppMenuThemeToggle?.addEventListener('click', () => {
      toggleTheme();
      if (this.dom.appMenuDropdown) this.dom.appMenuDropdown.style.display = 'none';
    });
  }

  setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('sergio_theme', theme);

    const isDark = theme === 'dark';
    const nextIconSvg = isDark ? iconSvg('sun', { size: 16 }) : iconSvg('moon', { size: 16 });
    const nextLabel = isDark ? 'Mudar para Tema Claro' : 'Mudar para Tema Escuro';

    if (this.dom.themeIcon) {
      this.dom.themeIcon.innerHTML = nextIconSvg;
    }
    if (this.dom.themeIconBossaMgr) {
      this.dom.themeIconBossaMgr.innerHTML = nextIconSvg;
    }
    if (this.dom.userMenuThemeIcon) {
      this.dom.userMenuThemeIcon.innerHTML = nextIconSvg;
    }
    if (this.dom.userMenuThemeLabel) {
      this.dom.userMenuThemeLabel.textContent = nextLabel;
    }
    if (this.dom.appMenuThemeIcon) {
      this.dom.appMenuThemeIcon.innerHTML = nextIconSvg;
    }
    if (this.dom.appMenuThemeLabel) {
      this.dom.appMenuThemeLabel.textContent = nextLabel;
    }
    if (this.dom.btnThemeToggle) {
      this.dom.btnThemeToggle.title = isDark ? 'Mudar para Tema Claro (T)' : 'Mudar para Tema Escuro (T)';
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
      btnUserThemeToggle: document.getElementById('btnUserThemeToggle'),
      userMenuThemeIcon: document.getElementById('userMenuThemeIcon'),
      userMenuThemeLabel: document.getElementById('userMenuThemeLabel'),
      btnAppMenu: document.getElementById('btnAppMenu'),
      appMenuDropdown: document.getElementById('appMenuDropdown'),
      btnAppMenuThemeToggle: document.getElementById('btnAppMenuThemeToggle'),
      appMenuThemeIcon: document.getElementById('appMenuThemeIcon'),
      appMenuThemeLabel: document.getElementById('appMenuThemeLabel'),
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
      modalMeasureHeading: document.getElementById('modalMeasureHeading'),
      modalBatchEditBanner: document.getElementById('modalBatchEditBanner'),
      batchEditText: document.getElementById('batchEditText'),
      btnSaveMeasureEditText: document.getElementById('btnSaveMeasureEditText'),
      editNickname: document.getElementById('editNickname'),
      editBeats: document.getElementById('editBeats'),
      btnEditBeatsMinus: document.getElementById('btnEditBeatsMinus'),
      btnEditBeatsPlus: document.getElementById('btnEditBeatsPlus'),
      editBeatUnit: document.getElementById('editBeatUnit'),
      editRepeat: document.getElementById('editRepeat'),
      editRepeatVariable: document.getElementById('editRepeatVariable'),
      btnEditRepeatMinus: document.getElementById('btnEditRepeatMinus'),
      btnEditRepeatPlus: document.getElementById('btnEditRepeatPlus'),
      detailsTempoModulation: document.getElementById('detailsTempoModulation'),
      accordionTempoSummary: document.getElementById('accordionTempoSummary'),
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
      btnSaveMeasureEdit: document.getElementById('btnSaveMeasureEdit'),

      // Modal de Grupos
      modalGroupManage: document.getElementById('modalGroupManage'),
      btnGroupModalClose: document.getElementById('btnGroupModalClose'),
      formCreateGroup: document.getElementById('formCreateGroup'),
      newGroupName: document.getElementById('newGroupName'),
      newGroupStart: document.getElementById('newGroupStart'),
      newGroupEnd: document.getElementById('newGroupEnd'),
      newGroupRepeat: document.getElementById('newGroupRepeat'),
      newGroupRepeatVariable: document.getElementById('newGroupRepeatVariable'),
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
      toolbarMeasureDuration: document.getElementById('toolbarMeasureDuration'),
      toolbarMeasureName: document.getElementById('toolbarMeasureName'),
      btnMoveMeasureLeft: document.getElementById('btnMoveMeasureLeft'),
      btnMoveMeasureRight: document.getElementById('btnMoveMeasureRight'),
      btnGroupSelectedMeasures: document.getElementById('btnGroupSelectedMeasures'),
      btnConfigureSelectedMeasure: document.getElementById('btnConfigureSelectedMeasure'),
      btnCopySelectedMeasure: document.getElementById('btnCopySelectedMeasure'),
      btnCutSelectedMeasure: document.getElementById('btnCutSelectedMeasure'),
      btnPasteSelectedMeasure: document.getElementById('btnPasteSelectedMeasure'),
      btnDuplicateSelectedMeasure: document.getElementById('btnDuplicateSelectedMeasure'),
      btnDeleteSelectedMeasure: document.getElementById('btnDeleteSelectedMeasure'),
      btnCloseToolbar: document.getElementById('btnCloseToolbar'),
      btnToggleWideMode: document.getElementById('btnToggleWideMode'),

      // Menu de Contexto
      runnerContextMenu: document.getElementById('runnerContextMenu'),
      ctxMenuHeader: document.getElementById('ctxMenuHeader'),
      ctxEdit: document.getElementById('ctxEdit'),
      ctxAddMeasureRight: document.getElementById('ctxAddMeasureRight'),
      ctxInsertSectionBefore: document.getElementById('ctxInsertSectionBefore'),
      ctxInsertSectionAfter: document.getElementById('ctxInsertSectionAfter'),
      ctxMoveLeft: document.getElementById('ctxMoveLeft'),
      ctxMoveRight: document.getElementById('ctxMoveRight'),
      ctxCopy: document.getElementById('ctxCopy'),
      ctxCut: document.getElementById('ctxCut'),
      ctxPaste: document.getElementById('ctxPaste'),
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
      btnMeasureOpenBossaModal: document.getElementById('btnMeasureOpenBossaModal'),
      btnMeasureUnlinkModal: document.getElementById('btnMeasureUnlinkModal'),
      btnMeasureRestoreModal: document.getElementById('btnMeasureRestoreModal'),
      btnReturnToPreviousPiece: document.getElementById('btnReturnToPreviousPiece'),
      returnPieceName: document.getElementById('returnPieceName'),
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
      inputSearchInsertBossa: document.getElementById('inputSearchInsertBossa'),
      btnClearSearchInsertBossa: document.getElementById('btnClearSearchInsertBossa'),
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

    // Se o compasso ativo estiver dentro de uma bossa recolhida, destaca o cabeçalho do bloco
    const currentGrp = state.getGroupByMeasureIndex(activeIndex);
    document.querySelectorAll('.bossa-block-header').forEach(header => {
      const gid = header.getAttribute('data-group-id');
      const isHeaderActive = currentGrp && currentGrp.id === gid && currentGrp.isBossaBlock && currentGrp.collapsed;
      header.classList.toggle('active-bossa-playback', Boolean(isHeaderActive));
    });

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
            try { reg.update(); } catch (_) {}
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

  // Formatação detalhada de duração para seleção de compassos (ex: 2.0s, 12.5s, 1m 20.0s)
  formatDurationDetailed(sec) {
    if (isNaN(sec) || sec <= 0) return '0.0s';
    if (sec < 60) {
      return `${sec.toFixed(1)}s`;
    }
    const mins = Math.floor(sec / 60);
    const rem = (sec % 60).toFixed(1);
    const remStr = (sec % 60) < 10 ? `0${rem}` : `${rem}`;
    return `${mins}m ${remStr}s (${sec.toFixed(1)}s)`;
  }

  // Adicionar compasso à direita do compasso selecionado (ou ao final se nenhum selecionado)
  handleAddMeasureAction() {
    const selectedIndices = this.getSelectedMeasureIndicesList();
    if (selectedIndices.length > 0) {
      const targetIdx = Math.max(...selectedIndices);
      const res = state.addMeasureAfter(targetIdx);
      this.renderMeasuresList();
      if (res && typeof res.measureIndex === 'number') {
        this.handleMeasureSelected(res.measureIndex);
      }
      return;
    }

    state.addMeasure(-1);
    this.renderMeasuresList();
    const newIdx = Math.max(0, state.measures.length - 1);
    this.handleMeasureSelected(newIdx);
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

    // Botão de retornar para peça anterior (quando navegou para edição de bossa)
    this.dom.btnReturnToPreviousPiece?.addEventListener('click', () => {
      if (this.previousPieceContext && this.previousPieceContext.id) {
        const prev = this.previousPieceContext;
        this.previousPieceContext = null;
        this.updateReturnToPreviousButton();
        const loaded = state.loadPieceFromLibrary(prev.id);
        if (loaded) {
          this.showToast(`Retornou para '${prev.name}'!`, '↩️');
        } else {
          this.showToast(`Peça anterior '${prev.name}' não encontrada na biblioteca.`, '⚠️');
        }
      }
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
      this.dom.muteIcon.innerHTML = isMuted ? iconSvg('volume-x', { size: 16 }) : iconSvg('volume-2', { size: 16 });
      this.dom.btnMute.classList.toggle('active', !isMuted);
    });

    this.dom.selectSoundType.addEventListener('change', (e) => {
      audio.setSoundType(e.target.value);
      this.preparePieceAudio(true);
    });

    // Adicionar Compasso (à direita do selecionado ou ao final)
    this.dom.btnAddMeasureQuick.addEventListener('click', () => {
      this.handleAddMeasureAction();
    });

    this.dom.btnAddMeasureBottom.addEventListener('click', () => {
      this.handleAddMeasureAction();
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
      this.updateReturnToPreviousButton();
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

    // Inscrição dedicada para alterações no repertório/biblioteca (peças e bossas salvas)
    // Atualiza dropdowns e listas de bossas SEM recriar os compassos da partitura atual nem disparar commit no Firestore
    // Coalescido: várias notificações seguidas geram uma única atualização de UI
    state.subscribeLibrary?.(() => {
      clearTimeout(this._libraryUiTimer);
      this._libraryUiTimer = setTimeout(() => this.refreshLibraryUi(), 120);
    });

    // Atalhos de teclado
    window.addEventListener('keydown', (e) => {
      // 1. Tecla Escape: fechar modais, menus ou seleções
      // ATENÇÃO: Executado MESMO SE O FOCO ESTIVER EM UM <input>, <select> ou <textarea>!
      if (e.key === 'Escape') {
        let closedModal = false;

        const isModalVisible = (elem) => {
          if (!elem) return false;
          return elem.style.display === 'flex' || elem.style.display === 'block' || (elem.style.display !== 'none' && window.getComputedStyle(elem).display !== 'none');
        };

        // Menu de Contexto da Visão Corrida
        if (this.dom.runnerContextMenu && this.dom.runnerContextMenu.style.display !== 'none') {
          this.closeContextMenu();
          closedModal = true;
        }

        // Modal de Configurar Compasso
        if (isModalVisible(this.dom.modalMeasureEdit)) {
          this.closeMeasureModal();
          closedModal = true;
        }

        // Modal de Grupos / Seções
        if (isModalVisible(this.dom.modalGroupManage)) {
          this.closeGroupModal();
          closedModal = true;
        }

        // Modal de Inserir Bossa
        if (isModalVisible(this.dom.modalInsertBossa)) {
          this.closeInsertBossaModal();
          closedModal = true;
        }

        // Modal de Renomear Bossa
        if (isModalVisible(this.dom.modalRenameBossa)) {
          this.closeRenameBossaModal();
          closedModal = true;
        }

        // Modal de Salvar como Bossa / Modelo
        if (isModalVisible(this.dom.modalSaveAsBossa)) {
          this.closeSaveAsBossaModal();
          closedModal = true;
        }

        // Modal de Confirmação Nova Peça
        if (isModalVisible(this.dom.modalConfirmNewPiece)) {
          this.closeConfirmNewModal();
          closedModal = true;
        }

        // Modal de Colaboração / Conexão
        if (isModalVisible(this.dom.modalJoinCollab)) {
          this.closeJoinModal();
          closedModal = true;
        }

        // Modal de Compartilhar Peça
        if (isModalVisible(this.dom.modalSharePiece)) {
          this.closeShareModal();
          closedModal = true;
        }

        // Modal de Histórico de Versões
        if (isModalVisible(this.dom.modalVersionHistory)) {
          this.closeHistoryModal();
          closedModal = true;
        }

        // Modal de Autenticação / Login
        if (isModalVisible(this.dom.modalAuth)) {
          if (typeof this.closeAuthModal === 'function') this.closeAuthModal();
          else this.dom.modalAuth.style.display = 'none';
          closedModal = true;
        }

        // Modal de Acesso Negado
        if (isModalVisible(this.dom.modalAccessDenied)) {
          this.dom.modalAccessDenied.style.display = 'none';
          closedModal = true;
        }

        // Garante fechamento de qualquer outro modal com classe .modal-overlay ativo
        const openOverlays = document.querySelectorAll('.modal-overlay');
        openOverlays.forEach(overlay => {
          if (overlay.style.display !== 'none' && window.getComputedStyle(overlay).display !== 'none') {
            overlay.style.display = 'none';
            closedModal = true;
          }
        });

        // Visão do Gerenciador de Repertório
        if (!closedModal && (this.currentView === 'bossas' || (this.dom.viewBossaManager && this.dom.viewBossaManager.style.display === 'flex'))) {
          this.closeBossaManager(true);
          closedModal = true;
        }

        // Barra de seleção múltipla da Visão Corrida
        if (!closedModal && this.selectedMeasureIndices.size > 0) {
          this.closeMeasureToolbar();
          closedModal = true;
        }

        if (closedModal) {
          e.preventDefault();
          e.stopPropagation();
          // Remove o foco de qualquer campo ativo
          if (document.activeElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
          }
          return;
        }

        // Se nenhum modal estava aberto mas o usuário estava em um input, tira o foco
        if (document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
          e.preventDefault();
          e.stopPropagation();
          document.activeElement.blur();
          return;
        }
      }

      // Se o usuário estiver digitando em um input, textarea ou select, ignora os demais atalhos
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

        // Atalho Ctrl+C / Cmd+C: Copiar compasso(s) selecionado(s)
        if (key === 'c') {
          const sel = window.getSelection ? window.getSelection().toString() : '';
          if (sel && sel.trim().length > 0) return; // Permite cópia nativa de texto selecionado
          const isModalOpen = Array.from(document.querySelectorAll('.modal-overlay')).some(m => m.style.display && m.style.display !== 'none');
          if (isModalOpen) return;
          e.preventDefault();
          this.copySelectedMeasures();
          return;
        }

        // Atalho Ctrl+X / Cmd+X: Recortar compasso(s) selecionado(s)
        if (key === 'x') {
          const sel = window.getSelection ? window.getSelection().toString() : '';
          if (sel && sel.trim().length > 0) return; // Permite recorte nativo de texto selecionado
          const isModalOpen = Array.from(document.querySelectorAll('.modal-overlay')).some(m => m.style.display && m.style.display !== 'none');
          if (isModalOpen) return;
          e.preventDefault();
          this.cutSelectedMeasures();
          return;
        }

        // Atalho Ctrl+V / Cmd+V: Colar compasso(s)
        if (key === 'v') {
          const isModalOpen = Array.from(document.querySelectorAll('.modal-overlay')).some(m => m.style.display && m.style.display !== 'none');
          if (isModalOpen) return;
          e.preventDefault();
          this.pasteMeasures();
          return;
        }

        // Deixar qualquer outro atalho com Ctrl/Cmd seguir pro navegador (Ctrl+R, Ctrl+Shift+R, etc.)
        return;
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
          this.toggleTheme?.();
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
      const indices = Array.from(this.selectedMeasureIndices).sort((a, b) => a - b);
      const minIdx = indices[0];
      const targetM = state.measures[minIdx];
      const targetItemIdx = targetM ? targetM._itemIndex : 0;
      const secCount = state.groups.filter(g => !g.isBossaBlock).length + 1;
      state.addSection(targetItemIdx, { name: `Seção ${secCount}` });
      this.renderMeasuresList();
      this.showToast(`Seção criada a partir do compasso c. ${minIdx + 1}!`, '🏷️');
    });

    this.dom.btnConfigureSelectedMeasure?.addEventListener('click', () => {
      const indices = this.getSelectedMeasureIndicesList();
      const idx = indices.length > 0 ? indices[0] : this.renderer?.selectedMeasureIndex;
      if (idx !== null && idx !== undefined) {
        this.openMeasureModal(idx);
      }
    });

    this.dom.btnCopySelectedMeasure?.addEventListener('click', () => {
      this.copySelectedMeasures();
    });

    this.dom.btnCutSelectedMeasure?.addEventListener('click', () => {
      this.cutSelectedMeasures();
    });

    this.dom.btnPasteSelectedMeasure?.addEventListener('click', () => {
      this.pasteMeasures();
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

    this.dom.ctxAddMeasureRight?.addEventListener('click', () => {
      if (this._contextMeasureIdx !== undefined) {
        const res = state.addMeasureAfter(this._contextMeasureIdx);
        this.renderMeasuresList();
        if (res && typeof res.measureIndex === 'number') {
          this.handleMeasureSelected(res.measureIndex);
        }
      }
      this.closeContextMenu();
    });

    this.dom.ctxInsertSectionBefore?.addEventListener('click', () => {
      if (this._contextMeasureIdx !== undefined) {
        const m = state.measures[this._contextMeasureIdx];
        const itemIdx = m ? m._itemIndex : 0;
        const secCount = state.groups.filter(g => !g.isBossaBlock).length + 1;
        state.addSection(itemIdx, { name: `Seção ${secCount}` });
        this.renderMeasuresList();
        this.showToast(`Nova seção inserida antes do compasso c. ${this._contextMeasureIdx + 1}!`, '🏷️');
      }
      this.closeContextMenu();
    });

    this.dom.ctxInsertSectionAfter?.addEventListener('click', () => {
      if (this._contextMeasureIdx !== undefined) {
        const m = state.measures[this._contextMeasureIdx];
        const itemIdx = m ? m._itemIndex + 1 : state.items.length;
        const secCount = state.groups.filter(g => !g.isBossaBlock).length + 1;
        state.addSection(itemIdx, { name: `Seção ${secCount}` });
        this.renderMeasuresList();
        this.showToast(`Nova seção inserida após o compasso c. ${this._contextMeasureIdx + 1}!`, '🏷️');
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

    this.dom.ctxCopy?.addEventListener('click', () => {
      if (this._contextMeasureIdx !== undefined) {
        if (!this.selectedMeasureIndices.has(this._contextMeasureIdx)) {
          this.selectedMeasureIndices.clear();
          this.selectedMeasureIndices.add(this._contextMeasureIdx);
          this.lastSelectedMeasureIdx = this._contextMeasureIdx;
          this.syncSelectionUI();
        }
        this.copySelectedMeasures();
      }
      this.closeContextMenu();
    });

    this.dom.ctxCut?.addEventListener('click', () => {
      if (this._contextMeasureIdx !== undefined) {
        if (!this.selectedMeasureIndices.has(this._contextMeasureIdx)) {
          this.selectedMeasureIndices.clear();
          this.selectedMeasureIndices.add(this._contextMeasureIdx);
          this.lastSelectedMeasureIdx = this._contextMeasureIdx;
          this.syncSelectionUI();
        }
        this.cutSelectedMeasures();
      }
      this.closeContextMenu();
    });

    this.dom.ctxPaste?.addEventListener('click', () => {
      if (this._contextMeasureIdx !== undefined) {
        this.pasteMeasures(this._contextMeasureIdx + 1);
      } else {
        this.pasteMeasures();
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

    // Cálculo da duração total dos compassos selecionados
    let totalSelectedDurationSec = 0;
    let singlePassDurationSec = 0;

    if (state.measureTimings && state.measureTimings.length > 0) {
      state.measureTimings.forEach(t => {
        if (this.selectedMeasureIndices.has(t.measureIndex)) {
          totalSelectedDurationSec += t.duration;
        }
      });
    }

    indices.forEach(idx => {
      const measureObj = state.measures[idx];
      if (!measureObj) return;
      let effBpm = state.baseBpm;
      if (measureObj.tempoMode === "ratio") {
        effBpm = state.baseBpm * ((measureObj.ratioNum || 1) / (measureObj.ratioDen || 1));
      } else {
        effBpm = measureObj.customBpm || state.baseBpm;
      }
      const beatDur = 60 / effBpm;
      const mRep = measureObj.repeat || 1;
      singlePassDurationSec += (measureObj.beats || 4) * beatDur * mRep;
    });

    if (totalSelectedDurationSec <= 0) {
      totalSelectedDurationSec = singlePassDurationSec;
    }

    const durFormatted = this.formatDurationDetailed(totalSelectedDurationSec);
    const hasRepeatsDiff = Math.abs(totalSelectedDurationSec - singlePassDurationSec) > 0.05;

    if (this.dom.toolbarMeasureDuration) {
      this.dom.toolbarMeasureDuration.textContent = `⏱️ ${durFormatted}`;
      this.dom.toolbarMeasureDuration.title = hasRepeatsDiff
        ? `Tempo total na execução: ${durFormatted} (tempo de 1 ciclo: ${this.formatDurationDetailed(singlePassDurationSec)})`
        : `Duração total da seleção: ${durFormatted}`;
      this.dom.toolbarMeasureDuration.style.display = 'inline-flex';
    }

    if (this.dom.measureCountBadge) {
      this.dom.measureCountBadge.innerHTML = `<span class="selection-time-highlight">⏱️ ${durFormatted}</span> (${count} sel.)`;
      this.dom.measureCountBadge.classList.add('has-selection');
    }

    if (this.renderer) {
      this.renderer.setSelectedMeasures(indices);
      this.renderer.render(this.playbackTime);
    }

    if (this.dom.runnerMeasureToolbar) {
      this.dom.runnerMeasureToolbar.style.display = 'flex';

      const hasClipboard = (this.clipboardMeasures && this.clipboardMeasures.length > 0) ||
        (() => {
          try {
            const raw = localStorage.getItem('sergio_clipboard_measures');
            return raw && JSON.parse(raw).length > 0;
          } catch (_) { return false; }
        })();

      if (this.dom.btnPasteSelectedMeasure) {
        this.dom.btnPasteSelectedMeasure.textContent = '📥 Colar';
        this.dom.btnPasteSelectedMeasure.style.display = 'inline-flex';
        this.dom.btnPasteSelectedMeasure.disabled = !hasClipboard;
      }

      if (count > 1) {
        const minIdx = indices[0] + 1;
        const maxIdx = indices[indices.length - 1] + 1;
        this.dom.toolbarMeasureBadge.textContent = `${count} compassos (${minIdx} a ${maxIdx}) • ${durFormatted}`;
        this.dom.toolbarMeasureName.textContent = '(Shift para estender seleção)';

        if (this.dom.btnMoveMeasureLeft) this.dom.btnMoveMeasureLeft.style.display = 'none';
        if (this.dom.btnMoveMeasureRight) this.dom.btnMoveMeasureRight.style.display = 'none';
        if (this.dom.btnConfigureSelectedMeasure) this.dom.btnConfigureSelectedMeasure.style.display = 'none';
        if (this.dom.btnGroupSelectedMeasures) this.dom.btnGroupSelectedMeasures.style.display = 'inline-flex';
        if (this.dom.btnCopySelectedMeasure) {
          this.dom.btnCopySelectedMeasure.textContent = `📋 Copiar (${count})`;
          this.dom.btnCopySelectedMeasure.style.display = 'inline-flex';
        }
        if (this.dom.btnCutSelectedMeasure) {
          this.dom.btnCutSelectedMeasure.textContent = `✂ Recortar (${count})`;
          this.dom.btnCutSelectedMeasure.style.display = 'inline-flex';
        }
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
        this.dom.toolbarMeasureBadge.textContent = `c. ${primaryIdx + 1} • ${durFormatted}`;
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
        if (this.dom.btnCopySelectedMeasure) {
          this.dom.btnCopySelectedMeasure.textContent = '📋 Copiar';
          this.dom.btnCopySelectedMeasure.style.display = 'inline-flex';
        }
        if (this.dom.btnCutSelectedMeasure) {
          this.dom.btnCutSelectedMeasure.textContent = '✂ Recortar';
          this.dom.btnCutSelectedMeasure.style.display = 'inline-flex';
        }
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
    const allCards = document.querySelectorAll('.measure-card[data-index]');
    allCards.forEach(c => {
      const cIdx = parseInt(c.dataset.index, 10);
      if (!isNaN(cIdx)) {
        c.classList.toggle('is-selected', this.selectedMeasureIndices.has(cIdx));
      }
    });

    const targetCard = document.querySelector(`.measure-card[data-index="${primaryIdx}"]`);
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

  getSelectedMeasureIndicesList() {
    if (this.selectedMeasureIndices && this.selectedMeasureIndices.size > 0) {
      return Array.from(this.selectedMeasureIndices)
        .filter(idx => typeof idx === 'number' && idx >= 0 && idx < state.measures.length)
        .sort((a, b) => a - b);
    }
    if (this.renderer?.selectedMeasureIndex !== null && this.renderer?.selectedMeasureIndex !== undefined) {
      const idx = this.renderer.selectedMeasureIndex;
      if (idx >= 0 && idx < state.measures.length) {
        return [idx];
      }
    }
    if (this._contextMeasureIdx !== null && this._contextMeasureIdx !== undefined) {
      const idx = this._contextMeasureIdx;
      if (idx >= 0 && idx < state.measures.length) {
        return [idx];
      }
    }
    return [];
  }

  copySelectedMeasures() {
    const indices = this.getSelectedMeasureIndicesList();
    if (indices.length === 0) {
      this.showToast('Selecione ao menos um compasso para copiar', 'ℹ️');
      return;
    }

    const measuresToCopy = indices.map(idx => {
      const m = state.measures[idx];
      return {
        nickname: m.nickname || "",
        beats: m.beats,
        beatUnit: m.beatUnit,
        tempoMode: m.tempoMode,
        ratioNum: m.ratioNum,
        ratioDen: m.ratioDen,
        customBpm: m.customBpm,
        color: m.color,
        repeat: m.repeat || 1
      };
    });

    this.clipboardMeasures = measuresToCopy;
    try {
      localStorage.setItem('sergio_clipboard_measures', JSON.stringify(measuresToCopy));
    } catch (_) {}

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(JSON.stringify({
          type: 'sergio-simulator-measures',
          version: 1,
          measures: measuresToCopy
        })).catch(() => {});
      }
    } catch (_) {}

    const count = measuresToCopy.length;
    this.syncSelectionUI();
    this.showToast(`${count} compasso${count > 1 ? 's' : ''} copiado${count > 1 ? 's' : ''}! (Ctrl+V para colar)`, '📋');
  }

  cutSelectedMeasures() {
    const indices = this.getSelectedMeasureIndicesList();
    if (indices.length === 0) {
      this.showToast('Selecione ao menos um compasso para recortar', 'ℹ️');
      return;
    }

    const measuresToCopy = indices.map(idx => {
      const m = state.measures[idx];
      return {
        nickname: m.nickname || "",
        beats: m.beats,
        beatUnit: m.beatUnit,
        tempoMode: m.tempoMode,
        ratioNum: m.ratioNum,
        ratioDen: m.ratioDen,
        customBpm: m.customBpm,
        color: m.color,
        repeat: m.repeat || 1
      };
    });

    this.clipboardMeasures = measuresToCopy;
    try {
      localStorage.setItem('sergio_clipboard_measures', JSON.stringify(measuresToCopy));
    } catch (_) {}

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(JSON.stringify({
          type: 'sergio-simulator-measures',
          version: 1,
          measures: measuresToCopy
        })).catch(() => {});
      }
    } catch (_) {}

    const count = indices.length;
    const firstDeletedIdx = indices[0];
    state.removeMeasures(indices);

    if (state.measures.length > 0) {
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

    this.showToast(`${count} compasso${count > 1 ? 's' : ''} recortado${count > 1 ? 's' : ''}!`, '✂️');
  }

  pasteMeasures(explicitTargetIndex = null) {
    let list = this.clipboardMeasures;
    if (!list || list.length === 0) {
      try {
        const raw = localStorage.getItem('sergio_clipboard_measures');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            list = parsed;
            this.clipboardMeasures = parsed;
          }
        }
      } catch (_) {}
    }

    if (!list || list.length === 0) {
      this.showToast('Área de transferência vazia. Copie compassos com Ctrl+C primeiro.', 'ℹ️');
      return;
    }

    let targetIndex = explicitTargetIndex;
    if (targetIndex === null || targetIndex === undefined) {
      if (this.selectedMeasureIndices && this.selectedMeasureIndices.size > 0) {
        const maxIdx = Math.max(...this.selectedMeasureIndices);
        targetIndex = maxIdx + 1;
      } else if (this.renderer?.selectedMeasureIndex !== null && this.renderer?.selectedMeasureIndex !== undefined) {
        targetIndex = this.renderer.selectedMeasureIndex + 1;
      } else if (this._contextMeasureIdx !== null && this._contextMeasureIdx !== undefined) {
        targetIndex = this._contextMeasureIdx + 1;
      } else {
        targetIndex = state.measures.length;
      }
    }

    const res = state.insertMeasures(targetIndex, list);
    if (res) {
      this.selectedMeasureIndices.clear();
      for (let i = res.start; i <= res.end; i++) {
        this.selectedMeasureIndices.add(i);
      }
      this.lastSelectedMeasureIdx = res.end;
      this.syncSelectionUI();

      const t = state.getFirstTimingForMeasure(res.start);
      if (t) this.seekTo(t.startTime);

      const count = list.length;
      this.showToast(`${count} compasso${count > 1 ? 's' : ''} colado${count > 1 ? 's' : ''}!`, '📋');
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
    if (this.dom.toolbarMeasureDuration) {
      this.dom.toolbarMeasureDuration.style.display = 'none';
    }
    if (this.dom.measureCountBadge) {
      this.dom.measureCountBadge.classList.remove('has-selection');
      const uniqueCount = state.measures.length;
      const totalCount = state.getTotalMeasureCount();
      this.dom.measureCountBadge.textContent = (totalCount !== uniqueCount)
        ? `${totalCount} compassos no total (${uniqueCount} ${uniqueCount === 1 ? 'cartão' : 'cartões'})`
        : `${uniqueCount} ${uniqueCount === 1 ? 'compasso' : 'compassos'}`;
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

    if (this.dom.ctxMoveLeft) this.dom.ctxMoveLeft.disabled = (idx === 0);
    if (this.dom.ctxMoveRight) this.dom.ctxMoveRight.disabled = (idx === state.measures.length - 1);

    const hasClipboard = (this.clipboardMeasures && this.clipboardMeasures.length > 0) ||
      (() => {
        try {
          const raw = localStorage.getItem('sergio_clipboard_measures');
          return raw && JSON.parse(raw).length > 0;
        } catch (_) { return false; }
      })();

    if (this.dom.ctxPaste) {
      this.dom.ctxPaste.disabled = !hasClipboard;
    }

    menu.style.display = 'flex';
    menu.style.left = `${Math.min(window.innerWidth - 220, clientX)}px`;
    menu.style.top = `${Math.min(window.innerHeight - 320, clientY)}px`;
  }

  closeContextMenu() {
    if (this.dom.runnerContextMenu) {
      this.dom.runnerContextMenu.style.display = 'none';
    }
  }

  // =========================================================================
  // GRADE DE COMPASSOS INFERIOR
  // =========================================================================

  createSectionHeaderElement(sec, itemIdx) {
    const groupsList = state.groups || state.computedGroups || [];
    const grp = groupsList.find(g => g.id === sec.id);
    const hasMeasures = Boolean(grp && typeof grp.startMeasure === 'number' && typeof grp.endMeasure === 'number' && grp.startMeasure >= 0 && grp.startMeasure <= grp.endMeasure);
    const count = hasMeasures ? (grp.endMeasure - grp.startMeasure + 1) : 0;
    const secColor = sec.color || '#3b82f6';

    let secDurationSec = 0;
    if (grp && Array.isArray(state.measureTimings)) {
      const timings = state.measureTimings.filter(t => t.groupId === sec.id);
      if (timings.length > 0) {
        timings.forEach(t => secDurationSec += t.duration);
      } else if (hasMeasures) {
        for (let mi = grp.startMeasure; mi <= grp.endMeasure; mi++) {
          const mTims = state.measureTimings.filter(t => t.measureIndex === mi);
          mTims.forEach(t => secDurationSec += t.duration);
        }
      }
    }
    const secDurationStr = this.formatFriendlyDuration(secDurationSec);
    const repeatTagHtml = (sec.repeat || 1) > 1
      ? `<span class="measure-card-repeat-tag" title="Esta seção se repete ${sec.repeat} vezes na peça">×${sec.repeat}</span>`
      : '';

    const el = document.createElement('div');
    el.className = 'section-block-header';
    el.setAttribute('draggable', 'true');
    el.setAttribute('data-section-id', sec.id);
    el.setAttribute('data-item-index', itemIdx);
    el.style.setProperty('--section-color', secColor);

    el.innerHTML = `
      <div class="section-header-left">
        <span class="section-drag-handle" title="Arraste para reposicionar esta seção inteira na peça">⠿</span>
        <label class="section-color-label" title="Alterar cor da seção">
          <input type="color" class="input-section-color" value="${secColor}">
          <span class="section-color-pip" style="background:${secColor}"></span>
        </label>
        <span class="section-type-badge" style="background:${secColor}25; color:${secColor}">SEÇÃO</span>
        <input type="text" class="input-section-name" value="${sec.name || 'Nova Seção'}" placeholder="Nome da Seção (ex: Intro, Refrão...)" title="Clique para editar o nome da seção">
        <span class="section-header-range">${hasMeasures ? `c. ${grp.startMeasure + 1} a ${grp.endMeasure + 1} (${count} ${count === 1 ? 'comp.' : 'comp.'})` : '(seção vazia)'}</span>
        ${secDurationSec > 0 ? `<span class="section-header-time" title="Tempo total desta seção na peça: ${secDurationStr}">${iconSvg('clock', { size: 13 })} ${secDurationStr}</span>` : ''}
        ${repeatTagHtml}
      </div>
      <div class="section-header-actions">
        <div class="section-repeat-stepper-wrap" title="Número de vezes que esta seção se repete na peça">
          <span class="card-stepper-label">Repetir:</span>
          <div class="repeat-stepper">
            <button type="button" class="btn-repeat-step btn-sec-rep-minus" title="Diminuir repetições">-</button>
            <input type="number" class="input-card-repeat input-sec-repeat" min="1" max="999" value="${sec.repeat || 1}" title="Número de vezes que esta seção se repete">
            <button type="button" class="btn-repeat-step btn-sec-rep-plus" title="Aumentar repetições">+</button>
          </div>
        </div>
        <button type="button" class="btn-sec-action btn-sec-add-measure" title="Adicionar compasso nesta seção">
          ${iconSvg('plus', { size: 13 })} <span>Compasso</span>
        </button>
        <button type="button" class="btn-sec-action btn-sec-move-left" title="Mover seção para trás (←)" ${itemIdx === 0 ? 'disabled style="opacity:0.35;pointer-events:none"' : ''}>
          ${iconSvg('arrow-left', { size: 13 })}
        </button>
        <button type="button" class="btn-sec-action btn-sec-move-right" title="Mover seção para frente (→)" ${itemIdx >= state.items.length - 1 ? 'disabled style="opacity:0.35;pointer-events:none"' : ''}>
          ${iconSvg('arrow-right', { size: 13 })}
        </button>
        <button type="button" class="btn-sec-action danger btn-sec-delete" title="Excluir divisor de seção (mantém os compassos)">
          ${iconSvg('trash-2', { size: 13 })}
        </button>
      </div>
    `;

    // Edição do nome inline
    const inputName = el.querySelector('.input-section-name');
    if (inputName) {
      inputName.addEventListener('click', e => e.stopPropagation());
      inputName.addEventListener('mousedown', e => e.stopPropagation());
      const commitName = () => {
        const val = inputName.value.trim() || 'Seção';
        if (val !== sec.name) {
          state.updateSection(sec.id, { name: val });
        }
      };
      inputName.addEventListener('change', commitName);
      inputName.addEventListener('blur', commitName);
      inputName.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') inputName.blur();
      });
    }

    // Cor da seção
    const inputColor = el.querySelector('.input-section-color');
    if (inputColor) {
      inputColor.addEventListener('click', e => e.stopPropagation());
      inputColor.addEventListener('input', (e) => {
        state.updateSection(sec.id, { color: e.target.value });
        const pip = el.querySelector('.section-color-pip');
        if (pip) pip.style.background = e.target.value;
        el.style.setProperty('--section-color', e.target.value);
      });
    }

    // Repetições da seção
    const inputRep = el.querySelector('.input-sec-repeat');
    const updateRep = (val) => {
      const parsed = Math.max(1, Math.min(999, parseInt(val, 10) || 1));
      if (parsed !== sec.repeat) {
        state.updateSection(sec.id, { repeat: parsed });
        this.renderMeasuresList();
      }
    };
    if (inputRep) {
      inputRep.addEventListener('click', e => e.stopPropagation());
      inputRep.addEventListener('mousedown', e => e.stopPropagation());
      inputRep.addEventListener('change', e => { e.stopPropagation(); updateRep(e.target.value); });
      inputRep.addEventListener('blur', e => { e.stopPropagation(); updateRep(e.target.value); });
    }
    el.querySelector('.btn-sec-rep-minus')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const cur = parseInt(inputRep.value, 10) || 1;
      if (cur > 1) updateRep(cur - 1);
    });
    el.querySelector('.btn-sec-rep-plus')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const cur = parseInt(inputRep.value, 10) || 1;
      if (cur < 999) updateRep(cur + 1);
    });

    // Adicionar compasso dentro desta seção
    el.querySelector('.btn-sec-add-measure')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (hasMeasures) {
        const res = state.addMeasureAfter(grp.endMeasure);
        this.renderMeasuresList();
        if (res?.measureIndex !== undefined) this.handleMeasureSelected(res.measureIndex);
      } else {
        state.addMeasure(itemIdx + 1);
        this.renderMeasuresList();
        const newM = state.measures.findIndex(m => m._itemIndex === itemIdx + 1);
        if (newM !== -1) this.handleMeasureSelected(newM);
      }
    });

    // Mover seção
    el.querySelector('.btn-sec-move-left')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.moveSectionLeft(sec.id)) {
        this.renderMeasuresList();
        this.showToast(`Seção '${sec.name}' movida para trás!`, '🏷️');
      }
    });

    el.querySelector('.btn-sec-move-right')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.moveSectionRight(sec.id)) {
        this.renderMeasuresList();
        this.showToast(`Seção '${sec.name}' movida para frente!`, '🏷️');
      }
    });

    // Excluir seção
    el.querySelector('.btn-sec-delete')?.addEventListener('click', (e) => {
      e.stopPropagation();
      state.removeSection(sec.id);
      this.renderMeasuresList();
      this.showToast(`Divisor de seção '${sec.name}' removido.`, '✕');
    });

    // Drag & Drop no divisor de seção
    el.addEventListener('dragstart', (e) => {
      if (e.target.closest('input, button, select, textarea')) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData('text/item-index', itemIdx);
      e.dataTransfer.setData('text/plain', `item:${itemIdx}`);
      el.classList.add('is-drag-source');
    });

    el.addEventListener('dragend', () => {
      el.classList.remove('is-drag-source');
      document.querySelectorAll('.is-drag-target').forEach(c => c.classList.remove('is-drag-target'));
    });

    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      el.classList.add('is-drag-target');
    });

    el.addEventListener('dragleave', () => {
      el.classList.remove('is-drag-target');
    });

    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('is-drag-target');
      const rawItem = e.dataTransfer.getData('text/item-index') || (e.dataTransfer.getData('text/plain') || '').replace('item:', '');
      const fromIdx = parseInt(rawItem, 10);
      if (!isNaN(fromIdx) && fromIdx !== itemIdx) {
        state.moveItem(fromIdx, itemIdx);
        this.renderMeasuresList();
      }
    });

    return el;
  }

  createMeasureCardElement(m, idx, parentBossa = null) {
    const timing = state.getFirstTimingForMeasure(idx) || { effectiveBpm: state.baseBpm };
    const grp = state.getGroupByMeasureIndex(idx);

    const card = document.createElement('div');
    card.className = 'measure-card';
    if ((m.repeat || 1) > 1) {
      card.classList.add('has-repeats');
    }
    if (grp && (grp.repeat || 1) > 1) {
      card.classList.add('has-group-repeats');
    }
    if (this.renderer?.selectedMeasureIndex === idx) {
      card.classList.add('is-selected');
    }
    if (parentBossa || (grp && grp.isBossaBlock)) {
      card.classList.add('is-bossa-member');
      const bColor = parentBossa?.color || grp?.color || '#8b5cf6';
      card.style.setProperty('--card-bossa-color', bColor);
    }
    card.dataset.index = idx;
    card.draggable = true;

    if (grp && !parentBossa) {
      card.innerHTML += `<div class="measure-card-group-strip" style="background:${grp.color}"></div>`;
    }

    let groupTagHtml = '';
    if (grp && !parentBossa && !grp.isBossaBlock) {
      let grpRepMultiplier = '';
      if (grp.repeatVariable) {
        grpRepMultiplier = ` <span class="group-repeat-multiplier is-variable" title="Repetições do grupo vinculadas à variável '${grp.repeatVariable}'">×[${grp.repeatVariable}]</span>`;
      } else if ((grp.repeat || 1) > 1) {
        grpRepMultiplier = ` <span class="group-repeat-multiplier" title="Seção repetida ${grp.repeat} vezes">×${grp.repeat}</span>`;
      }
      groupTagHtml = `<span class="measure-card-group-tag" style="background:${grp.color}33; color:${grp.color}">${grp.name}${grpRepMultiplier}</span>`;
    }

    let bossaPillHtml = '';
    if (!parentBossa && (m.sourcePieceId || (grp && grp.isBossaBlock))) {
      const bName = m.sourcePieceName || grp?.sourcePieceName || grp?.name || 'Bossa';
      const cleanBName = bName.replace(/^[🔗📦✏️🔓\s]+/, '').trim();
      const bId = m.sourcePieceId || grp?.sourcePieceId || '';
      const bossaRepMultiplier = (grp && (grp.repeat || 1) > 1) ? ` <span class="bossa-repeat-multiplier" title="Bossa repetida ${grp.repeat} vezes">×${grp.repeat}</span>` : '';
      if (m.isLinked || (!m.sourcePieceId && grp?.isLinked)) {
        bossaPillHtml = `<span class="measure-bossa-pill linked" data-bossa-id="${bId}" data-bossa-name="${cleanBName}" draggable="true" title="Bossa vinculada à '${cleanBName}'. Clique para abrir a página da bossa!">${iconSvg('link', { size: 12 })} ${cleanBName}${bossaRepMultiplier} <span class="pill-open-arrow">${iconSvg('external-link', { size: 10 })}</span></span>`;
      } else if (m.isLocallyModified) {
        bossaPillHtml = `<span class="measure-bossa-pill modified" data-bossa-id="${bId}" data-bossa-name="${cleanBName}" draggable="true" title="Modificado localmente (baseado em '${cleanBName}'). Clique para abrir a original!">${iconSvg('edit-2', { size: 12 })} Local (${cleanBName})${bossaRepMultiplier} <span class="pill-open-arrow">${iconSvg('external-link', { size: 10 })}</span></span>`;
      } else {
        bossaPillHtml = `<span class="measure-bossa-pill unlinked" data-bossa-id="${bId}" data-bossa-name="${cleanBName}" draggable="true" title="Bossa '${cleanBName}'. Clique para abrir a página da bossa!">${iconSvg('unlock', { size: 12 })} ${cleanBName}${bossaRepMultiplier} <span class="pill-open-arrow">${iconSvg('external-link', { size: 10 })}</span></span>`;
      }
    }

    let tempoDesc = '';
    if (m.tempoMode === 'ratio') {
      tempoDesc = (m.ratioNum === 1 && m.ratioDen === 1) 
        ? `${Math.round(timing.effectiveBpm)} BPM (1/1)`
        : `${Math.round(timing.effectiveBpm)} BPM (${m.ratioNum}/${m.ratioDen})`;
    } else {
      tempoDesc = `${Math.round(timing.effectiveBpm)} BPM (Fixo)`;
    }

    const prevM = idx > 0 ? state.measures[idx - 1] : null;
    const prevTiming = idx > 0 ? state.getFirstTimingForMeasure(idx - 1) : null;
    const isBpmDiff = prevTiming ? Math.abs((timing.effectiveBpm || state.baseBpm) - (prevTiming.effectiveBpm || state.baseBpm)) > 0.05 : false;
    const isRatioDiff = m.tempoMode === 'ratio' && prevM?.tempoMode === 'ratio' && (m.ratioNum !== prevM.ratioNum || m.ratioDen !== prevM.ratioDen);
    const isModeDiff = prevM ? (m.tempoMode !== prevM.tempoMode) : false;
    const isTempoChange = idx > 0 && (isBpmDiff || isRatioDiff || isModeDiff);
    const showBpm = idx === 0 || isTempoChange;

    let repeatTagHtml = '';
    if (m.repeatVariable) {
      const activeVarVal = (parentBossa && parentBossa.variableValues && parentBossa.variableValues[m.repeatVariable] !== undefined)
        ? parentBossa.variableValues[m.repeatVariable]
        : null;
      const titleHint = activeVarVal !== null
        ? `Repetições vinculadas à variável '${m.repeatVariable}' (valor atual: ${activeVarVal})`
        : `Repetições vinculadas à variável '${m.repeatVariable}'`;
      repeatTagHtml = `<span class="measure-card-repeat-tag is-variable" title="${titleHint}">×[${m.repeatVariable}]</span>`;
    } else if ((m.repeat || 1) > 1) {
      repeatTagHtml = `<span class="measure-card-repeat-tag" title="Este compasso se repete continuamente ${m.repeat} vezes">×${m.repeat}</span>`;
    }

    card.style.setProperty('--card-measure-color', m.color || '#ff334b');

    const hasNickname = !!(m.nickname && m.nickname.trim());
    const headerIndexHtml = hasNickname 
      ? `<div class="card-idx-wrap"><span class="measure-card-idx" style="color:${m.color || '#ff334b'}">c. ${idx + 1}</span>${repeatTagHtml}</div>` 
      : `<div class="card-idx-wrap"><span class="measure-card-idx" style="color:${m.color || '#ff334b'};opacity:0.65">c. ${idx + 1}</span>${repeatTagHtml}</div>`;

    const escapedNickname = m.nickname ? m.nickname.replace(/"/g, '&quot;') : '';
    const titleHtml = `
      <div class="measure-card-title-wrap">
        <input 
          type="text" 
          class="measure-card-nickname ${!hasNickname ? 'is-unnamed' : ''}" 
          value="${escapedNickname}" 
          placeholder="c. ${idx + 1}" 
          title="Clique para editar o nome do compasso" 
          aria-label="Nome do compasso ${idx + 1}" 
          maxlength="60" 
          autocomplete="off" 
          spellcheck="false" 
        />
      </div>
    `;

    const tempoHtml = showBpm
      ? `<span class="measure-card-tempo ${isTempoChange ? 'is-tempo-change' : ''}" title="${idx === 0 ? 'Andamento inicial' : 'Mudança de andamento'}: ${tempoDesc}">${tempoDesc}</span>`
      : '';

    card.innerHTML += `
      <div class="measure-card-header">
        ${headerIndexHtml}
        <div class="measure-card-tags">
          ${bossaPillHtml}
          ${groupTagHtml}
        </div>
      </div>

      <!-- APELIDO DO COMPASSO OU NÚMERO C. X (EDITÁVEL INLINE) -->
      ${titleHtml}

      <div class="measure-card-details">
        <span class="measure-card-meter" title="${m.beats}T • Andamento: ${tempoDesc}">${m.beats}T</span>
        ${tempoHtml}
      </div>

      <!-- CONTROLES RÁPIDOS DE TEMPOS E REPETIÇÕES -->
      <div class="measure-card-steppers">
        <!-- TEMPOS -->
        <div class="measure-card-stepper-row">
          <span class="card-stepper-label">Tempos:</span>
          <div class="repeat-stepper">
            <button type="button" class="btn-repeat-step btn-beats-minus" title="Diminuir tempos (mínimo 1)">-</button>
            <input type="number" class="input-card-beats" min="1" max="32" value="${m.beats || 4}" title="Quantidade de tempos deste compasso (1 a 32)">
            <button type="button" class="btn-repeat-step btn-beats-plus" title="Aumentar tempos (máximo 32)">+</button>
          </div>
        </div>

        <!-- REPETIÇÕES -->
        <div class="measure-card-stepper-row">
          <span class="card-stepper-label">Repetir:</span>
          <div class="repeat-stepper">
            <button type="button" class="btn-repeat-step btn-repeat-minus" title="Diminuir repetições">-</button>
            <input type="number" class="input-card-repeat" min="1" max="999" value="${m.repeat || 1}" title="Número de vezes que este compasso se repete">
            <button type="button" class="btn-repeat-step btn-repeat-plus" title="Aumentar repetições">+</button>
          </div>
        </div>
      </div>

      <div class="measure-card-actions">
        <div class="card-actions-secondary">
          <button type="button" class="btn-card-icon btn-card-add-right" title="Adicionar Compasso à Direita">${iconSvg('plus', { size: 14 })}</button>
          <button type="button" class="btn-card-icon btn-card-add-section-right" title="Inserir Seção após este compasso">${iconSvg('folder-plus', { size: 13 })}</button>
          <button type="button" class="btn-card-icon btn-card-move-left" title="Mover Compasso para Trás (←)" ${idx === 0 ? 'disabled style="opacity:0.3;pointer-events:none"' : ''}>${iconSvg('chevron-left', { size: 14 })}</button>
          <button type="button" class="btn-card-icon btn-card-move-right" title="Mover Compasso para Frente (→)" ${idx === state.measures.length - 1 ? 'disabled style="opacity:0.3;pointer-events:none"' : ''}>${iconSvg('chevron-right', { size: 14 })}</button>
          <button type="button" class="btn-card-icon btn-card-dup" title="Duplicar Compasso">${iconSvg('copy', { size: 13 })}</button>
          ${m.sourcePieceId && m.isLinked ? `<button type="button" class="btn-card-icon btn-card-unlink-m" title="Desvincular compasso para edição local">${iconSvg('unlock', { size: 13 })}</button>` : ''}
          ${m.sourcePieceId && m.isLocallyModified ? `<button type="button" class="btn-card-icon btn-card-restore-m" title="Restaurar compasso da versão original da bossa">${iconSvg('rotate-ccw', { size: 13 })}</button>` : ''}
          <button type="button" class="btn-card-icon btn-card-del" title="Excluir Compasso">${iconSvg('trash-2', { size: 13 })}</button>
        </div>
        <button type="button" class="btn-card-edit" title="Configurar compasso c. ${idx + 1} (métrica, andamento, apelido)">
          <span class="btn-card-edit-icon" aria-hidden="true">${iconSvg('sliders', { size: 13 })}</span>
          <span class="btn-card-edit-text">Configurar</span>
        </button>
      </div>
    `;

    // Nickname inline editing
    const inputName = card.querySelector('.measure-card-nickname');
    if (inputName) {
      inputName.addEventListener('click', (e) => {
        e.stopPropagation();
        this.handleMeasureSelected(idx);
      });
      inputName.addEventListener('dblclick', (e) => e.stopPropagation());
      inputName.addEventListener('focus', () => {
        this.handleMeasureSelected(idx);
        if (inputName.value) inputName.select();
      });
      const commitName = () => {
        const newVal = inputName.value.trim();
        const oldVal = (m.nickname || '').trim();
        if (newVal !== oldVal) state.updateMeasure(idx, { nickname: newVal });
      };
      inputName.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') inputName.blur();
        else if (e.key === 'Escape') {
          inputName.value = m.nickname || '';
          inputName.blur();
        }
      });
      inputName.addEventListener('blur', commitName);
      inputName.addEventListener('change', commitName);
    }

    // Beats stepper
    const btnBeatsMinus = card.querySelector('.btn-beats-minus');
    const btnBeatsPlus = card.querySelector('.btn-beats-plus');
    const inputBeats = card.querySelector('.input-card-beats');
    if (btnBeatsMinus) {
      btnBeatsMinus.addEventListener('dblclick', (e) => e.stopPropagation());
      btnBeatsMinus.addEventListener('click', (e) => {
        e.stopPropagation();
        const cur = Math.max(1, (m.beats || 4) - 1);
        state.updateMeasure(idx, { beats: cur });
      });
    }
    if (btnBeatsPlus) {
      btnBeatsPlus.addEventListener('dblclick', (e) => e.stopPropagation());
      btnBeatsPlus.addEventListener('click', (e) => {
        e.stopPropagation();
        const cur = Math.min(32, (m.beats || 4) + 1);
        state.updateMeasure(idx, { beats: cur });
      });
    }
    if (inputBeats) {
      inputBeats.addEventListener('dblclick', (e) => e.stopPropagation());
      inputBeats.addEventListener('click', (e) => e.stopPropagation());
      inputBeats.addEventListener('focus', () => {
        this.handleMeasureSelected(idx);
        inputBeats.select();
      });
      inputBeats.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' || e.key === 'Enter') {
          e.stopPropagation();
          inputBeats.blur();
        }
      });
      inputBeats.addEventListener('change', (e) => {
        e.stopPropagation();
        const parsed = Math.max(1, Math.min(32, parseInt(inputBeats.value, 10) || 4));
        if (parsed !== (m.beats || 4)) state.updateMeasure(idx, { beats: parsed });
      });
    }

    // Repeat stepper
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
      inputRepeat.addEventListener('focus', () => {
        this.handleMeasureSelected(idx);
        inputRepeat.select();
      });
      inputRepeat.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' || e.key === 'Enter') {
          e.stopPropagation();
          inputRepeat.blur();
        }
      });
      inputRepeat.addEventListener('change', (e) => {
        e.stopPropagation();
        const parsed = Math.max(1, Math.min(999, parseInt(inputRepeat.value, 10) || 1));
        if (parsed !== (m.repeat || 1)) state.updateMeasure(idx, { repeat: parsed });
      });
    }

    // Prevent dblclick on buttons
    card.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('dblclick', (e) => e.stopPropagation());
    });

    // Action buttons & card clicks
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-card-add-right')) {
        e.stopPropagation();
        const res = state.addMeasureAfter(idx);
        this.renderMeasuresList();
        if (res && typeof res.measureIndex === 'number') {
          this.handleMeasureSelected(res.measureIndex);
        }
        return;
      }
      if (e.target.closest('.btn-card-add-section-right')) {
        e.stopPropagation();
        const insertItemIdx = (m._itemIndex !== undefined) ? m._itemIndex + 1 : state.items.length;
        const secCount = state.groups.filter(g => !g.isBossaBlock).length + 1;
        state.addSection(insertItemIdx, { name: `Seção ${secCount}` });
        this.renderMeasuresList();
        this.showToast(`Seção criada após o compasso c. ${idx + 1}!`, '🏷️');
        return;
      }
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

      const bossaPill = e.target.closest('.measure-bossa-pill');
      if (bossaPill) {
        e.stopPropagation();
        const bId = bossaPill.getAttribute('data-bossa-id') || m.sourcePieceId || grp?.sourcePieceId;
        const bName = bossaPill.getAttribute('data-bossa-name') || m.sourcePieceName || grp?.sourcePieceName || grp?.name;
        this.navigateToBossaOrPiece(bId, bName, grp);
        return;
      }

      this.handleMeasureSelected(idx, e);
      const t = state.getFirstTimingForMeasure(idx);
      if (t && !e.shiftKey) this.seekTo(t.startTime);
    });

    card.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, input, select, textarea, .card-actions, .card-repeat-box, .btn-repeat-step, .btn-card-icon, .btn-card-edit')) {
        return;
      }
      this.openMeasureModal(idx);
    });

    card.addEventListener('contextmenu', (e) => {
      if (e.target.closest('input, textarea, select')) return;
      e.preventDefault();
      this.openContextMenu(idx, e.clientX, e.clientY);
    });

    return card;
  }

  renderMeasuresList() {
    const grid = this.dom.measuresGrid;
    const items = state.items || [];
    const measures = state.measures || [];

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

    if (items.length === 0) {
      grid.innerHTML = `
        <div class="empty-measures-state">
          <div class="empty-icon">${iconSvg('drum', { size: 36 })}</div>
          <h3 class="empty-title">Nenhum compasso na peça</h3>
          <p class="empty-desc">Esta peça está sem compassos no momento. Adicione compassos para construir sua partitura ou escolha uma peça de exemplo no menu superior.</p>
          <div class="empty-actions">
            <button type="button" class="btn-empty-add" id="btnEmptyAddMeasure" style="display:inline-flex; align-items:center; gap:6px;">
              ${iconSvg('plus', { size: 16 })} Adicionar Primeiro Compasso
            </button>
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

    items.forEach((item, itemIdx) => {
      if (item.type === 'section') {
        grid.appendChild(this.createSectionHeaderElement(item, itemIdx));
        return;
      }

      if (item.type === 'bossa') {
        const bossaMeasures = measures.filter(m => m._itemIndex === itemIdx);
        const count = bossaMeasures.length;
        const cleanBossaName = (item.sourcePieceName || item.name || 'Bossa').replace(/^[🔗📦✏️🔓\s]+/, '').trim();
        const bossaEffectiveBpm = state.getBossaEffectiveBpm(item);
        const tempoMode = item.tempoMode || 'inherit';

        // Variáveis de repetição suportadas por esta bossa
        const bossaVars = state.getBossaVariables(item);
        if (!item.variableValues) item.variableValues = {};
        bossaVars.forEach(v => {
          if (item.variableValues[v.name] === undefined) {
            item.variableValues[v.name] = v.defaultValue;
          }
        });

        let bossaDurationSec = 0;
        bossaMeasures.forEach(m => {
          const mIdx = measures.indexOf(m);
          if (mIdx >= 0) {
            const tims = state.measureTimings.filter(t => t.measureIndex === mIdx);
            tims.forEach(t => bossaDurationSec += t.duration);
          }
        });
        const bossaDurationStr = this.formatFriendlyDuration(bossaDurationSec);
        const bossaRepeatTagHtml = (item.repeat || 1) > 1
          ? `<span class="measure-card-repeat-tag" title="Esta bossa se repete ${item.repeat} vezes na peça">×${item.repeat}</span>`
          : '';

        const bossaElement = document.createElement('div');
        bossaElement.dataset.itemIndex = itemIdx;
        bossaElement.draggable = true;
        bossaElement.style.setProperty('--bossa-color', item.color || '#8b5cf6');
        bossaElement.style.setProperty('--card-bossa-color', item.color || '#8b5cf6');

        if (item.collapsed) {
          // =========================================================================
          // ESTADO RECOLHIDO: Exibe exatamente como um card de compasso na grade
          // =========================================================================
          bossaElement.className = 'measure-card bossa-card-compact is-collapsed is-bossa-member';

          const firstM = bossaMeasures[0];
          const lastM = bossaMeasures[bossaMeasures.length - 1];
          const firstIdx = firstM ? measures.indexOf(firstM) : -1;
          const lastIdx = lastM ? measures.indexOf(lastM) : -1;
          const rangeStr = (firstIdx >= 0 && lastIdx >= 0)
            ? (firstIdx === lastIdx ? `c. ${firstIdx + 1}` : `c. ${firstIdx + 1}–${lastIdx + 1}`)
            : `${count} comp.`;

          let compactVarsHtml = '';
          if (bossaVars.length > 0) {
            compactVarsHtml = `
              <div class="bossa-compact-vars-box" onclick="event.stopPropagation()">
                <div class="bossa-vars-header-label">${iconSvg('sliders', { size: 11 })} Repetições da Bossa:</div>
                ${bossaVars.map(v => {
                  const curVal = item.variableValues[v.name] !== undefined ? item.variableValues[v.name] : v.defaultValue;
                  return `
                    <div class="bossa-compact-var-row" title="Variável de repetição da bossa: ${v.label || v.name}">
                      <span class="bossa-var-label">${v.name}:</span>
                      <div class="repeat-stepper compact-var-stepper" data-var="${v.name}">
                        <button type="button" class="btn-repeat-step btn-var-minus" data-var="${v.name}" title="Diminuir repetições de ${v.name}">-</button>
                        <input type="number" class="input-card-repeat input-bossa-var" data-var="${v.name}" min="1" max="999" value="${curVal}" title="Repetições de ${v.name}">
                        <button type="button" class="btn-repeat-step btn-var-plus" data-var="${v.name}" title="Aumentar repetições de ${v.name}">+</button>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            `;
          }

          bossaElement.innerHTML = `
            <div class="measure-card-group-strip" style="background:${item.color || '#8b5cf6'}"></div>

            <div class="measure-card-header">
              <div class="card-idx-wrap">
                <span class="bossa-drag-handle" title="Arraste para reposicionar a bossa inteira na peça" style="cursor:grab; font-size:1.05rem; line-height:1; opacity:0.65; margin-right:3px;">⠿</span>
                <span class="measure-card-idx" style="color:${item.color || '#8b5cf6'}; font-weight:800">${rangeStr}</span>
                ${bossaRepeatTagHtml}
              </div>
              <div class="measure-card-tags">
                <span class="measure-bossa-pill linked" style="background:${item.color || '#8b5cf6'}25; color:${item.color || '#8b5cf6'}; border-color:${item.color || '#8b5cf6'}40" title="${item.isLinked ? 'Bossa vinculada' : 'Bloco de bossa'}">
                  ${item.isLinked ? iconSvg('link', { size: 11 }) : iconSvg('box', { size: 11 })} ${item.isLinked ? 'Bossa' : 'Bloco'}
                </span>
              </div>
            </div>

            <div class="measure-card-title-wrap">
              <div class="bossa-compact-title bossa-block-header-title" style="cursor:pointer;" title="Clique para expandir esta bossa">
                <strong style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${item.name}</strong>
              </div>
            </div>

            <div class="measure-card-details">
              <span class="measure-card-meter" title="${count} compassos • Duração: ${bossaDurationStr}">${count} ${count === 1 ? 'compasso' : 'compassos'}</span>
              <span class="measure-card-tempo" title="Andamento: ${bossaEffectiveBpm} BPM • Duração total: ${bossaDurationStr}">${iconSvg('clock', { size: 12 })} ${bossaDurationStr} • ${bossaEffectiveBpm} BPM</span>
            </div>

            ${compactVarsHtml}

            <div class="measure-card-steppers">
              <div class="measure-card-stepper-row" style="width:100%;">
                <span class="card-stepper-label">Repetir:</span>
                <div class="repeat-stepper">
                  <button type="button" class="btn-repeat-step btn-bossa-repeat-minus" title="Diminuir repetições da bossa">-</button>
                  <input type="number" class="input-card-repeat input-bossa-repeat" min="1" max="999" value="${item.repeat || 1}" title="Número de vezes que esta bossa se repete">
                  <button type="button" class="btn-repeat-step btn-bossa-repeat-plus" title="Aumentar repetições da bossa">+</button>
                </div>
              </div>
              <div class="measure-card-stepper-row bossa-tempo-stepper-row" style="width:100%; margin-top:4px;">
                <span class="card-stepper-label">Andamento:</span>
                <div class="bossa-compact-tempo-wrap">
                  <select class="select-bossa-tempo-mode" title="Modo de andamento da bossa">
                    <option value="inherit" ${tempoMode === 'inherit' ? 'selected' : ''}>Peça (${state.baseBpm})</option>
                    <option value="fixed" ${tempoMode === 'fixed' ? 'selected' : ''}>Fixo (${item.bpm || bossaEffectiveBpm} BPM)</option>
                    <option value="ratio" ${tempoMode === 'ratio' ? 'selected' : ''}>Proporção (${item.ratioNum || 1}/${item.ratioDen || 1})</option>
                  </select>
                  <div class="repeat-stepper bossa-bpm-stepper" style="${tempoMode === 'fixed' ? 'display:inline-flex;' : 'display:none;'}">
                    <button type="button" class="btn-repeat-step btn-bossa-bpm-minus" title="Diminuir 5 BPM">-5</button>
                    <input type="number" class="input-card-repeat input-bossa-bpm" min="20" max="400" value="${item.bpm || bossaEffectiveBpm}" title="BPM da bossa">
                    <button type="button" class="btn-repeat-step btn-bossa-bpm-plus" title="Aumentar 5 BPM">+5</button>
                  </div>
                  <div class="bossa-ratio-stepper-box" style="${tempoMode === 'ratio' ? 'display:inline-flex;' : 'display:none;'}">
                    <input type="number" class="input-card-repeat input-bossa-ratio-num" min="1" max="32" value="${item.ratioNum || 1}" title="Numerador da proporção">
                    <span class="bossa-ratio-divider">/</span>
                    <input type="number" class="input-card-repeat input-bossa-ratio-den" min="1" max="32" value="${item.ratioDen || 1}" title="Denominador da proporção">
                  </div>
                </div>
              </div>
            </div>

            <div class="measure-card-actions">
              <div class="card-actions-secondary">
                <button type="button" class="btn-card-icon btn-move-bossa-left" title="Mover bossa para trás (←)" ${itemIdx === 0 ? 'disabled style="opacity:0.3;pointer-events:none"' : ''}>${iconSvg('chevron-left', { size: 14 })}</button>
                <button type="button" class="btn-card-icon btn-move-bossa-right" title="Mover bossa para frente (→)" ${itemIdx >= items.length - 1 ? 'disabled style="opacity:0.3;pointer-events:none"' : ''}>${iconSvg('chevron-right', { size: 14 })}</button>
                ${item.sourcePieceId ? `<button type="button" class="btn-card-icon btn-open-bossa-page" title="Abrir '${cleanBossaName}' para edição direta">${iconSvg('external-link', { size: 13 })}</button>` : ''}
                ${item.isLinked ? `<button type="button" class="btn-card-icon btn-sync-bossa-block" title="Sincronizar com a bossa original">${iconSvg('rotate-ccw', { size: 13 })}</button>` : ''}
                ${item.isLinked ? `<button type="button" class="btn-card-icon btn-unlink-bossa-block" title="Desvincular bloco da peça original">${iconSvg('unlock', { size: 13 })}</button>` : ''}
                <button type="button" class="btn-card-icon btn-del-bossa-block" title="Excluir este bloco de bossa da peça" style="color:#f87171">${iconSvg('trash-2', { size: 13 })}</button>
              </div>
              <button type="button" class="btn-card-edit btn-bossa-toggle-view" title="Expandir compassos desta bossa">
                <span class="btn-card-edit-icon">${iconSvg('chevron-down', { size: 13 })}</span>
                <span class="btn-card-edit-text">Expandir (${count})</span>
              </button>
            </div>
          `;

          // Mapeia os compassos da bossa para este card no cache de playback
          bossaMeasures.forEach(m => {
            const mIdx = measures.indexOf(m);
            if (mIdx >= 0) this.cachedCards[mIdx] = bossaElement;
          });
        } else {
          // =========================================================================
          // ESTADO EXPANDIDO: Container amplo em toda a linha com a grade interna
          // =========================================================================
          bossaElement.className = 'bossa-block-container is-expanded';

          bossaElement.innerHTML = `
            <div class="bossa-container-header">
              <div class="bossa-block-header-info">
                <span class="bossa-drag-handle" title="Arraste para reposicionar a bossa inteira na peça">⠿</span>
                <button type="button" class="btn-toggle-bossa-collapse" title="Recolher bossa para card individual">
                  ${iconSvg('chevron-down', { size: 14 })}
                </button>
                <span class="bossa-block-header-badge" style="background:${item.color || '#8b5cf6'}25; color:${item.color || '#8b5cf6'}">
                  ${item.isLinked ? `${iconSvg('link', { size: 12 })} Bossa Vinculada` : `${iconSvg('box', { size: 12 })} Bloco Bossa`}
                </span>
                <span class="bossa-block-header-title" style="cursor:pointer" title="Clique para recolher">${item.name}</span>
                <span class="bossa-block-header-range">${count} ${count === 1 ? 'compasso' : 'compassos'}</span>
                <span class="bossa-block-header-time" title="Tempo total desta bossa na peça: ${bossaDurationStr}">${iconSvg('clock', { size: 13 })} ${bossaDurationStr}</span>
                <span class="bossa-block-header-tempo-badge" title="Andamento efetivo desta bossa: ${bossaEffectiveBpm} BPM (${tempoMode === 'inherit' ? 'Seguindo Peça' : tempoMode === 'fixed' ? 'Fixo' : 'Proporção'})" style="background:${item.color || '#8b5cf6'}20; color:${item.color || '#8b5cf6'}">
                  ${iconSvg('activity', { size: 12 })} ${bossaEffectiveBpm} BPM
                </span>
                ${bossaRepeatTagHtml}
              </div>
              <div class="bossa-block-header-actions">
                <button type="button" class="btn-bossa-block-action btn-bossa-toggle-view" title="Recolher para card compacto">
                  ${iconSvg('chevron-up', { size: 13 })}
                  <span>Recolher</span>
                </button>

                <div class="bossa-repeat-stepper-wrap" title="Número de vezes que esta bossa se repete na peça">
                  <span class="card-stepper-label">Repetir:</span>
                  <div class="repeat-stepper">
                    <button type="button" class="btn-repeat-step btn-bossa-repeat-minus" title="Diminuir repetições da bossa">-</button>
                    <input type="number" class="input-card-repeat input-bossa-repeat" min="1" max="999" value="${item.repeat || 1}" title="Número de vezes que esta bossa se repete">
                    <button type="button" class="btn-repeat-step btn-bossa-repeat-plus" title="Aumentar repetições da bossa">+</button>
                  </div>
                </div>

                <div class="bossa-tempo-stepper-wrap" title="Configurar andamento desta bossa (funciona vinculada)">
                  <span class="card-stepper-label">Andamento:</span>
                  <select class="select-bossa-tempo-mode" title="Modo de andamento da bossa">
                    <option value="inherit" ${tempoMode === 'inherit' ? 'selected' : ''}>Seguir Peça (${state.baseBpm} BPM)</option>
                    <option value="fixed" ${tempoMode === 'fixed' ? 'selected' : ''}>BPM Fixo</option>
                    <option value="ratio" ${tempoMode === 'ratio' ? 'selected' : ''}>Proporção</option>
                  </select>
                  <div class="repeat-stepper bossa-bpm-stepper" style="${tempoMode === 'fixed' ? 'display:inline-flex;' : 'display:none;'}">
                    <button type="button" class="btn-repeat-step btn-bossa-bpm-minus" title="Diminuir 5 BPM">-5</button>
                    <input type="number" class="input-card-repeat input-bossa-bpm" min="20" max="400" value="${item.bpm || bossaEffectiveBpm}" title="BPM da bossa">
                    <button type="button" class="btn-repeat-step btn-bossa-bpm-plus" title="Aumentar 5 BPM">+5</button>
                  </div>
                  <div class="bossa-ratio-stepper-box" style="${tempoMode === 'ratio' ? 'display:inline-flex;' : 'display:none;'}">
                    <input type="number" class="input-card-repeat input-bossa-ratio-num" min="1" max="32" value="${item.ratioNum || 1}" title="Numerador da proporção">
                    <span class="bossa-ratio-divider">/</span>
                    <input type="number" class="input-card-repeat input-bossa-ratio-den" min="1" max="32" value="${item.ratioDen || 1}" title="Denominador da proporção">
                    <span class="bossa-ratio-calc-preview">(${bossaEffectiveBpm} BPM)</span>
                  </div>
                </div>

                ${item.sourcePieceId ? `
                  <button type="button" class="btn-bossa-block-action btn-open-bossa-page" title="Abrir '${cleanBossaName}' para edição direta">
                    ${iconSvg('external-link', { size: 13 })} Abrir "${cleanBossaName}"
                  </button>
                ` : ''}

                <button type="button" class="btn-bossa-block-action btn-move-bossa-left" title="Mover bossa para trás (←)" ${itemIdx === 0 ? 'disabled style="opacity:0.35;pointer-events:none"' : ''}>
                  ${iconSvg('arrow-left', { size: 13 })} Mover
                </button>
                <button type="button" class="btn-bossa-block-action btn-move-bossa-right" title="Mover bossa para frente (→)" ${itemIdx >= items.length - 1 ? 'disabled style="opacity:0.35;pointer-events:none"' : ''}>
                  Mover ${iconSvg('arrow-right', { size: 13 })}
                </button>

                ${item.isLinked ? `
                  <button type="button" class="btn-bossa-block-action btn-sync-bossa-block" title="Sincronizar este bloco com a bossa original">
                    ${iconSvg('rotate-ccw', { size: 13 })} Sincronizar
                  </button>
                  <button type="button" class="btn-bossa-block-action btn-unlink-bossa-block" title="Desvincular bloco da peça original (tornar edições independentes)">
                    ${iconSvg('unlock', { size: 13 })} Desvincular
                  </button>
                ` : ''}

                <button type="button" class="btn-bossa-block-action btn-del-bossa-block" title="Excluir este bloco de bossa da peça" style="color:#f87171">
                  ${iconSvg('trash-2', { size: 13 })}
                </button>
              </div>
            </div>
          `;

          const body = document.createElement('div');
          body.className = 'bossa-container-body';

          if (item.isLinked) {
            const notice = document.createElement('div');
            notice.className = 'bossa-linked-notice';
            notice.innerHTML = `${iconSvg('link', { size: 14 })} Bossa vinculada à <strong>${cleanBossaName}</strong>. Os compassos são sincronizados dinamicamente da bossa original.`;
            body.appendChild(notice);
          }

          if (bossaVars.length > 0) {
            const expandedVarsDiv = document.createElement('div');
            expandedVarsDiv.className = 'bossa-expanded-vars-box';
            expandedVarsDiv.innerHTML = `
              <span class="bossa-vars-header-label">${iconSvg('sliders', { size: 12 })} Variáveis Internas:</span>
              ${bossaVars.map(v => {
                const curVal = item.variableValues[v.name] !== undefined ? item.variableValues[v.name] : v.defaultValue;
                return `
                  <div class="bossa-var-badge" title="Variável '${v.label || v.name}'">
                    <span class="bossa-var-name">${v.label || v.name}:</span>
                    <div class="repeat-stepper var-stepper" data-var="${v.name}">
                      <button type="button" class="btn-repeat-step btn-var-minus" data-var="${v.name}">-</button>
                      <input type="number" class="input-card-repeat input-bossa-var" data-var="${v.name}" min="1" max="999" value="${curVal}">
                      <button type="button" class="btn-repeat-step btn-var-plus" data-var="${v.name}">+</button>
                    </div>
                  </div>
                `;
              }).join('')}
            `;
            body.appendChild(expandedVarsDiv);
          }

          const innerGrid = document.createElement('div');
          innerGrid.className = 'bossa-inner-measures-grid';

          bossaMeasures.forEach(m => {
            const mIdx = measures.indexOf(m);
            const card = this.createMeasureCardElement(m, mIdx, item);
            innerGrid.appendChild(card);
            if (mIdx >= 0) this.cachedCards[mIdx] = card;
          });

          body.appendChild(innerGrid);
          bossaElement.appendChild(body);
        }

        // Eventos comuns para ambos os layouts (expandido ou recolhido):
        const handleToggle = (e) => {
          e.stopPropagation();
          state.toggleBossaCollapse(itemIdx);
          this.renderMeasuresList();
        };
        bossaElement.querySelector('.btn-toggle-bossa-collapse')?.addEventListener('click', handleToggle);
        bossaElement.querySelector('.btn-bossa-toggle-view')?.addEventListener('click', handleToggle);
        bossaElement.querySelector('.bossa-block-header-title')?.addEventListener('click', handleToggle);
        bossaElement.querySelector('.bossa-compact-title')?.addEventListener('click', handleToggle);

        if (item.collapsed) {
          bossaElement.addEventListener('dblclick', (e) => {
            if (e.target.closest('button, input, select, textarea, .repeat-stepper')) return;
            handleToggle(e);
          });
          bossaElement.addEventListener('click', (e) => {
            if (e.target.closest('button, input, select, textarea, .repeat-stepper, .bossa-drag-handle')) return;
            const firstM = bossaMeasures[0];
            const firstIdx = firstM ? measures.indexOf(firstM) : -1;
            if (firstIdx >= 0) {
              this.handleMeasureSelected(firstIdx);
              const t = state.getFirstTimingForMeasure(firstIdx);
              if (t) this.seekTo(t.startTime);
            }
          });
        }

        // Stepper de repetição
        const btnBossaRepMinus = bossaElement.querySelector('.btn-bossa-repeat-minus');
        const btnBossaRepPlus = bossaElement.querySelector('.btn-bossa-repeat-plus');
        const inputBossaRep = bossaElement.querySelector('.input-bossa-repeat');
        if (inputBossaRep) {
          const updateBossaRep = (newVal) => {
            const val = Math.max(1, Math.min(999, parseInt(newVal, 10) || 1));
            if (val !== item.repeat) {
              state.updateItem(itemIdx, { repeat: val });
              this.renderMeasuresList();
            }
          };
          inputBossaRep.addEventListener('click', (e) => e.stopPropagation());
          inputBossaRep.addEventListener('mousedown', (e) => e.stopPropagation());
          inputBossaRep.addEventListener('change', (e) => { e.stopPropagation(); updateBossaRep(e.target.value); });
          inputBossaRep.addEventListener('blur', (e) => { e.stopPropagation(); updateBossaRep(e.target.value); });
          inputBossaRep.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' || e.key === 'Enter') { e.stopPropagation(); inputBossaRep.blur(); }
          });
          btnBossaRepMinus?.addEventListener('click', (e) => {
            e.stopPropagation();
            const cur = parseInt(inputBossaRep.value, 10) || 1;
            if (cur > 1) updateBossaRep(cur - 1);
          });
          btnBossaRepPlus?.addEventListener('click', (e) => {
            e.stopPropagation();
            const cur = parseInt(inputBossaRep.value, 10) || 1;
            if (cur < 999) updateBossaRep(cur + 1);
          });
        }

        // Steppers de Variáveis da Bossa
        bossaElement.querySelectorAll('.btn-var-minus').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const varName = btn.dataset.var;
            const input = bossaElement.querySelector(`.input-bossa-var[data-var="${varName}"]`);
            const cur = parseInt(input?.value, 10) || 1;
            if (cur > 1) {
              state.updateBossaVariable(itemIdx, varName, cur - 1);
              this.renderMeasuresList();
            }
          });
        });

        bossaElement.querySelectorAll('.btn-var-plus').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const varName = btn.dataset.var;
            const input = bossaElement.querySelector(`.input-bossa-var[data-var="${varName}"]`);
            const cur = parseInt(input?.value, 10) || 1;
            if (cur < 999) {
              state.updateBossaVariable(itemIdx, varName, cur + 1);
              this.renderMeasuresList();
            }
          });
        });

        bossaElement.querySelectorAll('.input-bossa-var').forEach(input => {
          input.addEventListener('click', (e) => e.stopPropagation());
          input.addEventListener('mousedown', (e) => e.stopPropagation());
          const apply = () => {
            const varName = input.dataset.var;
            const val = Math.max(1, Math.min(999, parseInt(input.value, 10) || 1));
            state.updateBossaVariable(itemIdx, varName, val);
            this.renderMeasuresList();
          };
          input.addEventListener('change', (e) => { e.stopPropagation(); apply(); });
          input.addEventListener('blur', (e) => { e.stopPropagation(); apply(); });
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === 'Escape') { e.stopPropagation(); input.blur(); }
          });
        });

        // Controles de Andamento / BPM da Bossa (mantém vinculação ativa)
        bossaElement.querySelectorAll('.select-bossa-tempo-mode').forEach(sel => {
          sel.addEventListener('click', e => e.stopPropagation());
          sel.addEventListener('mousedown', e => e.stopPropagation());
          sel.addEventListener('change', (e) => {
            e.stopPropagation();
            const newMode = e.target.value;
            const currentEffBpm = state.getBossaEffectiveBpm(item);
            state.updateBossaTempo(item.id, {
              tempoMode: newMode,
              bpm: item.bpm || currentEffBpm,
              ratioNum: item.ratioNum || 1,
              ratioDen: item.ratioDen || 1
            });
            this.renderMeasuresList();
          });
        });

        const handleBpmUpdate = (val) => {
          const parsed = Math.max(20, Math.min(400, Math.round(Number(val)) || state.baseBpm));
          state.updateBossaTempo(item.id, { tempoMode: 'fixed', bpm: parsed });
          this.renderMeasuresList();
        };

        bossaElement.querySelectorAll('.input-bossa-bpm').forEach(input => {
          input.addEventListener('click', e => e.stopPropagation());
          input.addEventListener('mousedown', e => e.stopPropagation());
          input.addEventListener('change', (e) => { e.stopPropagation(); handleBpmUpdate(e.target.value); });
          input.addEventListener('blur', (e) => { e.stopPropagation(); handleBpmUpdate(e.target.value); });
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === 'Escape') { e.stopPropagation(); input.blur(); }
          });
        });

        bossaElement.querySelectorAll('.btn-bossa-bpm-minus').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const cur = item.bpm || state.getBossaEffectiveBpm(item);
            handleBpmUpdate(cur - 5);
          });
        });

        bossaElement.querySelectorAll('.btn-bossa-bpm-plus').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const cur = item.bpm || state.getBossaEffectiveBpm(item);
            handleBpmUpdate(cur + 5);
          });
        });

        bossaElement.querySelectorAll('.input-bossa-ratio-num').forEach(input => {
          input.addEventListener('click', e => e.stopPropagation());
          input.addEventListener('mousedown', e => e.stopPropagation());
          const update = () => {
            const val = Math.max(1, Math.min(32, parseInt(input.value, 10) || 1));
            state.updateBossaTempo(item.id, { tempoMode: 'ratio', ratioNum: val });
            this.renderMeasuresList();
          };
          input.addEventListener('change', (e) => { e.stopPropagation(); update(); });
          input.addEventListener('blur', (e) => { e.stopPropagation(); update(); });
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === 'Escape') { e.stopPropagation(); input.blur(); }
          });
        });

        bossaElement.querySelectorAll('.input-bossa-ratio-den').forEach(input => {
          input.addEventListener('click', e => e.stopPropagation());
          input.addEventListener('mousedown', e => e.stopPropagation());
          const update = () => {
            const val = Math.max(1, Math.min(32, parseInt(input.value, 10) || 1));
            state.updateBossaTempo(item.id, { tempoMode: 'ratio', ratioDen: val });
            this.renderMeasuresList();
          };
          input.addEventListener('change', (e) => { e.stopPropagation(); update(); });
          input.addEventListener('blur', (e) => { e.stopPropagation(); update(); });
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === 'Escape') { e.stopPropagation(); input.blur(); }
          });
        });

        bossaElement.querySelector('.btn-open-bossa-page')?.addEventListener('click', (e) => {
          e.stopPropagation();
          this.navigateToBossaOrPiece(item.sourcePieceId, item.sourcePieceName || item.name);
        });

        bossaElement.querySelector('.btn-move-bossa-left')?.addEventListener('click', (e) => {
          e.stopPropagation();
          if (state.moveItemLeft(itemIdx)) {
            this.renderMeasuresList();
            this.showToast(`Bossa '${item.name}' movida para trás!`, '📦');
          }
        });

        bossaElement.querySelector('.btn-move-bossa-right')?.addEventListener('click', (e) => {
          e.stopPropagation();
          if (state.moveItemRight(itemIdx)) {
            this.renderMeasuresList();
            this.showToast(`Bossa '${item.name}' movida para frente!`, '📦');
          }
        });

        bossaElement.querySelector('.btn-sync-bossa-block')?.addEventListener('click', (e) => {
          e.stopPropagation();
          state.syncLinkedBossa(itemIdx);
          this.renderMeasuresList();
          this.showToast(`Bossa '${item.name}' sincronizada com o original!`, '🔄');
        });

        bossaElement.querySelector('.btn-unlink-bossa-block')?.addEventListener('click', (e) => {
          e.stopPropagation();
          state.unlinkBossa(itemIdx);
          this.renderMeasuresList();
          this.showToast(`Bossa '${item.name}' desvinculada! Edições locais permitidas.`, '🔓');
        });

        bossaElement.querySelector('.btn-del-bossa-block')?.addEventListener('click', (e) => {
          e.stopPropagation();
          state.removeItem(itemIdx);
          this.renderMeasuresList();
          this.showToast(`Bossa '${item.name}' removida da peça.`, '🗑️');
        });

        // Drag & drop no bossaElement (mover o bloco/card inteiro na peça)
        bossaElement.addEventListener('dragstart', (e) => {
          if (e.target.closest('input, button, select, textarea')) {
            e.preventDefault();
            return;
          }
          e.dataTransfer.setData('text/item-index', itemIdx);
          e.dataTransfer.setData('text/plain', `item:${itemIdx}`);
          bossaElement.classList.add('is-drag-source');
        });

        bossaElement.addEventListener('dragend', () => {
          bossaElement.classList.remove('is-drag-source');
          grid.querySelectorAll('.is-drag-target').forEach(el => el.classList.remove('is-drag-target'));
        });

        bossaElement.addEventListener('dragover', (e) => {
          e.preventDefault();
          bossaElement.classList.add('is-drag-target');
        });

        bossaElement.addEventListener('dragleave', () => {
          bossaElement.classList.remove('is-drag-target');
        });

        bossaElement.addEventListener('drop', (e) => {
          e.preventDefault();
          bossaElement.classList.remove('is-drag-target');
          const rawItem = e.dataTransfer.getData('text/item-index') || (e.dataTransfer.getData('text/plain') || '').replace('item:', '');
          const fromIdx = parseInt(rawItem, 10);
          if (!isNaN(fromIdx) && fromIdx !== itemIdx) {
            state.moveItem(fromIdx, itemIdx);
            this.renderMeasuresList();
          }
        });

        grid.appendChild(bossaElement);
      } else {
        // Compasso normal (item avulso)
        const mIdx = measures.findIndex(m => m._itemIndex === itemIdx);
        const actualIdx = (mIdx >= 0 ? mIdx : 0);
        const m = (mIdx >= 0 ? measures[mIdx] : null) || item;

        // Seção / Grupo comum (se houver)
        const grp = state.getGroupByMeasureIndex(actualIdx);
        if (grp && !grp.isBossaBlock && grp.startMeasure === actualIdx) {
          const groupBlockHeader = document.createElement('div');
          groupBlockHeader.className = 'group-block-header';
          groupBlockHeader.setAttribute('draggable', 'true');
          groupBlockHeader.setAttribute('data-group-id', grp.id);
          const gColor = grp.color || '#3b82f6';
          groupBlockHeader.style.setProperty('--group-color', gColor);
          const count = (grp.endMeasure - grp.startMeasure) + 1;

          let groupDurationSec = 0;
          const groupTimings = state.measureTimings.filter(t => t.groupId === grp.id);
          if (groupTimings.length > 0) {
            groupTimings.forEach(t => groupDurationSec += t.duration);
          } else {
            for (let gi = grp.startMeasure; gi <= grp.endMeasure; gi++) {
              const mTimings = state.measureTimings.filter(t => t.measureIndex === gi);
              mTimings.forEach(t => groupDurationSec += t.duration);
            }
          }
          const groupDurationStr = this.formatFriendlyDuration(groupDurationSec);
          const groupRepeatTagHtml = (grp.repeat || 1) > 1
            ? `<span class="measure-card-repeat-tag" title="Esta seção se repete ${grp.repeat} vezes na peça">×${grp.repeat}</span>`
            : '';

          groupBlockHeader.innerHTML = `
            <div class="group-block-header-info">
              <span class="group-drag-handle" title="Arraste para reposicionar o grupo inteiro na peça">⠿</span>
              <span class="group-block-header-badge" style="background:${gColor}25; color:${gColor}">
                ${iconSvg('tag', { size: 12 })} Seção / Grupo
              </span>
              <span class="group-block-header-title">${grp.name}</span>
              <span class="group-block-header-range">c. ${grp.startMeasure + 1} a ${grp.endMeasure + 1} (${count} ${count === 1 ? 'compasso' : 'compassos'})</span>
              <span class="group-block-header-time" title="Tempo total desta seção na peça: ${groupDurationStr}">${iconSvg('clock', { size: 13 })} ${groupDurationStr}</span>
              ${groupRepeatTagHtml}
            </div>
            <div class="group-block-header-actions">
              <div class="group-repeat-stepper-wrap" title="Número de vezes que esta seção se repete na peça">
                <span class="card-stepper-label">Repetir:</span>
                <div class="repeat-stepper">
                  <button type="button" class="btn-repeat-step btn-group-repeat-minus" title="Diminuir repetições do grupo">-</button>
                  <input type="number" class="input-card-repeat input-group-repeat" min="1" max="999" value="${grp.repeat || 1}" title="Número de vezes que esta seção se repete">
                  <button type="button" class="btn-repeat-step btn-group-repeat-plus" title="Aumentar repetições do grupo">+</button>
                </div>
              </div>
              <button type="button" class="btn-group-block-action btn-move-group-left" title="Mover seção inteira para trás (←)" ${grp.startMeasure === 0 ? 'disabled style="opacity:0.35;pointer-events:none"' : ''}>
                ${iconSvg('arrow-left', { size: 13 })} Mover
              </button>
              <button type="button" class="btn-group-block-action btn-move-group-right" title="Mover seção inteira para frente (→)" ${grp.endMeasure >= measures.length - 1 ? 'disabled style="opacity:0.35;pointer-events:none"' : ''}>
                Mover ${iconSvg('arrow-right', { size: 13 })}
              </button>
              <button type="button" class="btn-group-block-action btn-ungroup-action" title="Desagrupar esta seção">
                ${iconSvg('trash-2', { size: 13 })} Desagrupar
              </button>
            </div>
          `;

          const btnGrpRepMinus = groupBlockHeader.querySelector('.btn-group-repeat-minus');
          const btnGrpRepPlus = groupBlockHeader.querySelector('.btn-group-repeat-plus');
          const inputGrpRep = groupBlockHeader.querySelector('.input-group-repeat');
          if (inputGrpRep) {
            const updateGrpRep = (newVal) => {
              const val = Math.max(1, Math.min(999, parseInt(newVal, 10) || 1));
              if (val !== grp.repeat) {
                state.updateGroup(grp.id, { repeat: val });
                this.renderMeasuresList();
              }
            };
            inputGrpRep.addEventListener('click', (e) => e.stopPropagation());
            inputGrpRep.addEventListener('mousedown', (e) => e.stopPropagation());
            inputGrpRep.addEventListener('change', (e) => { e.stopPropagation(); updateGrpRep(e.target.value); });
            inputGrpRep.addEventListener('blur', (e) => { e.stopPropagation(); updateGrpRep(e.target.value); });
            btnGrpRepMinus?.addEventListener('click', (e) => {
              e.stopPropagation();
              const cur = parseInt(inputGrpRep.value, 10) || 1;
              if (cur > 1) updateGrpRep(cur - 1);
            });
            btnGrpRepPlus?.addEventListener('click', (e) => {
              e.stopPropagation();
              const cur = parseInt(inputGrpRep.value, 10) || 1;
              if (cur < 999) updateGrpRep(cur + 1);
            });
          }

          groupBlockHeader.querySelector('.btn-move-group-left')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (state.moveGroupLeft(grp.id)) {
              this.renderMeasuresList();
              this.showToast(`Seção '${grp.name}' movida para trás!`, '🏷️');
            }
          });

          groupBlockHeader.querySelector('.btn-move-group-right')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (state.moveGroupRight(grp.id)) {
              this.renderMeasuresList();
              this.showToast(`Seção '${grp.name}' movida para frente!`, '🏷️');
            }
          });

          groupBlockHeader.querySelector('.btn-ungroup-action')?.addEventListener('click', (e) => {
            e.stopPropagation();
            state.removeGroup(grp.id);
            this.renderMeasuresList();
            this.showToast(`Seção '${grp.name}' desagrupada.`, '✕');
          });

          grid.appendChild(groupBlockHeader);
        }

        const card = this.createMeasureCardElement(m, actualIdx, null);
        card.dataset.itemIndex = itemIdx;

        // Top-level drag & drop no cartão de compasso avulso
        card.addEventListener('dragstart', (e) => {
          if (e.target.closest('input, button, select, textarea')) {
            e.preventDefault();
            return;
          }
          e.dataTransfer.setData('text/item-index', itemIdx);
          e.dataTransfer.setData('text/plain', `item:${itemIdx}`);
          card.classList.add('is-drag-source');
        });

        card.addEventListener('dragend', () => {
          card.classList.remove('is-drag-source');
          grid.querySelectorAll('.is-drag-target').forEach(el => el.classList.remove('is-drag-target'));
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
          const rawItem = e.dataTransfer.getData('text/item-index') || (e.dataTransfer.getData('text/plain') || '').replace('item:', '');
          const fromIdx = parseInt(rawItem, 10);
          if (!isNaN(fromIdx) && fromIdx !== itemIdx) {
            state.moveItem(fromIdx, itemIdx);
            this.renderMeasuresList();
          }
        });

        grid.appendChild(card);
        if (actualIdx >= 0) this.cachedCards[actualIdx] = card;
      }
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
        this.handleAddMeasureAction();
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
        const rawItem = e.dataTransfer.getData('text/item-index') || (e.dataTransfer.getData('text/plain') || '').replace('item:', '');
        const fromIdx = parseInt(rawItem, 10);
        if (!isNaN(fromIdx) && fromIdx < items.length - 1) {
          state.moveItem(fromIdx, items.length - 1);
          this.renderMeasuresList();
        }
      });

      grid.appendChild(addCard);
    }
  }
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

  closeMeasureModal() {
    if (this.dom.modalMeasureEdit) {
      this.dom.modalMeasureEdit.style.display = 'none';
    }
    this._editingMeasureIndices = [];
  }

  setupMeasureModal() {
    const modal = this.dom.modalMeasureEdit;
    const form = this.dom.formMeasureEdit;

    this.dom.btnModalClose.addEventListener('click', () => {
      this.closeMeasureModal();
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) this.closeMeasureModal();
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
      const indices = (this._editingMeasureIndices && this._editingMeasureIndices.length > 0)
        ? this._editingMeasureIndices
        : [parseInt(this.dom.editMeasureIndex.value, 10)];
      modal.style.display = 'none';

      if (indices.length > 1) {
        state.removeMeasures(indices);
        this.selectedMeasureIndices.clear();
        if (state.measures.length > 0) {
          const nextIdx = Math.min(Math.min(...indices), state.measures.length - 1);
          this.handleMeasureSelected(nextIdx);
        } else {
          this.closeMeasureToolbar();
        }
        this.showToast(`${indices.length} compassos excluídos`, '✕');
      } else if (indices.length === 1 && indices[0] >= 0) {
        const idx = indices[0];
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
    });

    this.dom.btnDuplicateMeasureModal.addEventListener('click', () => {
      const indices = (this._editingMeasureIndices && this._editingMeasureIndices.length > 0)
        ? this._editingMeasureIndices
        : [parseInt(this.dom.editMeasureIndex.value, 10)];
      modal.style.display = 'none';

      if (indices.length > 1) {
        this.duplicateSelectedMeasures();
      } else if (indices.length === 1 && indices[0] >= 0) {
        state.duplicateMeasure(indices[0]);
      }
    });

    // Steppers para Tempos (Pulsos) e Repetições (fácil de tocar no celular)
    this.dom.btnEditBeatsMinus?.addEventListener('click', () => {
      const cur = parseInt(this.dom.editBeats.value, 10) || 4;
      this.dom.editBeats.value = Math.max(1, cur - 1);
      this.dom.editBeats.dispatchEvent(new Event('input', { bubbles: true }));
    });

    this.dom.btnEditBeatsPlus?.addEventListener('click', () => {
      const cur = parseInt(this.dom.editBeats.value, 10) || 4;
      this.dom.editBeats.value = Math.min(32, cur + 1);
      this.dom.editBeats.dispatchEvent(new Event('input', { bubbles: true }));
    });

    this.dom.btnEditRepeatMinus?.addEventListener('click', () => {
      const cur = parseInt(this.dom.editRepeat.value, 10) || 1;
      this.dom.editRepeat.value = Math.max(1, cur - 1);
      this.dom.editRepeat.dispatchEvent(new Event('input', { bubbles: true }));
    });

    this.dom.btnEditRepeatPlus?.addEventListener('click', () => {
      const cur = parseInt(this.dom.editRepeat.value, 10) || 1;
      this.dom.editRepeat.value = Math.min(999, cur + 1);
      this.dom.editRepeat.dispatchEvent(new Event('input', { bubbles: true }));
    });

    this.dom.editCustomBpm?.addEventListener('input', () => {
      this.updateModalCalculatedBpm();
    });

    this.dom.editNickname?.addEventListener('input', () => {
      this._nicknameDirty = true;
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

    this.dom.btnMeasureOpenBossaModal?.addEventListener('click', () => {
      const idx = parseInt(this.dom.editMeasureIndex.value, 10);
      if (idx >= 0) {
        const m = state.measures[idx];
        const grp = state.getGroupByMeasureIndex(idx);
        this.closeMeasureModal();
        if (m) {
          const bId = m.sourcePieceId || grp?.sourcePieceId;
          const bName = m.sourcePieceName || grp?.sourcePieceName || grp?.name;
          this.navigateToBossaOrPiece(bId, bName, grp);
        }
      }
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const indices = (this._editingMeasureIndices && this._editingMeasureIndices.length > 0)
        ? this._editingMeasureIndices
        : [parseInt(this.dom.editMeasureIndex.value, 10)];

      if (indices.length === 0 || indices[0] < 0) return;

      const tempoMode = this.dom.radioModeFixed.checked ? 'fixed' : 'ratio';
      const num = parseInt(this.dom.editRatioNum.value, 10) || 1;
      const den = parseInt(this.dom.editRatioDen.value, 10) || 1;
      const fixedBpm = parseFloat(this.dom.editCustomBpm.value) || state.baseBpm;
      const beats = parseInt(this.dom.editBeats.value, 10) || 4;
      const repeat = Math.max(1, Math.min(999, parseInt(this.dom.editRepeat.value, 10) || 1));
      const repeatVariable = this.dom.editRepeatVariable ? this.dom.editRepeatVariable.value.trim() : null;
      const color = this.dom.editColorPicker.value;

      const updates = {
        beats,
        beatUnit: 4,
        repeat,
        repeatVariable: repeatVariable || null,
        tempoMode,
        ratioNum: num,
        ratioDen: den,
        customBpm: fixedBpm,
        color
      };

      // Atualiza o apelido se o usuário digitou/alterou intencionalmente ou se for compasso individual
      if (indices.length === 1 || this._nicknameDirty) {
        updates.nickname = this.dom.editNickname.value;
      }

      const res = state.updateMeasures(indices, updates);

      if (indices.length > 1) {
        this.showToast(`${indices.length} compassos configurados com sucesso!`, '⚡');
      } else {
        if (res?.modifiedLinkedCount > 0) {
          this.showToast('Compasso modificado localmente (desvinculado da bossa original).', '✏️');
        } else {
          this.showToast('Compasso atualizado!', '✓');
        }
      }

      this.closeMeasureModal();
      this.renderMeasuresList();
    });
  }

  toggleTempoModePanels() {
    const isRatio = this.dom.radioModeRatio.checked;
    this.dom.panelTempoRatio.style.display = isRatio ? 'block' : 'none';
    this.dom.panelTempoFixed.style.display = isRatio ? 'none' : 'block';
    this.updateModalCalculatedBpm();
  }

  updateModalCalculatedBpm() {
    const isRatio = this.dom.radioModeRatio ? this.dom.radioModeRatio.checked : true;
    let summaryText = '';
    if (isRatio) {
      const num = Math.max(1, parseInt(this.dom.editRatioNum.value, 10) || 1);
      const den = Math.max(1, parseInt(this.dom.editRatioDen.value, 10) || 1);
      const eff = Math.round(state.baseBpm * (num / den));
      this.dom.calcEffectiveBpm.textContent = `${eff} BPM`;
      summaryText = (num === 1 && den === 1) ? `${eff} BPM (1/1)` : `${eff} BPM (${num}/${den})`;
    } else {
      const fixedBpm = Math.round(parseFloat(this.dom.editCustomBpm.value) || state.baseBpm);
      summaryText = `${fixedBpm} BPM (Fixo)`;
    }
    if (this.dom.accordionTempoSummary) {
      this.dom.accordionTempoSummary.textContent = summaryText;
    }
  }

  openMeasureModal(targetIndex = null, forceSingle = false) {
    let indices = [];

    // Se há múltiplos compassos selecionados e não foi forçado modo individual:
    if (!forceSingle && this.selectedMeasureIndices && this.selectedMeasureIndices.size > 1) {
      // Se targetIndex for nulo OU pertencer à seleção:
      if (targetIndex === null || targetIndex === undefined || this.selectedMeasureIndices.has(targetIndex)) {
        indices = Array.from(this.selectedMeasureIndices)
          .filter(i => typeof i === 'number' && i >= 0 && i < state.measures.length)
          .sort((a, b) => a - b);
      }
    }

    if (indices.length === 0) {
      const single = (targetIndex !== null && targetIndex !== undefined)
        ? targetIndex
        : (this.renderer?.selectedMeasureIndex ?? 0);
      if (single >= 0 && single < state.measures.length) {
        indices = [single];
      }
    }

    if (indices.length === 0) return;

    this._editingMeasureIndices = indices;
    const isBatch = indices.length > 1;
    const firstIdx = indices[0];
    const firstM = state.measures[firstIdx];
    if (!firstM) return;

    this.dom.editMeasureIndex.value = firstIdx;

    // Configuração dos Títulos, Banners e Rótulos do Modal
    if (isBatch) {
      const count = indices.length;
      if (this.dom.modalBatchEditBanner) {
        this.dom.modalBatchEditBanner.style.display = 'flex';
      }
      if (this.dom.batchEditText) {
        this.dom.batchEditText.innerHTML = `Edição em Lote: As alterações serão aplicadas a todos os <strong>${count} compassos selecionados</strong>.`;
      }
      this.dom.modalMeasureIdx.textContent = `${count} Compassos`;
      if (this.dom.modalMeasureHeading) {
        this.dom.modalMeasureHeading.textContent = `Configurar ${count} Compassos Selecionados`;
      }
      if (this.dom.btnSaveMeasureEditText) {
        this.dom.btnSaveMeasureEditText.textContent = `Salvar em ${count} Compassos`;
      }
      if (this.dom.btnDeleteMeasureModal) {
        this.dom.btnDeleteMeasureModal.textContent = `Excluir ${count} Compassos`;
        this.dom.btnDeleteMeasureModal.title = `Excluir os ${count} compassos selecionados`;
      }
      if (this.dom.btnDuplicateMeasureModal) {
        this.dom.btnDuplicateMeasureModal.textContent = `Duplicar ${count} Compassos`;
        this.dom.btnDuplicateMeasureModal.title = `Duplicar os ${count} compassos selecionados`;
      }

      // Tratamento de apelidos para múltiplos compassos
      const allSameName = indices.every(i => (state.measures[i]?.nickname || '') === (firstM.nickname || ''));
      if (allSameName && firstM.nickname) {
        this.dom.editNickname.value = firstM.nickname;
        this.dom.editNickname.placeholder = "Apelido comum para os compassos...";
        this._nicknameDirty = false;
      } else {
        this.dom.editNickname.value = '';
        this.dom.editNickname.placeholder = "(Nomes variados • Deixe em branco para manter os atuais)";
        this._nicknameDirty = false;
      }

      // Oculta banner de bossa individual quando em lote
      if (this.dom.measureBossaBanner) {
        this.dom.measureBossaBanner.style.display = 'none';
      }
    } else {
      // Modo individual clássico
      if (this.dom.modalBatchEditBanner) {
        this.dom.modalBatchEditBanner.style.display = 'none';
      }
      this.dom.modalMeasureIdx.textContent = `c. ${firstIdx + 1}`;
      if (this.dom.modalMeasureHeading) {
        this.dom.modalMeasureHeading.textContent = `Configurar Compasso ${firstIdx + 1}`;
      }
      if (this.dom.btnSaveMeasureEditText) {
        this.dom.btnSaveMeasureEditText.textContent = 'Salvar';
      }
      if (this.dom.btnDeleteMeasureModal) {
        this.dom.btnDeleteMeasureModal.textContent = 'Excluir';
        this.dom.btnDeleteMeasureModal.title = 'Excluir este compasso';
      }
      if (this.dom.btnDuplicateMeasureModal) {
        this.dom.btnDuplicateMeasureModal.textContent = 'Duplicar';
        this.dom.btnDuplicateMeasureModal.title = 'Duplicar este compasso';
      }

      this.dom.editNickname.value = firstM.nickname || '';
      this.dom.editNickname.placeholder = 'ex: Chamada de Caixa, Clímax (opcional)';
      this._nicknameDirty = true;

      // Configura o banner de Bossa Embutida individual
      const grp = state.getGroupByMeasureIndex(firstIdx);
      if (firstM.sourcePieceId || (grp && grp.isBossaBlock)) {
        const bName = firstM.sourcePieceName || grp?.sourcePieceName || grp?.name || 'Bossa Vinculada';
        const cleanName = bName.replace(/^[🔗📦✏️🔓\s]+/, '').trim();
        if (this.dom.measureBossaBanner) this.dom.measureBossaBanner.style.display = 'flex';
        if (this.dom.bossaBannerName) this.dom.bossaBannerName.textContent = cleanName;
        if (this.dom.btnMeasureOpenBossaModal) {
          this.dom.btnMeasureOpenBossaModal.textContent = `↗️ Abrir Página de "${cleanName}"`;
          this.dom.btnMeasureOpenBossaModal.style.display = 'inline-flex';
        }
        if (this.dom.btnMeasureUnlinkModal) this.dom.btnMeasureUnlinkModal.style.display = firstM.isLinked ? 'inline-flex' : 'none';
        if (this.dom.btnMeasureRestoreModal) this.dom.btnMeasureRestoreModal.style.display = firstM.isLocallyModified ? 'inline-flex' : 'none';
      } else {
        if (this.dom.measureBossaBanner) this.dom.measureBossaBanner.style.display = 'none';
      }
    }

    // Carrega campos de métrica, repetição, andamento e cor do primeiro compasso
    this.dom.editBeats.value = firstM.beats;
    if (this.dom.editBeatUnit) this.dom.editBeatUnit.value = firstM.beatUnit || 4;
    this.dom.editRepeat.value = firstM.repeat || 1;
    if (this.dom.editRepeatVariable) this.dom.editRepeatVariable.value = firstM.repeatVariable || '';

    if (firstM.tempoMode === 'fixed') {
      this.dom.radioModeFixed.checked = true;
    } else {
      this.dom.radioModeRatio.checked = true;
    }
    this.toggleTempoModePanels();

    // Opção de andamento/modulação fica fechada por padrão
    if (this.dom.detailsTempoModulation) {
      this.dom.detailsTempoModulation.open = false;
    }

    this.dom.editRatioNum.value = firstM.ratioNum || 1;
    this.dom.editRatioDen.value = firstM.ratioDen || 1;
    this.dom.editCustomBpm.value = firstM.customBpm || state.baseBpm;
    this.dom.editColorPicker.value = firstM.color || '#ff334b';

    const curNum = firstM.ratioNum || 1;
    const curDen = firstM.ratioDen || 1;
    const ratioBtns = this.dom.modalMeasureEdit.querySelectorAll('.btn-ratio-preset, .preset-ratio-btn');
    ratioBtns.forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.num, 10) === curNum && parseInt(btn.dataset.den, 10) === curDen);
    });

    const swatches = this.dom.modalMeasureEdit.querySelectorAll('.color-swatch-btn');
    swatches.forEach(s => {
      s.classList.toggle('selected', s.dataset.color.toLowerCase() === firstM.color?.toLowerCase());
    });

    this.updateModalCalculatedBpm();
    this.dom.modalMeasureEdit.style.display = 'flex';
    this.dom.editNickname.focus();
  }

  // =========================================================================
  // MODAL DE AGRUPAMENTO DE COMPASSOS VIZINHOS
  // =========================================================================

  closeGroupModal() {
    if (this.dom.modalGroupManage) {
      this.dom.modalGroupManage.style.display = 'none';
    }
  }

  setupGroupModal() {
    const modal = this.dom.modalGroupManage;

    const openModal = () => {
      this.populateGroupSelects();
      this.renderExistingGroupsList();
      if (this.dom.newGroupRepeat) this.dom.newGroupRepeat.value = '1';
      modal.style.display = 'flex';
      this.dom.newGroupName.focus();
    };

    this.dom.btnManageGroups.addEventListener('click', openModal);
    this.dom.btnOpenGroupModal.addEventListener('click', openModal);

    this.dom.btnGroupModalClose.addEventListener('click', () => {
      this.closeGroupModal();
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) this.closeGroupModal();
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
      const repeat = parseInt(this.dom.newGroupRepeat?.value, 10) || 1;
      const repeatVariable = this.dom.newGroupRepeatVariable ? this.dom.newGroupRepeatVariable.value.trim() : null;
      const color = this.dom.newGroupColorPicker.value;

      if (!name) return;

      state.addGroup(name, color, start, end, repeat, repeatVariable);
      this.dom.newGroupName.value = '';
      if (this.dom.newGroupRepeat) this.dom.newGroupRepeat.value = '1';
      if (this.dom.newGroupRepeatVariable) this.dom.newGroupRepeatVariable.value = '';
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
            <div class="group-item-name">
              ${g.name}
              ${g.repeatVariable ? ` <span class="group-item-var-badge" style="font-size:0.7rem; background:rgba(139,92,246,0.18); color:#a78bfa; padding:2px 6px; border-radius:4px; border:1px solid rgba(139,92,246,0.3); font-weight:700;" title="Repetições controladas pela variável '${g.repeatVariable}'">🎛️ Var: [${g.repeatVariable}]</span>` : ''}
            </div>
            <div class="group-item-span">c. ${g.startMeasure + 1} até c. ${g.endMeasure + 1}</div>
          </div>
        </div>
        <div class="group-item-controls">
          <div class="group-item-repeat-wrap" title="Número de vezes que este grupo se repete">
            <span class="group-item-rep-label">Repetir:</span>
            <div class="repeat-stepper">
              <button type="button" class="btn-repeat-step btn-group-item-rep-minus" title="Diminuir repetições">-</button>
              <input type="number" class="input-card-repeat input-group-item-repeat" min="1" max="999" value="${g.repeat || 1}" title="Repetições do grupo">
              <button type="button" class="btn-repeat-step btn-group-item-rep-plus" title="Aumentar repetições">+</button>
            </div>
          </div>
          <button type="button" class="group-item-del-btn" title="Desagrupar">${iconSvg('trash-2', { size: 12 })} Excluir</button>
        </div>
      `;

      const repMinus = item.querySelector('.btn-group-item-rep-minus');
      const repPlus = item.querySelector('.btn-group-item-rep-plus');
      const repInput = item.querySelector('.input-group-item-repeat');

      const updateGroupRep = (val) => {
        const v = Math.max(1, Math.min(999, parseInt(val, 10) || 1));
        if (v !== g.repeat) {
          state.updateGroup(g.id, { repeat: v });
          this.renderExistingGroupsList();
          this.renderMeasuresList();
        }
      };

      if (repInput) {
        repInput.addEventListener('change', (e) => updateGroupRep(e.target.value));
        repInput.addEventListener('blur', (e) => updateGroupRep(e.target.value));
        repInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            repInput.blur();
          }
        });
      }

      if (repMinus) {
        repMinus.addEventListener('click', (e) => {
          e.stopPropagation();
          const cur = parseInt(repInput?.value, 10) || 1;
          if (cur > 1) updateGroupRep(cur - 1);
        });
      }

      if (repPlus) {
        repPlus.addEventListener('click', (e) => {
          e.stopPropagation();
          const cur = parseInt(repInput?.value, 10) || 1;
          if (cur < 999) updateGroupRep(cur + 1);
        });
      }

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

  refreshLibraryUi() {
    this.initPresetsDropdown();
    this.updateReturnToPreviousButton();
    if (this.currentView === 'bossas' || (this.dom.viewBossaManager && this.dom.viewBossaManager.style.display === 'flex')) {
      this.renderBossaManagerCards();
    }
    if (this.dom.modalInsertBossa && this.dom.modalInsertBossa.style.display !== 'none') {
      this.renderBossaModalList();
    }
  }

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

    // ☁️ Grupo de Peças na Nuvem (se logado) — usa o cache da última sincronização (sem request)
    const cloudPieces = collab.cloudPiecesCache;
    if (this.authService && this.authService.isLoggedIn() && cloudPieces && cloudPieces.length > 0) {
      const cloudGroup = document.createElement('optgroup');
      cloudGroup.label = '☁️ Minhas Peças & Bossas na Nuvem';
      cloudGroup.dataset.type = 'cloud';

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
      select.appendChild(cloudGroup);
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
    state.setExternalPieceResolver((pieceId, pieceName) => collab.findPiece(pieceId, pieceName));

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
      if (icon) icon.innerHTML = iconSvg('cloud', { size: 13 });
      label.textContent = text || 'Salvo';
      pill.title = 'Peça salva no seu navegador e sincronizada na nuvem';
    } else if (status === 'syncing') {
      if (icon) icon.innerHTML = iconSvg('rotate-ccw', { size: 13 });
      label.textContent = text || 'Salvando...';
      pill.title = text || 'Sincronizando com a nuvem...';
    } else if (status === 'offline') {
      if (icon) icon.innerHTML = iconSvg('save', { size: 13 });
      label.textContent = 'Salvo local';
      pill.title = 'Sem conexão com a nuvem. Alterações salvas no seu aparelho.';
    } else if (status === 'error') {
      if (icon) icon.innerHTML = iconSvg('alert-triangle', { size: 13 });
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
          this.dom.userMenuAvatarLarge.innerHTML = iconSvg('user', { size: 20 });
        }
      }
    } else {
      this.dom.btnAuth?.classList.remove('logged-in');
      if (this.dom.userAuthLabel) this.dom.userAuthLabel.textContent = 'Entrar';
      if (this.dom.userAuthAvatar) this.dom.userAuthAvatar.innerHTML = iconSvg('user', { size: 14 });
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
      if (this.dom.copyIcon) this.dom.copyIcon.innerHTML = iconSvg('check', { size: 14 });
      this.showToast("Link copiado para a área de transferência! Qualquer pessoa pode editar.", "link");

      setTimeout(() => {
        if (this.dom.copyText) this.dom.copyText.textContent = "Copiar Link";
        if (this.dom.copyIcon) this.dom.copyIcon.innerHTML = iconSvg('clipboard', { size: 14 });
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
          ${iconSvg('rotate-ccw', { size: 12 })} Restaurar
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

  showToast(message, icon = 'check') {
    const toast = this.dom.toastNotification;
    if (!toast) return;

    if (this.dom.toastIcon) {
      const toastIconMap = {
        '✓': 'check',
        '✅': 'check',
        'check': 'check',
        '✨': 'sparkles',
        '🎉': 'sparkles',
        'sparkles': 'sparkles',
        '💾': 'save',
        'save': 'save',
        '🗑️': 'trash-2',
        '✕': 'x',
        '⧉': 'copy',
        '📋': 'clipboard',
        '✂️': 'scissors',
        '🔗': 'link',
        '🔓': 'unlock',
        '🔒': 'lock',
        '↺': 'rotate-ccw',
        '🔄': 'rotate-ccw',
        '↩': 'rotate-ccw',
        '↪': 'rotate-cw',
        '↩️': 'corner-down-right',
        '⚡': 'zap',
        '✏️': 'edit-2',
        '📦': 'box',
        '🏷️': 'tag',
        '⚠️': 'alert-triangle',
        'ℹ️': 'info',
        '🔊': 'volume-2',
        '🔇': 'volume-x',
        '📡': 'wifi',
        '☁️': 'cloud-upload',
        '📲': 'radio',
        '🎧': 'headphones',
        '🍴': 'git-fork',
        '🕒': 'clock',
        '🎼': 'music',
        '📄': 'file-plus',
        '🧹': 'trash-2',
        '📁': 'folder',
        '📂': 'folder-open',
        '👋': 'sparkles'
      };
      const iconKey = toastIconMap[icon] || icon;
      const svg = iconSvg(iconKey, { size: 18, strokeWidth: 2.2 });
      if (svg) {
        this.dom.toastIcon.innerHTML = svg;
      } else {
        this.dom.toastIcon.textContent = icon;
      }
    }
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
        this.handleSyncBossas(true);
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

    // 4.1 Busca em tempo real no modal de inserção de bossa
    this.dom.inputSearchInsertBossa?.addEventListener('input', (e) => {
      this.insertBossaSearchQuery = e.target.value;
      if (this.dom.btnClearSearchInsertBossa) {
        this.dom.btnClearSearchInsertBossa.style.display = this.insertBossaSearchQuery ? 'block' : 'none';
      }
      this.renderBossaModalList();
    });

    this.dom.btnClearSearchInsertBossa?.addEventListener('click', () => {
      if (this.dom.inputSearchInsertBossa) this.dom.inputSearchInsertBossa.value = '';
      this.insertBossaSearchQuery = '';
      if (this.dom.btnClearSearchInsertBossa) this.dom.btnClearSearchInsertBossa.style.display = 'none';
      this.renderBossaModalList();
      this.dom.inputSearchInsertBossa?.focus();
    });

    this.dom.inputSearchInsertBossa?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.insertBossaSearchQuery) {
        e.stopPropagation();
        if (this.dom.inputSearchInsertBossa) this.dom.inputSearchInsertBossa.value = '';
        this.insertBossaSearchQuery = '';
        if (this.dom.btnClearSearchInsertBossa) this.dom.btnClearSearchInsertBossa.style.display = 'none';
        this.renderBossaModalList();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this.selectedBossaPiece && this.dom.btnConfirmInsertBossa && !this.dom.btnConfirmInsertBossa.disabled) {
          this.handleConfirmInsertBossa();
        } else {
          const firstCard = this.dom.bossaListContainer?.querySelector('.bossa-card-item');
          if (firstCard) {
            firstCard.click();
          }
        }
      }
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

    const previewEl = this.dom.modalInsertBossa?.querySelector('#bossaSelectedPreview');
    if (previewEl) {
      previewEl.style.display = 'none';
      previewEl.innerHTML = '';
    }

    // Limpa campo e estado da busca ao abrir
    if (this.dom.inputSearchInsertBossa) {
      this.dom.inputSearchInsertBossa.value = '';
    }
    this.insertBossaSearchQuery = '';
    if (this.dom.btnClearSearchInsertBossa) {
      this.dom.btnClearSearchInsertBossa.style.display = 'none';
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
    setTimeout(() => {
      this.dom.inputSearchInsertBossa?.focus();
    }, 60);
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
            <span class="bossa-empty-icon">${iconSvg('folder-open', { size: 36 })}</span>
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
            <span class="bossa-empty-icon">${iconSvg('sparkles', { size: 36 })}</span>
            <h4>Nenhum modelo disponível</h4>
            <p>Você removeu os modelos de exemplo do seu repertório. Você pode restaurá-los na página de Repertório se desejar.</p>
          </div>
        `;
        return;
      }
    }

    // Filtragem de busca por texto em tempo real
    const query = (this.insertBossaSearchQuery || '').trim().toLowerCase();
    if (query) {
      pieces = pieces.filter(p => {
        const nameMatch = (p.name || '').toLowerCase().includes(query);
        const descMatch = (p.description || '').toLowerCase().includes(query);
        const bpm = String(p.presentationBpm || p.baseBpm || '');
        const bpmMatch = bpm.includes(query);
        const countMatch = `${p.measures?.length || 0} compassos`.toLowerCase().includes(query);

        const cleanPName = (p.name || '').replace(/^[🔗📦✏️🔓\s]+/, '').trim().toLowerCase();
        const isInPiece = (state.items || []).some(it => {
          if (it.type !== 'bossa') return false;
          if (p.id && it.sourcePieceId && it.sourcePieceId === p.id) return true;
          const itCleanName = (it.sourcePieceName || it.name || '').replace(/^[🔗📦✏️🔓\s]+/, '').trim().toLowerCase();
          return Boolean(cleanPName && itCleanName === cleanPName);
        });
        const inPieceMatch = isInPiece && ('já na peça na peca presente'.includes(query));

        return nameMatch || descMatch || bpmMatch || countMatch || inPieceMatch;
      });

      if (pieces.length === 0) {
        container.innerHTML = `
          <div class="bossa-empty-state" style="padding: 24px 16px;">
            <span class="bossa-empty-icon">${iconSvg('search', { size: 32 })}</span>
            <h4>Nenhuma bossa encontrada</h4>
            <p>Nenhum resultado corresponde a "<strong>${escapeHtml(this.insertBossaSearchQuery.trim())}</strong>".</p>
            <button type="button" class="btn-card-action insert btn-clear-modal-search" style="margin-top: 10px; align-self: center; display: inline-flex; align-items: center; gap: 6px;">
              <span class="btn-icon">${iconSvg('rotate-ccw', { size: 13 })}</span> Limpar Busca
            </button>
          </div>
        `;
        container.querySelector('.btn-clear-modal-search')?.addEventListener('click', () => {
          if (this.dom.inputSearchInsertBossa) this.dom.inputSearchInsertBossa.value = '';
          this.insertBossaSearchQuery = '';
          if (this.dom.btnClearSearchInsertBossa) this.dom.btnClearSearchInsertBossa.style.display = 'none';
          this.renderBossaModalList();
          this.dom.inputSearchInsertBossa?.focus();
        });
        return;
      }
    }

    pieces.forEach(p => {
      // Verifica se esta bossa já faz parte da peça aberta (por ID ou nome limpo)
      const cleanPName = (p.name || '').replace(/^[🔗📦✏️🔓\s]+/, '').trim().toLowerCase();
      let countInPiece = 0;

      (state.items || []).forEach(it => {
        if (it.type !== 'bossa') return;
        if (p.id && it.sourcePieceId && it.sourcePieceId === p.id) {
          countInPiece++;
          return;
        }
        const itCleanName = (it.sourcePieceName || it.name || '').replace(/^[🔗📦✏️🔓\s]+/, '').trim().toLowerCase();
        if (cleanPName && itCleanName && itCleanName === cleanPName) {
          countInPiece++;
        }
      });

      if (countInPiece === 0) {
        const foundInGroups = (state.groups || []).filter(g => {
          if (p.id && g.sourcePieceId && g.sourcePieceId === p.id) return true;
          const gCleanName = (g.sourcePieceName || g.name || '').replace(/^[🔗📦✏️🔓\s]+/, '').trim().toLowerCase();
          return Boolean(cleanPName && gCleanName && gCleanName === cleanPName);
        }).length;

        if (foundInGroups > 0) {
          countInPiece = foundInGroups;
        } else {
          const foundInMs = (state.measures || []).some(m => {
            if (p.id && m.sourcePieceId && m.sourcePieceId === p.id) return true;
            const mCleanName = (m.sourcePieceName || '').replace(/^[🔗📦✏️🔓\s]+/, '').trim().toLowerCase();
            return Boolean(cleanPName && mCleanName && mCleanName === cleanPName);
          });
          if (foundInMs) countInPiece = 1;
        }
      }

      const isAlreadyInPiece = countInPiece > 0;
      const inPieceBadgeHtml = isAlreadyInPiece
        ? `<span class="bossa-card-in-piece-badge" title="Esta bossa já está inserida nesta peça (${countInPiece === 1 ? '1 vez' : `${countInPiece} vezes`})">${iconSvg('check-circle', { size: 12 })} Já na peça${countInPiece > 1 ? ` (${countInPiece}×)` : ''}</span>`
        : '';

      const card = document.createElement('div');
      card.className = 'bossa-card-item' + (isAlreadyInPiece ? ' is-already-in-piece' : '');
      if (this.selectedBossaPiece?.id === p.id) {
        card.classList.add('selected');
      }

      const measureCount = Array.isArray(p.measures) ? p.measures.length : 0;
      const bpm = p.presentationBpm || p.baseBpm || 120;
      const { totalDuration: modalDuration } = state.calculateTimingsForMeasures(p.measures, bpm);
      const modalDurationStr = this.formatFriendlyDuration(modalDuration);

      const pieceBpm = state.baseBpm || bpm;
      const hasDifferentBpm = Math.abs(pieceBpm - bpm) >= 2;
      const { totalDuration: pieceDuration } = state.calculateTimingsForMeasures(p.measures, pieceBpm);
      const pieceDurationStr = this.formatFriendlyDuration(pieceDuration);

      const isPresetBossa = p.id?.startsWith('bossa-') || Boolean(p.isBossa && PRESETS.some(pr => pr.id === p.id));
      const isCloudBossa = Boolean(p.ownerId);
      const badgeIcon = isPresetBossa ? iconSvg('sparkles', { size: 12 }) : (p.isBossa ? iconSvg('drum', { size: 12 }) : iconSvg('music', { size: 12 }));
      const cloudIcon = isCloudBossa ? ` ${iconSvg('cloud', { size: 12 })}` : '';
      const badgeLabel = isPresetBossa ? 'Modelo' : (p.isBossa ? 'Bossa' : 'Peça');
      const badgeHtml = `<span style="display:inline-flex; align-items:center; gap:4px;">${badgeIcon} ${badgeLabel}${cloudIcon}</span>`;

      card.innerHTML = `
        <div class="bossa-card-item-header">
          <div class="bossa-card-title-group">
            <span class="bossa-card-badge">${badgeHtml}</span>
            <strong class="bossa-card-title">${escapeHtml(p.name || 'Sem título')}</strong>
            ${inPieceBadgeHtml}
          </div>
          <div class="bossa-card-time-pill" title="Duração total da bossa: ${modalDurationStr} (${bpm} BPM)">
            <span class="bossa-time-icon">${iconSvg('clock', { size: 13 })}</span>
            <span class="bossa-time-text">${modalDurationStr}</span>
          </div>
        </div>
        <div class="bossa-card-info-row">
          <span class="bossa-card-info-item"><strong>${measureCount}</strong> ${measureCount === 1 ? 'compasso' : 'compassos'}</span>
          <span class="bossa-card-info-dot">•</span>
          <span class="bossa-card-info-item"><strong>${bpm}</strong> BPM</span>
          ${hasDifferentBpm ? `
            <span class="bossa-card-info-dot">•</span>
            <span class="bossa-card-info-item piece-speed" title="Duração estimada no andamento desta peça (${pieceBpm} BPM)" style="display:inline-flex; align-items:center; gap:4px;">
              ${iconSvg('clock', { size: 12 })} <strong>${pieceDurationStr}</strong> no andamento da peça (${pieceBpm} BPM)
            </span>
          ` : ''}
        </div>
        ${p.description ? `<p class="bossa-card-desc">${escapeHtml(p.description)}</p>` : ''}
      `;

      const selectThis = () => {
        container.querySelectorAll('.bossa-card-item').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        this.selectedBossaPiece = p;
        if (this.dom.btnConfirmInsertBossa) {
          this.dom.btnConfirmInsertBossa.disabled = false;
        }

        const previewEl = this.dom.modalInsertBossa?.querySelector('#bossaSelectedPreview');
        if (previewEl) {
          previewEl.style.display = 'flex';
          const inPieceNoticeHtml = isAlreadyInPiece
            ? `<div class="bossa-preview-in-piece-note">
                 ${iconSvg('check-circle', { size: 13 })} <strong>Já na peça</strong> (${countInPiece === 1 ? '1 bloco presente' : `${countInPiece} blocos presentes`}). Você pode inserir uma nova ocorrência se desejar.
               </div>`
            : '';

          previewEl.innerHTML = `
            <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; width:100%;">
              <span class="bossa-preview-badge">Selecionada</span>
              <strong class="bossa-preview-name">${escapeHtml(p.name || 'Bossa')}</strong>
              ${inPieceBadgeHtml}
            </div>
            <span class="bossa-preview-meta" style="display:inline-flex; align-items:center; gap:4px;">
              • <strong>${measureCount}</strong> comp. • ${iconSvg('clock', { size: 12 })} Tempo: <strong>${modalDurationStr}</strong> (${bpm} BPM)${hasDifferentBpm ? ` • ${iconSvg('clock', { size: 12 })} <strong>${pieceDurationStr}</strong> no andamento da peça (${pieceBpm} BPM)` : ''}
            </span>
            ${inPieceNoticeHtml}
          `;
        }
      };

      card.addEventListener('click', selectThis);

      card.addEventListener('dblclick', () => {
        selectThis();
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
      // Clique manual (showToastNotice) força sincronização; automáticas respeitam o throttle
      await collab.syncUserLibraryWithCloud(state, { force: showToastNotice });
      this.updateBossaManagerSyncIndicator('idle', 'Sincronizado automaticamente');
      if (showToastNotice) {
        this.refreshLibraryUi();
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
          <span class="bossa-empty-icon">${isPresetTab ? iconSvg('sparkles', { size: 36 }) : iconSvg('library', { size: 36 })}</span>
          <h4>${isPresetTab ? 'Nenhum modelo de exemplo' : 'Nenhum item encontrado'}</h4>
          <p>${isPresetTab 
            ? (hasHiddenPresets ? 'Você removeu os modelos do seu repertório.' : 'Não há modelos disponíveis.')
            : 'Você pode criar novas peças ou bossas usando o botão "+ Nova Peça em Branco" ou importar um arquivo .json.'}
          </p>
          ${isPresetTab && hasHiddenPresets ? `
            <button type="button" class="btn-card-action insert btn-empty-restore" style="margin-top:12px;">
              <span class="btn-icon">${iconSvg('rotate-ccw', { size: 14 })}</span> Restaurar Modelos Padrão
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
        badgesHtml += `<span class="bossa-origin-badge preset">${iconSvg('sparkles', { size: 11 })} Modelo</span>`;
      } else if (isBossa) {
        badgesHtml += isCloud
          ? `<span class="bossa-origin-badge cloud">${iconSvg('cloud', { size: 11 })} Bossa</span>`
          : `<span class="bossa-origin-badge local">${iconSvg('drum', { size: 11 })} Bossa Local</span>`;
      } else {
        badgesHtml += isCloud
          ? `<span class="bossa-origin-badge cloud">${iconSvg('cloud', { size: 11 })} Peça</span>`
          : `<span class="bossa-origin-badge local">${iconSvg('file-text', { size: 11 })} Minha Peça</span>`;
      }

      if (isCurrentOpen) {
        badgesHtml += ` <span class="bossa-origin-badge" style="background:rgba(16, 185, 129, 0.2); color:#34d399; border:1px solid rgba(16,185,129,0.4);">${iconSvg('play', { size: 10, className: 'fill-current' })} Aberta</span>`;
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
            <span title="Tempo total: ${durationStr}">${iconSvg('clock', { size: 12 })} <strong>${durationStr}</strong></span>
          </div>
        </div>

        ${item.description ? `<p class="bossa-card-desc">${escapeHtml(item.description)}</p>` : ''}

        <div class="bossa-card-actions">
          <div class="bossa-actions-left">
            <button type="button" class="btn-card-action preview ${isPlaying ? 'playing' : ''}" data-action="preview" data-id="${item.id}" title="Ouvir o áudio sintetizado">
              <span class="btn-icon">${isPlaying ? iconSvg('square', { size: 13, className: 'fill-current' }) : iconSvg('play', { size: 13, className: 'fill-current' })}</span> ${isPlaying ? 'Parar' : 'Ouvir Prévia'}
            </button>
            <button type="button" class="btn-card-action insert" data-action="insert" data-id="${item.id}" title="Inserir estes compassos na peça atual">
              <span class="btn-icon">${iconSvg('link', { size: 13 })}</span> Inserir na Peça
            </button>
            <button type="button" class="btn-card-action open" data-action="open" data-id="${item.id}" title="Abrir no simulador para tocar ou editar">
              <span class="btn-icon">${iconSvg('folder-open', { size: 13 })}</span> Abrir ${isBossa ? 'Bossa' : 'Peça'}
            </button>
          </div>
          <div class="bossa-actions-right">
            ${!isPreset ? `
              <button type="button" class="btn-card-action toggle-type" data-action="toggle-type" data-id="${item.id}" title="${isBossa ? 'Transformar em Peça Completa (mover para Minhas Peças)' : 'Transformar em Bossa / Paradinha (mover para Minhas Bossas)'}">
                <span class="btn-icon">${iconSvg('rotate-ccw', { size: 13 })}</span> ${isBossa ? 'Virar Peça' : 'Virar Bossa'}
              </button>
              <button type="button" class="btn-card-action icon-only" data-action="rename" data-id="${item.id}" title="Renomear">
                ${iconSvg('pencil', { size: 14 })}
              </button>
            ` : ''}
            <button type="button" class="btn-card-action icon-only" data-action="export" data-id="${item.id}" title="Exportar como JSON">
              ${iconSvg('download', { size: 14 })}
            </button>
            <button type="button" class="btn-card-action icon-only danger" data-action="delete" data-id="${item.id}" title="${isPreset ? 'Remover este modelo do repertório' : 'Apagar definitivamente da biblioteca e da nuvem'}">
              ${iconSvg('trash-2', { size: 14 })}
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
    this.updateReturnToPreviousButton();
    const isBossa = bossa.isBossa !== undefined ? Boolean(bossa.isBossa) : Boolean(bossa.id?.startsWith('piece-bossa-') || bossa.id?.startsWith('bossa-'));
    this.showToast(`${isBossa ? 'Bossa' : 'Peça'} '${bossa.name}' aberta para edição!`, '📂');
  }

  updateReturnToPreviousButton() {
    if (!this.dom.btnReturnToPreviousPiece) return;
    if (this.previousPieceContext && this.previousPieceContext.id && this.previousPieceContext.id !== state.id) {
      this.dom.btnReturnToPreviousPiece.style.display = 'inline-flex';
      if (this.dom.returnPieceName) {
        this.dom.returnPieceName.textContent = this.previousPieceContext.name || 'Peça';
      }
    } else {
      this.dom.btnReturnToPreviousPiece.style.display = 'none';
    }
  }

  navigateToBossaOrPiece(pieceId, pieceName, groupContext = null) {
    if (!pieceId && !pieceName) return;

    // Salva a peça atual na biblioteca antes de alternar e guarda contexto para retorno
    if (state.measures && state.measures.length > 0) {
      state.saveCurrentPieceToLibrary();
      this.previousPieceContext = {
        id: state.id,
        name: state.name || 'Peça Anterior',
        isBossa: Boolean(state.isBossa)
      };
    }

    this.pausePlayback();
    this.closeMeasureToolbar();
    this.closeMeasureModal();

    // 1. Tenta buscar no state
    let target = state.findBossaOrPiece ? state.findBossaOrPiece(pieceId, pieceName) : null;

    // 2. Se não encontrou e temos contexto de grupo, sintetiza e salva na biblioteca
    if (!target && groupContext && state.measures) {
      const start = Math.max(0, groupContext.startMeasure);
      const end = Math.min(state.measures.length - 1, groupContext.endMeasure);
      if (end >= start) {
        const sliceMeasures = state.measures.slice(start, end + 1).map((m, mi) => ({
          beats: m.beats || 4,
          beatUnit: m.beatUnit || 4,
          tempoMode: m.tempoMode || 'ratio',
          ratioNum: m.ratioNum || 1,
          ratioDen: m.ratioDen || 1,
          customBpm: m.customBpm || state.baseBpm,
          repeat: m.repeat || 1,
          color: m.color || '#8b5cf6',
          nickname: m.nickname || '',
          id: m.sourceMeasureId || `m-bossa-${Date.now()}-${mi}`
        }));

        const cleanName = (pieceName || groupContext.sourcePieceName || groupContext.name || 'Bossa').replace(/^[🔗📦✏️🔓\s]+/, '').trim();
        target = {
          id: pieceId || `piece-bossa-${Date.now()}`,
          name: cleanName,
          isBossa: true,
          baseBpm: state.baseBpm,
          measures: sliceMeasures,
          updatedAt: Date.now()
        };
        if (state.saveItemToLibrary) {
          state.saveItemToLibrary(target);
        }
      }
    }

    if (!target) {
      this.showToast(`Não foi possível encontrar a bossa '${pieceName || pieceId}' na biblioteca.`, '⚠️');
      return;
    }

    this.handleOpenBossaAsPiece(target);
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
