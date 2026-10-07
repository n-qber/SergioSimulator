/**
 * Serviço de Colaboração em Tempo Real & Histórico na Nuvem (Firebase Firestore)
 * Sincronização multiusuário estilo Google Docs, links compartilháveis e histórico de até 200 alterações.
 */

import { db } from './firebase.js';
import { 
  doc, 
  setDoc, 
  getDoc, 
  onSnapshot, 
  collection, 
  query, 
  orderBy, 
  limit, 
  deleteDoc,
  getDocs,
  where
} from 'firebase/firestore';
import { authService } from './auth.js';

const MAX_HISTORY_ITEMS = 500;
const USER_PROFILE_KEY = 'sergio_collab_profile';

export const DEFAULT_AVATAR_COLORS = [
  '#FF334B', '#3B82F6', '#10B981', '#8B5CF6', 
  '#F59E0B', '#EC4899', '#06B6D4', '#14B8A6'
];

const DEFAULT_NAMES = [
  'Percussionista Carmim', 'Mestre de Caixa', 'Baterista Azul', 
  'Marimbista Ouro', 'Timpanista Safira', 'Vibratonista Neon',
  'Ritmo Verde', 'Solista Rubin'
];

class CollabService {
  constructor() {
    this.currentPieceId = null;
    this.currentPieceOwnerId = null;
    this.currentPieceAccess = 'edit_link'; // 'private' | 'view_link' | 'edit_link'
    this.isReadOnly = false;
    this.isPrivateAccessDenied = false;

    this.localUser = this.loadLocalProfile();
    this.activeCollaborators = [];
    this.historyList = [];
    
    // Listeners desinscrever
    this.unsubPiece = null;
    this.unsubHistory = null;
    this.unsubPresence = null;
    this.unsubUserLibrary = null;
    this.heartbeatTimer = null;
    
    // Callbacks da aplicação
    this.onRemoteStateChange = null;
    this.onHistoryChange = null;
    this.onPresenceChange = null;
    this.onSyncStatusChange = null;
    this.onPermissionChange = null;
    this.onAccessDenied = null;

    // Flag para evitar eco de alterações locais e loops infinitos
    this.isApplyingRemote = false;
    this.lastSentPayloadHash = null;
    this.lastCommittedContentHash = null;
    this.pendingCommitTimer = null;
    this.isSyncingLibrary = false;
    this.librarySyncDebounce = null;

    // Integração automática com o Auth
    authService.onUserChange((user, isLoggedIn) => {
      if (isLoggedIn && user) {
        this.localUser.id = user.uid;
        this.localUser.name = user.displayName || user.email?.split('@')[0] || this.localUser.name;
        this.localUser.photoURL = user.photoURL || null;
        this.localUser.isCustomized = true;
      } else {
        const local = this.loadLocalProfile();
        this.localUser.id = local.id;
        this.localUser.name = local.name;
        this.localUser.color = local.color;
        this.localUser.photoURL = null;
      }
      this.evaluateCurrentPermissions();
      if (this.currentPieceId && db) {
        this.sendPresenceHeartbeat();
      }
    });
  }

  // Avalia permissões da peça atual com base no usuário e tipo de acesso
  evaluateCurrentPermissions() {
    if (!this.currentPieceId) {
      this.isReadOnly = false;
      this.isPrivateAccessDenied = false;
      return;
    }

    const currentUid = authService.getUid();
    // Apenas usuário autenticado correspondente ao ownerId pode ser proprietário
    const isOwner = Boolean(
      this.currentPieceOwnerId && currentUid && this.currentPieceOwnerId === currentUid
    );

    if (this.currentPieceAccess === 'private') {
      if (!isOwner) {
        this.isPrivateAccessDenied = true;
        this.isReadOnly = true;
      } else {
        this.isPrivateAccessDenied = false;
        this.isReadOnly = false;
      }
    } else if (this.currentPieceAccess === 'view_link') {
      this.isPrivateAccessDenied = false;
      this.isReadOnly = !isOwner;
    } else {
      // edit_link ou legado
      this.isPrivateAccessDenied = false;
      this.isReadOnly = false;
    }

    if (this.isPrivateAccessDenied) {
      this.clearUrlPieceId();
      if (this.onAccessDenied) {
        this.onAccessDenied({ pieceId: this.currentPieceId });
      }
    }

    if (this.onPermissionChange) {
      this.onPermissionChange({
        isReadOnly: this.isReadOnly,
        isPrivateAccessDenied: this.isPrivateAccessDenied,
        access: this.currentPieceAccess,
        isOwner
      });
    }
  }

  // Carrega ou cria perfil de colaborador local
  loadLocalProfile() {
    try {
      const saved = localStorage.getItem(USER_PROFILE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.id && parsed.name && parsed.color) {
          const isExplicitlySaved = localStorage.getItem('sergio_collab_profile_saved') === 'true';
          const isCustom = Boolean(parsed.isCustomized || isExplicitlySaved || !DEFAULT_NAMES.includes(parsed.name));
          return {
            id: parsed.id,
            name: parsed.name,
            color: parsed.color,
            isCustomized: isCustom
          };
        }
      }
    } catch (_) {}

    const randomColor = DEFAULT_AVATAR_COLORS[Math.floor(Math.random() * DEFAULT_AVATAR_COLORS.length)];
    const randomName = DEFAULT_NAMES[Math.floor(Math.random() * DEFAULT_NAMES.length)];
    const profile = {
      id: `user-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      name: randomName,
      color: randomColor,
      isCustomized: false
    };

    try {
      localStorage.setItem(USER_PROFILE_KEY, JSON.stringify(profile));
    } catch (_) {}

    return profile;
  }

  // Verifica se o usuário já personalizou e salvou seu nome e cor
  hasCustomProfile() {
    try {
      if (localStorage.getItem('sergio_collab_profile_saved') === 'true') return true;
      if (this.localUser && this.localUser.isCustomized) return true;
      const saved = localStorage.getItem(USER_PROFILE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.isCustomized) return true;
        if (parsed.name && !DEFAULT_NAMES.includes(parsed.name)) return true;
      }
    } catch (_) {}
    return false;
  }

  // Atualiza nome e cor do usuário e persiste no localStorage
  updateProfile(name, color) {
    this.localUser.name = (name || '').trim() || this.localUser.name;
    this.localUser.color = color || this.localUser.color;
    this.localUser.isCustomized = true;
    try {
      localStorage.setItem(USER_PROFILE_KEY, JSON.stringify(this.localUser));
      localStorage.setItem('sergio_collab_profile_saved', 'true');
    } catch (_) {}

    // Notifica presença atualizada se conectado
    if (this.currentPieceId && db) {
      this.sendPresenceHeartbeat();
    }
  }

  // Lê ID da peça a partir da URL (?piece=ID ou ?p=ID ou ?room=ID ou hash)
  getPieceIdFromUrl() {
    if (typeof window === 'undefined') return null;
    const urlParams = new URLSearchParams(window.location.search);
    const pieceId = urlParams.get('piece') || urlParams.get('p') || urlParams.get('room');
    if (pieceId && pieceId.trim()) return pieceId.trim();

    if (window.location.hash.startsWith('#piece=')) {
      return window.location.hash.replace('#piece=', '').trim();
    }
    if (window.location.hash.startsWith('#p=')) {
      return window.location.hash.replace('#p=', '').trim();
    }
    return null;
  }

  // Define ID da peça na URL sem recarregar a página
  updateUrlPieceId(pieceId) {
    if (typeof window === 'undefined' || !window.history || !pieceId) return;
    const url = new URL(window.location.href);
    url.searchParams.set('piece', pieceId);
    url.searchParams.delete('p');
    url.searchParams.delete('room');
    window.history.replaceState({}, '', url.toString());
  }

  // Remove ID da peça da URL mantendo o endereço limpo sem parâmetro de peça inacessível
  clearUrlPieceId() {
    if (typeof window === 'undefined' || !window.history) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('piece');
    url.searchParams.delete('p');
    url.searchParams.delete('room');
    if (window.location.hash.startsWith('#piece=') || window.location.hash.startsWith('#p=')) {
      window.location.hash = '';
    }
    const cleanSearch = url.searchParams.toString();
    const cleanUrl = url.pathname + (cleanSearch ? `?${cleanSearch}` : '') + (url.hash && !url.hash.includes('piece') && !url.hash.includes('p=') ? url.hash : '');
    window.history.replaceState({}, '', cleanUrl || '/');
  }

  // Gera link compartilhável para a peça atual
  getShareableLink(pieceId = this.currentPieceId) {
    if (typeof window === 'undefined') return '';
    const url = new URL(window.location.origin + window.location.pathname);
    url.searchParams.set('piece', pieceId);
    return url.toString();
  }

  // Conecta e sincroniza uma peça em tempo real
  async connectToPiece(pieceId, currentStateSnapshot = null) {
    if (!db) {
      console.warn("Firebase Firestore não inicializado.");
      this.setSyncStatus('offline', 'Sem conexão com a nuvem');
      return false;
    }

    if (this.currentPieceId === pieceId && this.unsubPiece) {
      return true; // Já conectado
    }

    this.disconnect();
    this.setSyncStatus('syncing', 'Conectando à nuvem...');

    try {
      const pieceRef = doc(db, 'pieces', pieceId);
      const pieceSnap = await getDoc(pieceRef);

      const currentUid = authService.getUid();

      // Se a peça ainda não existe no Firestore, criamos a partir do estado atual
      if (!pieceSnap.exists()) {
        const initialAccess = currentStateSnapshot?.access || (authService.isLoggedIn() ? 'private' : 'edit_link');
        const initialData = currentStateSnapshot ? {
          id: pieceId,
          name: currentStateSnapshot.name || "Nova Peça Colaborativa",
          description: currentStateSnapshot.description || "",
          baseBpm: currentStateSnapshot.presentationBpm || currentStateSnapshot.baseBpm || 120,
          presentationBpm: currentStateSnapshot.presentationBpm || currentStateSnapshot.baseBpm || 120,
          measures: currentStateSnapshot.measures || [],
          groups: currentStateSnapshot.groups || [],
          ownerId: currentUid,
          ownerName: authService.getDisplayName(),
          access: initialAccess,
          updatedAt: Date.now(),
          updatedBy: this.localUser,
          lastAction: "Peça criada na nuvem"
        } : {
          id: pieceId,
          name: "Nova Peça Colaborativa",
          description: "",
          baseBpm: 120,
          measures: [],
          groups: [],
          ownerId: currentUid,
          ownerName: authService.getDisplayName(),
          access: initialAccess,
          updatedAt: Date.now(),
          updatedBy: this.localUser,
          lastAction: "Peça criada na nuvem"
        };

        this.currentPieceId = pieceId;
        this.currentPieceOwnerId = currentUid;
        this.currentPieceAccess = initialAccess;
        this.evaluateCurrentPermissions();

        this.lastCommittedContentHash = this.computeContentHash(initialData);
        await setDoc(pieceRef, initialData);
        // Cria primeira entrada no histórico
        await this.addHistoryEntry(pieceId, "Peça inicializada na nuvem", initialData);
        this.updateUrlPieceId(pieceId);
      } else {
        // Carrega dados iniciais do Firestore para o app local
        const data = pieceSnap.data();
        this.currentPieceOwnerId = data.ownerId || null;
        this.currentPieceAccess = data.access || 'edit_link';
        this.evaluateCurrentPermissions();

        if (this.isPrivateAccessDenied) {
          this.setSyncStatus('error', 'Peça Privada: Acesso Restrito');
          this.clearUrlPieceId();
          this.currentPieceId = null;
          if (this.onAccessDenied) {
            this.onAccessDenied({ pieceId, name: data.name, ownerName: data.ownerName || 'o autor' });
          }
          return false;
        }

        this.currentPieceId = pieceId;
        this.updateUrlPieceId(pieceId);
        this.lastCommittedContentHash = this.computeContentHash(data);

        if (this.onRemoteStateChange) {
          this.isApplyingRemote = true;
          this.onRemoteStateChange(data);
          this.isApplyingRemote = false;
        }
      }

      // 1. OUVINTE EM TEMPO REAL: Alterações da peça
      this.unsubPiece = onSnapshot(pieceRef, (snap) => {
        if (!snap.exists()) return;
        const remoteData = snap.data();

        this.currentPieceOwnerId = remoteData.ownerId || null;
        this.currentPieceAccess = remoteData.access || 'edit_link';
        this.evaluateCurrentPermissions();

        if (this.isPrivateAccessDenied) {
          this.clearUrlPieceId();
          this.currentPieceId = null;
          if (this.onAccessDenied) {
            this.onAccessDenied({ pieceId, name: remoteData.name, ownerName: remoteData.ownerName || 'o autor' });
          }
          return;
        }
        
        // Evita reprocessar se foi a própria aba que enviou
        if (remoteData.updatedBy?.id === this.localUser.id) {
          this.setSyncStatus('synced', 'Salvo na nuvem');
          return;
        }

        const remoteHash = this.computeContentHash(remoteData);
        if (remoteHash && remoteHash === this.lastCommittedContentHash) {
          return;
        }
        this.lastCommittedContentHash = remoteHash;

        this.setSyncStatus('syncing', `${remoteData.updatedBy?.name || 'Alguém'} fez uma alteração`);
        
        if (this.onRemoteStateChange) {
          this.isApplyingRemote = true;
          try {
            this.onRemoteStateChange(remoteData);
          } finally {
            this.isApplyingRemote = false;
          }
        }

        setTimeout(() => {
          this.setSyncStatus('synced', 'Sincronizado');
        }, 800);
      }, (err) => {
        console.error("Erro no listener da peça Firestore:", err);
        const isPerm = err.code === 'permission-denied' || (err.message && err.message.toLowerCase().includes('permission'));
        if (isPerm) {
          this.isPrivateAccessDenied = true;
          this.setSyncStatus('error', 'Peça Privada: Acesso Restrito');
          this.clearUrlPieceId();
          this.currentPieceId = null;
          if (this.onAccessDenied) {
            this.onAccessDenied({ pieceId, name: 'Peça Privada', ownerName: 'o autor' });
          }
        } else {
          this.setSyncStatus('error', 'Erro de conexão');
        }
      });

      // 2. Histórico agora é carregado sob demanda (evita centenas de leituras no Firestore a cada reload)
      this.historyList = [];

      // 3. OUVINTE EM TEMPO REAL: Presença de colaboradores
      this.setupPresence(pieceId);

      this.setSyncStatus('synced', this.isReadOnly ? 'Conectado (Modo Ouvinte)' : 'Conectado em tempo real');
      return true;
    } catch (err) {
      console.error("Erro ao conectar à peça:", err);
      const isPerm = err.code === 'permission-denied' || (err.message && err.message.toLowerCase().includes('permission'));
      this.clearUrlPieceId();
      this.currentPieceId = null;
      if (isPerm) {
        this.isPrivateAccessDenied = true;
        this.setSyncStatus('error', 'Peça Privada: Acesso Restrito');
        if (this.onAccessDenied) {
          this.onAccessDenied({ pieceId, name: 'Peça Privada', ownerName: 'o autor' });
        }
      } else {
        this.setSyncStatus('error', 'Falha ao sincronizar');
      }
      return false;
    }
  }

  // Envia alteração local para o Firestore (com debounce inteligente para evitar spam e loops)
  commitLocalChange(actionDescription, stateData) {
    if (!db || !this.currentPieceId || this.isApplyingRemote) return;
    if (this.isReadOnly) {
      console.warn("Alteração local não enviada: peça está em Modo Ouvinte (Apenas Leitura).");
      return;
    }

    // Se o conteúdo real da partitura for exatamente idêntico ao já sincronizado, evita qualquer envio
    const contentHash = this.computeContentHash(stateData);
    if (contentHash && contentHash === this.lastCommittedContentHash) {
      return;
    }

    this.setSyncStatus('syncing', 'Salvando na nuvem...');
    clearTimeout(this.pendingCommitTimer);

    this.pendingCommitTimer = setTimeout(async () => {
      try {
        const freshHash = this.computeContentHash(stateData);
        if (freshHash && freshHash === this.lastCommittedContentHash) {
          this.setSyncStatus('synced', 'Salvo na nuvem');
          return;
        }

        const pieceRef = doc(db, 'pieces', this.currentPieceId);
        const payload = {
          id: this.currentPieceId,
          name: stateData.name,
          description: stateData.description || "",
          baseBpm: stateData.presentationBpm || stateData.baseBpm,
          presentationBpm: stateData.presentationBpm || stateData.baseBpm,
          ownerId: this.currentPieceOwnerId || authService.getUid() || null,
          ownerName: authService.getDisplayName(),
          access: this.currentPieceAccess || 'edit_link',
          items: (stateData.items || []).map(it => {
            if (it.type === 'bossa') {
              return {
                type: 'bossa',
                id: it.id,
                name: (it.name || it.sourcePieceName || 'Bossa').replace(/^[🔗📦✏️🔓\s]+/, '').trim(),
                color: it.color || '#8b5cf6',
                repeat: Math.max(1, Math.min(999, parseInt(it.repeat, 10) || 1)),
                collapsed: it.collapsed !== undefined ? Boolean(it.collapsed) : true,
                isLinked: Boolean(it.isLinked),
                tempoMode: it.tempoMode || 'inherit',
                bpm: it.bpm ? Number(it.bpm) : null,
                ratioNum: it.ratioNum ? Number(it.ratioNum) : 1,
                ratioDen: it.ratioDen ? Number(it.ratioDen) : 1,
                sourcePieceId: it.sourcePieceId || null,
                sourcePieceName: it.sourcePieceName || it.name || 'Bossa',
                measures: (it.measures && it.measures.length > 0)
                  ? it.measures
                  : (stateData.getBossaMeasures ? stateData.getBossaMeasures(it) : []),
                groups: Array.isArray(it.groups) ? it.groups : [],
                variables: Array.isArray(it.variables) ? it.variables : [],
                variableValues: it.variableValues || {}
              };
            }
            if (it.type === 'section') {
              return {
                type: 'section',
                id: it.id,
                name: (it.name || 'Seção').trim(),
                color: it.color || '#3b82f6',
                repeat: Math.max(1, Math.min(999, parseInt(it.repeat, 10) || 1)),
                repeatVariable: it.repeatVariable ? String(it.repeatVariable).trim() : null
              };
            }
            return {
              type: 'measure',
              id: it.id,
              nickname: it.nickname || "",
              beats: it.beats,
              beatUnit: it.beatUnit,
              tempoMode: it.tempoMode,
              ratioNum: it.ratioNum,
              ratioDen: it.ratioDen,
              customBpm: it.customBpm,
              color: it.color,
              repeat: it.repeat || 1,
              repeatVariable: it.repeatVariable || null
            };
          }),
          measures: stateData.measures.map(m => ({
            id: m.id,
            nickname: m.nickname || "",
            beats: m.beats,
            beatUnit: m.beatUnit,
            tempoMode: m.tempoMode,
            ratioNum: m.ratioNum,
            ratioDen: m.ratioDen,
            customBpm: m.customBpm,
            color: m.color,
            repeat: m.repeat || 1,
            repeatVariable: m.repeatVariable || null,
            sourcePieceId: m.sourcePieceId || null,
            sourcePieceName: m.sourcePieceName || null,
            sourceMeasureId: m.sourceMeasureId || null,
            isLinked: m.isLinked === undefined ? Boolean(m.sourcePieceId) : Boolean(m.isLinked),
            isLocallyModified: Boolean(m.isLocallyModified)
          })),
          groups: stateData.groups.map(g => ({
            id: g.id,
            name: g.name,
            color: g.color,
            startMeasure: g.startMeasure,
            endMeasure: g.endMeasure,
            repeat: Math.max(1, Math.min(999, parseInt(g.repeat, 10) || 1)),
            repeatVariable: g.repeatVariable || null,
            isBossaBlock: Boolean(g.isBossaBlock),
            sourcePieceId: g.sourcePieceId || null,
            sourcePieceName: g.sourcePieceName || null,
            isLinked: g.isLinked === undefined ? Boolean(g.sourcePieceId) : Boolean(g.isLinked),
            collapsed: Boolean(g.collapsed)
          })),
          variables: stateData.variables || [],
          updatedAt: Date.now(),
          updatedBy: this.localUser,
          lastAction: actionDescription || "Alteração na peça"
        };

        this.lastCommittedContentHash = freshHash;
        await setDoc(pieceRef, payload);

        // Atualiza timestamp na biblioteca local para evitar falso-positivo de "nuvem mais nova"
        try {
          const raw = localStorage.getItem('sergio_pieces_library');
          if (raw) {
            const lib = JSON.parse(raw);
            const item = lib.find(p => p.id === this.currentPieceId);
            if (item) {
              item.updatedAt = payload.updatedAt;
              localStorage.setItem('sergio_pieces_library', JSON.stringify(lib));
            }
          }
        } catch (_) {}

        // Adiciona ao histórico na nuvem (limite de 500 itens)
        await this.addHistoryEntry(this.currentPieceId, actionDescription, payload);

        this.setSyncStatus('synced', 'Salvo na nuvem');
      } catch (err) {
        console.error("Erro ao salvar alteração no Firestore:", err);
        this.setSyncStatus('error', 'Erro ao salvar na nuvem');
      }
    }, 450);
  }

  // Atualiza visibilidade de acesso da peça ('private' | 'view_link' | 'edit_link')
  async updatePieceAccess(newAccess) {
    if (!db || !this.currentPieceId) return false;
    try {
      const pieceRef = doc(db, 'pieces', this.currentPieceId);
      this.currentPieceAccess = newAccess;
      const currentUid = authService.getUid();

      const updateData = {
        access: newAccess,
        updatedAt: Date.now(),
        lastAction: `Alterou visibilidade para ${newAccess}`
      };

      if (!this.currentPieceOwnerId && currentUid) {
        this.currentPieceOwnerId = currentUid;
        updateData.ownerId = currentUid;
        updateData.ownerName = authService.getDisplayName();
      }

      await setDoc(pieceRef, updateData, { merge: true });
      this.evaluateCurrentPermissions();
      return true;
    } catch (err) {
      console.error("Erro ao atualizar visibilidade da peça:", err);
      throw err;
    }
  }

  // Busca todas as peças salvas na nuvem do usuário logado
  async getUserCloudPieces(uid = authService.getUid()) {
    if (!db || !uid) return [];
    try {
      const piecesCol = collection(db, 'pieces');
      const q = query(piecesCol, where('ownerId', '==', uid));
      const snap = await getDocs(q);
      const list = [];
      snap.forEach(docSnap => {
        list.push(docSnap.data());
      });
      list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return list;
    } catch (err) {
      console.warn("Erro ao buscar peças da nuvem:", err);
      return [];
    }
  }

  // Busca especificamente as Bossas salvas na nuvem do usuário logado
  async getUserCloudBossas(uid = authService.getUid()) {
    if (!db || !uid) return [];
    try {
      const allPieces = await this.getUserCloudPieces(uid);
      return allPieces.filter(p => p.isBossa !== undefined ? Boolean(p.isBossa) : Boolean(p.id?.startsWith('piece-bossa-') || p.id?.startsWith('bossa-')));
    } catch (err) {
      console.warn("Erro ao buscar bossas da nuvem:", err);
      return [];
    }
  }

  // Salva ou atualiza uma Peça ou Bossa na nuvem (Firestore) vinculada à conta do usuário
  async saveBossaToCloud(bossaData) {
    const currentUid = authService.getUid();
    if (!db || !currentUid || !bossaData) return false;
    try {
      const isBossaVal = bossaData.isBossa !== undefined ? Boolean(bossaData.isBossa) : Boolean(bossaData.id?.startsWith('piece-bossa-') || bossaData.id?.startsWith('bossa-'));
      const bossaRef = doc(db, 'pieces', bossaData.id);
      const payload = {
        id: bossaData.id,
        name: (bossaData.name || (isBossaVal ? 'Nova Bossa' : 'Nova Peça')).trim(),
        description: bossaData.description || '',
        baseBpm: bossaData.baseBpm || 120,
        presentationBpm: bossaData.presentationBpm || bossaData.baseBpm || 120,
        measures: Array.isArray(bossaData.measures) ? bossaData.measures : [],
        groups: Array.isArray(bossaData.groups) ? bossaData.groups : [],
        variables: Array.isArray(bossaData.variables) ? bossaData.variables : [],
        isBossa: isBossaVal,
        ownerId: currentUid,
        ownerName: authService.getDisplayName() || 'Músico',
        access: bossaData.access || 'private',
        updatedAt: Date.now(),
        createdAt: bossaData.createdAt || Date.now()
      };
      await setDoc(bossaRef, payload, { merge: true });
      return true;
    } catch (err) {
      console.error("Erro ao salvar bossa na nuvem:", err);
      return false;
    }
  }

  // Salva ou atualiza uma Peça na nuvem
  async savePieceToCloud(pieceData) {
    return this.saveBossaToCloud(pieceData);
  }

  // Exclui uma Bossa da nuvem
  async deleteBossaFromCloud(bossaId) {
    const currentUid = authService.getUid();
    if (!db || !currentUid || !bossaId) return false;
    try {
      const bossaRef = doc(db, 'pieces', bossaId);
      await deleteDoc(bossaRef);
      return true;
    } catch (err) {
      console.error("Erro ao excluir bossa da nuvem:", err);
      return false;
    }
  }

  // Exclui uma Peça ou Bossa da nuvem (alias unificado)
  async deletePieceFromCloud(pieceId) {
    return this.deleteBossaFromCloud(pieceId);
  }

  // Atualiza campos de uma Bossa na nuvem (ex: renomear ou trocar tipo)
  async updateBossaInCloud(bossaId, updates = {}) {
    const currentUid = authService.getUid();
    if (!db || !currentUid || !bossaId) return false;
    try {
      const bossaRef = doc(db, 'pieces', bossaId);
      await setDoc(bossaRef, {
        ...updates,
        updatedAt: Date.now()
      }, { merge: true });
      return true;
    } catch (err) {
      console.error("Erro ao atualizar bossa na nuvem:", err);
      return false;
    }
  }

  // Atualiza campos de uma Peça na nuvem (alias)
  async updatePieceInCloud(pieceId, updates = {}) {
    return this.updateBossaInCloud(pieceId, updates);
  }

  // Sincroniza bidirecionalmente a biblioteca local com a nuvem
  // (Migra peças e bossas criadas no celular para a conta do usuário e baixa no desktop)
  // Single-flight + throttle: chamadas simultâneas compartilham a mesma sincronização,
  // e chamadas repetidas dentro da janela reaproveitam o resultado (evita rajada de requests).
  async syncUserLibraryWithCloud(stateInstance, { force = false } = {}) {
    const uid = authService.getUid();
    if (!db || !uid || !stateInstance) {
      return stateInstance ? stateInstance.getLibraryPieces() : [];
    }

    if (this._librarySyncPromise) return this._librarySyncPromise;

    const MIN_INTERVAL_MS = 15000;
    const now = Date.now();
    if (!force && this._lastLibrarySyncAt && (now - this._lastLibrarySyncAt) < MIN_INTERVAL_MS) {
      return stateInstance.getLibraryPieces();
    }

    this._librarySyncPromise = this._doSyncUserLibraryWithCloud(stateInstance, uid)
      .finally(() => {
        this._lastLibrarySyncAt = Date.now();
        this._librarySyncPromise = null;
      });
    return this._librarySyncPromise;
  }

  async _doSyncUserLibraryWithCloud(stateInstance, uid) {
    try {
      // 1. Busca todas as peças e bossas do usuário no Firestore
      const cloudPieces = await this.getUserCloudPieces(uid);
      this.cloudPiecesCache = cloudPieces;
      const cloudMap = new Map();
      cloudPieces.forEach(p => {
        if (p && p.id) cloudMap.set(p.id, p);
      });

      // 2. Obtém a biblioteca local atual
      let localLibrary = stateInstance.getLibraryPieces();
      let hasLocalChanges = false;

      // 3. Sincroniza peças e bossas criadas localmente (ex: celular) que ainda não foram enviadas à nuvem
      for (const item of localLibrary) {
        if (!item || !item.id) continue;
        const isBossa = item.isBossa !== undefined ? Boolean(item.isBossa) : Boolean(item.id.startsWith('piece-bossa-') || item.id.startsWith('bossa-'));

        // Se for peça/bossa do usuário ou item local sem dono explícito
        if (!item.ownerId || item.ownerId === uid) {
          if (!cloudMap.has(item.id)) {
            try {
              const uploadPayload = {
                ...item,
                isBossa: isBossa,
                ownerId: uid,
                ownerName: authService.getDisplayName() || 'Músico',
                access: item.access || 'private',
                updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
                createdAt: item.createdAt || Date.now()
              };
              await setDoc(doc(db, 'pieces', item.id), uploadPayload, { merge: true });
              cloudMap.set(item.id, uploadPayload);
              item.ownerId = uid;
              hasLocalChanges = true;
            } catch (upErr) {
              console.warn("Erro ao sincronizar item local para a nuvem:", item.name, upErr);
            }
          }
        }
      }

      // 4. Traz itens da nuvem para a biblioteca local (desktop recebe bossas criadas no celular)
      cloudPieces.forEach(cloudPiece => {
        const localIndex = localLibrary.findIndex(lp => lp.id === cloudPiece.id);
        if (localIndex === -1) {
          // Novo item vindo da nuvem
          localLibrary.unshift(cloudPiece);
          hasLocalChanges = true;
        } else {
          // Já existe localmente: atualiza se a versão na nuvem for mais recente
          const localUpdated = typeof localLibrary[localIndex].updatedAt === 'number'
            ? localLibrary[localIndex].updatedAt
            : new Date(localLibrary[localIndex].updatedAt || 0).getTime();
          const cloudUpdated = typeof cloudPiece.updatedAt === 'number'
            ? cloudPiece.updatedAt
            : new Date(cloudPiece.updatedAt || 0).getTime();

          if (cloudUpdated > localUpdated) {
            localLibrary[localIndex] = { ...localLibrary[localIndex], ...cloudPiece };
            hasLocalChanges = true;
          }
        }
      });

      // 5. Salva na biblioteca local se houve mesclagem
      if (hasLocalChanges && typeof stateInstance.setLibraryPieces === 'function') {
        stateInstance.setLibraryPieces(localLibrary);
      }

      return localLibrary;
    } catch (err) {
      console.warn("Erro durante sincronização de bossas com a nuvem:", err);
      return stateInstance.getLibraryPieces();
    }
  }

  // Busca uma peça ou bossa no cache da nuvem por ID ou nome
  findPiece(pieceId, pieceName) {
    if (!Array.isArray(this.cloudPiecesCache)) return null;
    if (pieceId) {
      const match = this.cloudPiecesCache.find(p => p.id === pieceId);
      if (match) return match;
    }
    if (pieceName) {
      const clean = pieceName.replace(/^[🔗📦✏️🔓\s]+/, '').trim().toLowerCase();
      const match = this.cloudPiecesCache.find(p => p.name && p.name.replace(/^[🔗📦✏️🔓\s]+/, '').trim().toLowerCase() === clean);
      if (match) return match;
    }
    return null;
  }

  // Escuta em tempo real todas as alterações na nuvem do usuário (Google Docs style)
  listenToUserLibrary(stateInstance, onChangeCallback) {
    if (this.unsubUserLibrary) {
      this.unsubUserLibrary();
      this.unsubUserLibrary = null;
    }

    const uid = authService.getUid();
    if (!db || !uid || !stateInstance) return;

    try {
      const piecesCol = collection(db, 'pieces');
      const q = query(piecesCol, where('ownerId', '==', uid));

      let isFirstSnapshot = true;
      this.unsubUserLibrary = onSnapshot(q, (snap) => {
        // O primeiro snapshot é o estado inicial: quem chamou já faz a sincronização inicial
        if (isFirstSnapshot) {
          isFirstSnapshot = false;
          return;
        }

        // Ignora escritas locais pendentes e dados vindos só do cache
        if (snap.metadata.hasPendingWrites || snap.metadata.fromCache) {
          return;
        }

        // Ignora alterações feitas por esta própria aba/dispositivo (ex: autosave da peça aberta)
        const changes = snap.docChanges();
        const hasForeignChange = changes.some(ch => {
          const d = ch.doc.data();
          return !d || d.updatedBy?.id !== this.localUser.id;
        });
        if (changes.length === 0 || !hasForeignChange) {
          return;
        }

        clearTimeout(this.librarySyncDebounce);
        this.librarySyncDebounce = setTimeout(async () => {
          try {
            const updatedLib = await this.syncUserLibraryWithCloud(stateInstance, { force: true });
            if (typeof onChangeCallback === 'function') {
              onChangeCallback(updatedLib);
            }
          } catch (err) {
            console.warn("Aviso na sincronização automática em tempo real:", err);
          }
        }, 1000);
      }, (err) => {
        console.warn("Aviso no listener em tempo real da biblioteca:", err);
      });
    } catch (err) {
      console.warn("Erro ao registrar listener da biblioteca na nuvem:", err);
    }
  }

  stopListeningToUserLibrary() {
    if (this.unsubUserLibrary) {
      this.unsubUserLibrary();
      this.unsubUserLibrary = null;
    }
  }

  // Registra nova versão no histórico (grava na nuvem e atualiza localmente sem gastar leituras)
  async addHistoryEntry(pieceId, action, payload) {
    if (!db) return;
    try {
      const historyCol = collection(db, 'pieces', pieceId, 'history');
      const entryId = `rev-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;
      const entryDoc = doc(historyCol, entryId);

      const entryData = {
        id: entryId,
        timestamp: Date.now(),
        action: action || "Alteração na peça",
        author: this.localUser,
        summary: `${payload.measures?.length || 0} compassos • ${payload.baseBpm || 120} BPM`,
        snapshot: {
          id: payload.id,
          name: payload.name,
          description: payload.description || "",
          baseBpm: payload.baseBpm,
          measures: payload.measures,
          groups: payload.groups
        }
      };

      await setDoc(entryDoc, entryData);

      // Atualiza lista em memória sem gastar leituras no Firestore
      this.historyList.unshift(entryData);
      if (this.historyList.length > MAX_HISTORY_ITEMS) {
        this.historyList.pop();
      }
      if (this.onHistoryChange) {
        this.onHistoryChange(this.historyList);
      }
    } catch (e) {
      console.warn("Erro ao gravar histórico:", e);
    }
  }

  // Carrega histórico sob demanda quando o usuário abre o modal (evita milhares de leituras)
  async loadHistory(pieceId = this.currentPieceId, limitCount = 50) {
    if (!db || !pieceId) return this.historyList;
    try {
      const historyCol = collection(db, 'pieces', pieceId, 'history');
      const historyQuery = query(historyCol, orderBy('timestamp', 'desc'), limit(limitCount));
      const snap = await getDocs(historyQuery);
      const list = [];
      snap.forEach((docSnap) => {
        list.push({ id: docSnap.id, ...docSnap.data() });
      });
      this.historyList = list;
      if (this.onHistoryChange) {
        this.onHistoryChange(list);
      }
      return list;
    } catch (err) {
      console.warn("Erro ao buscar histórico:", err);
      return this.historyList;
    }
  }

  // Restaura uma versão do histórico
  async restoreVersion(historyItem) {
    if (!historyItem || !historyItem.snapshot) return false;
    const snap = historyItem.snapshot;
    const actionDesc = `Restaurou a versão de ${new Date(historyItem.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (${historyItem.author?.name || 'Autor'})`;
    
    this.commitLocalChange(actionDesc, snap);
    return true;
  }

  // Presença e batimento cardíaco (heartbeat otimizado a cada 30 segundos)
  setupPresence(pieceId) {
    const presenceCol = collection(db, 'pieces', pieceId, 'presence');
    const myDocRef = doc(presenceCol, this.localUser.id);

    // Heartbeat periódico (a cada 30 segundos, pausado se aba estiver inativa)
    const sendBeat = async () => {
      if (document.hidden) return;
      try {
        await setDoc(myDocRef, {
          id: this.localUser.id,
          name: this.localUser.name,
          color: this.localUser.color,
          lastSeen: Date.now()
        });
      } catch (_) {}
    };

    sendBeat();
    this.heartbeatTimer = setInterval(sendBeat, 30000);

    // Remove presença ao fechar aba
    window.addEventListener('beforeunload', () => {
      deleteDoc(myDocRef).catch(() => {});
    });

    // Ouve todos os participantes ativos
    this.unsubPresence = onSnapshot(presenceCol, (snap) => {
      const now = Date.now();
      const active = [];
      snap.forEach((d) => {
        const data = d.data();
        // Usuário online se visto nos últimos 70 segundos
        if (data && data.lastSeen && (now - data.lastSeen < 70000)) {
          active.push(data);
        }
      });
      this.activeCollaborators = active;
      if (this.onPresenceChange) {
        this.onPresenceChange(active);
      }
    });
  }

  sendPresenceHeartbeat() {
    if (!db || !this.currentPieceId) return;
    const myDocRef = doc(db, 'pieces', this.currentPieceId, 'presence', this.localUser.id);
    setDoc(myDocRef, {
      id: this.localUser.id,
      name: this.localUser.name,
      color: this.localUser.color,
      lastSeen: Date.now()
    }).catch(() => {});
  }

  setSyncStatus(status, text) {
    if (this.onSyncStatusChange) {
      this.onSyncStatusChange(status, text);
    }
  }

  // Computa hash do conteúdo real da partitura (ignora timestamp, autor e lastAction)
  computeContentHash(pieceData) {
    if (!pieceData) return '';
    try {
      const name = (pieceData.name || '').trim();
      const bpm = pieceData.presentationBpm || pieceData.baseBpm || 120;
      const desc = (pieceData.description || '').trim();
      let itemsStr = '';
      if (pieceData.items && pieceData.items.length > 0) {
        itemsStr = pieceData.items.map(it => {
          if (it.type === 'bossa') {
            const innerMeasures = (it.measures || []).map(m => `${m.id || ''}:${m.beats || 4}:${m.beatUnit || 4}:${m.repeatVariable || ''}`).join(',');
            const varsStr = JSON.stringify(it.variableValues || {});
            return `B:${it.id || ''}:${it.name || ''}:${it.sourcePieceId || ''}:${it.isLinked ? 1 : 0}:${it.repeat || 1}:${it.tempoMode || 'inherit'}:${it.bpm || ''}:${it.ratioNum || 1}/${it.ratioDen || 1}:${varsStr}:${innerMeasures}`;
          } else if (it.type === 'section') {
            return `S:${it.id || ''}:${it.name || ''}:${it.color || ''}:${it.repeat || 1}:${it.repeatVariable || ''}`;
          } else {
            const m = it.measure || it;
            return `M:${m.id || ''}:${m.nickname || ''}:${m.beats || 4}:${m.beatUnit || 4}:${m.tempoMode || 'ratio'}:${m.ratioNum || 1}/${m.ratioDen || 1}:${m.customBpm || 120}:${m.color || ''}:${m.repeat || 1}:${m.repeatVariable || ''}`;
          }
        }).join('|');
      }
      const measures = (pieceData.measures || []).map(m => 
        `${m.id || ''}:${m.nickname || ''}:${m.beats || 4}:${m.beatUnit || 4}:${m.tempoMode || 'ratio'}:${m.ratioNum || 1}/${m.ratioDen || 1}:${m.customBpm || 120}:${m.color || ''}:${m.repeat || 1}:${m.repeatVariable || ''}:${m.sourcePieceId || ''}:${m.isLinked ? 1 : 0}`
      ).join('|');
      const groups = (pieceData.groups || []).map(g => 
        `${g.id || ''}:${g.name || ''}:${g.color || ''}:${g.startMeasure || 0}-${g.endMeasure || 0}:${g.repeat || 1}:${g.repeatVariable || ''}:${g.isBossaBlock ? 1 : 0}:${g.sourcePieceId || ''}`
      ).join('|');
      const vars = JSON.stringify(pieceData.variables || []);
      return `${name}#${bpm}#${desc}#${access}#${itemsStr}#${measures}#${groups}#${vars}`;
    } catch (_) {
      return '';
    }
  }

  computeHash(obj) {
    return this.computeContentHash(obj);
  }

  disconnect() {
    if (this.unsubPiece) { this.unsubPiece(); this.unsubPiece = null; }
    if (this.unsubHistory) { this.unsubHistory(); this.unsubHistory = null; }
    if (this.unsubPresence) { this.unsubPresence(); this.unsubPresence = null; }
    this.stopListeningToUserLibrary();
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    clearTimeout(this.pendingCommitTimer);
    clearTimeout(this.librarySyncDebounce);
    this.lastCommittedContentHash = null;
    this.isSyncingLibrary = false;
  }
}

export const collab = new CollabService();
