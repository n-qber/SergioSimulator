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
  getDocs
} from 'firebase/firestore';

const MAX_HISTORY_ITEMS = 200;
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
    this.localUser = this.loadLocalProfile();
    this.activeCollaborators = [];
    this.historyList = [];
    
    // Listeners desinscrever
    this.unsubPiece = null;
    this.unsubHistory = null;
    this.unsubPresence = null;
    this.heartbeatTimer = null;
    
    // Callbacks da aplicação
    this.onRemoteStateChange = null;
    this.onHistoryChange = null;
    this.onPresenceChange = null;
    this.onSyncStatusChange = null;

    // Flag para evitar eco de alterações locais
    this.isApplyingRemote = false;
    this.lastSentPayloadHash = null;
    this.pendingCommitTimer = null;
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

  // Lê ID da peça a partir da URL (?piece=ID ou ?room=ID ou hash)
  getPieceIdFromUrl() {
    if (typeof window === 'undefined') return null;
    const urlParams = new URLSearchParams(window.location.search);
    const pieceId = urlParams.get('piece') || urlParams.get('room');
    if (pieceId && pieceId.trim()) return pieceId.trim();

    if (window.location.hash.startsWith('#piece=')) {
      return window.location.hash.replace('#piece=', '').trim();
    }
    return null;
  }

  // Define ID da peça na URL sem recarregar a página
  updateUrlPieceId(pieceId) {
    if (typeof window === 'undefined' || !window.history) return;
    const url = new URL(window.location.href);
    url.searchParams.set('piece', pieceId);
    url.searchParams.delete('room');
    window.history.replaceState({}, '', url.toString());
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
    this.currentPieceId = pieceId;
    this.updateUrlPieceId(pieceId);
    this.setSyncStatus('syncing', 'Conectando à nuvem...');

    try {
      const pieceRef = doc(db, 'pieces', pieceId);
      const pieceSnap = await getDoc(pieceRef);

      // Se a peça ainda não existe no Firestore, criamos a partir do estado atual
      if (!pieceSnap.exists()) {
        const initialData = currentStateSnapshot ? {
          id: pieceId,
          name: currentStateSnapshot.name || "Nova Peça Colaborativa",
          description: currentStateSnapshot.description || "",
          baseBpm: currentStateSnapshot.presentationBpm || currentStateSnapshot.baseBpm || 120,
          presentationBpm: currentStateSnapshot.presentationBpm || currentStateSnapshot.baseBpm || 120,
          measures: currentStateSnapshot.measures || [],
          groups: currentStateSnapshot.groups || [],
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
          updatedAt: Date.now(),
          updatedBy: this.localUser,
          lastAction: "Peça criada na nuvem"
        };

        await setDoc(pieceRef, initialData);
        // Cria primeira entrada no histórico
        await this.addHistoryEntry(pieceId, "Peça inicializada na nuvem", initialData);
      } else {
        // Carrega dados iniciais do Firestore para o app local
        const data = pieceSnap.data();
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
        
        // Evita reprocessar se foi a própria aba que enviou
        if (remoteData.updatedBy?.id === this.localUser.id) {
          this.setSyncStatus('synced', 'Salvo na nuvem');
          return;
        }

        const remoteHash = this.computeHash(remoteData);
        if (remoteHash === this.lastSentPayloadHash) {
          return;
        }

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
        this.setSyncStatus('error', 'Erro de conexão');
      });

      // 2. OUVINTE EM TEMPO REAL: Histórico (até 200 alterações)
      const historyCol = collection(db, 'pieces', pieceId, 'history');
      const historyQuery = query(historyCol, orderBy('timestamp', 'desc'), limit(MAX_HISTORY_ITEMS));

      this.unsubHistory = onSnapshot(historyQuery, (snap) => {
        const list = [];
        snap.forEach((docSnap) => {
          list.push({ id: docSnap.id, ...docSnap.data() });
        });
        this.historyList = list;
        if (this.onHistoryChange) {
          this.onHistoryChange(list);
        }
      }, (err) => {
        console.warn("Erro ao ouvir histórico:", err);
      });

      // 3. OUVINTE EM TEMPO REAL: Presença de colaboradores
      this.setupPresence(pieceId);

      this.setSyncStatus('synced', 'Conectado em tempo real');
      return true;
    } catch (err) {
      console.error("Erro ao conectar à peça:", err);
      this.setSyncStatus('error', 'Falha ao sincronizar');
      return false;
    }
  }

  // Envia alteração local para o Firestore (com debounce inteligente para evitar spam)
  commitLocalChange(actionDescription, stateData) {
    if (!db || !this.currentPieceId || this.isApplyingRemote) return;

    this.setSyncStatus('syncing', 'Salvando na nuvem...');
    clearTimeout(this.pendingCommitTimer);

    this.pendingCommitTimer = setTimeout(async () => {
      try {
        const pieceRef = doc(db, 'pieces', this.currentPieceId);
        const payload = {
          id: this.currentPieceId,
          name: stateData.name,
          description: stateData.description || "",
          baseBpm: stateData.presentationBpm || stateData.baseBpm,
          presentationBpm: stateData.presentationBpm || stateData.baseBpm,
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
            repeat: m.repeat || 1
          })),
          groups: stateData.groups.map(g => ({
            id: g.id,
            name: g.name,
            color: g.color,
            startMeasure: g.startMeasure,
            endMeasure: g.endMeasure
          })),
          updatedAt: Date.now(),
          updatedBy: this.localUser,
          lastAction: actionDescription || "Alteração na peça"
        };

        this.lastSentPayloadHash = this.computeHash(payload);
        await setDoc(pieceRef, payload);

        // Adiciona ao histórico na nuvem (limite de 200 itens)
        await this.addHistoryEntry(this.currentPieceId, actionDescription, payload);

        this.setSyncStatus('synced', 'Salvo na nuvem');
      } catch (err) {
        console.error("Erro ao salvar alteração no Firestore:", err);
        this.setSyncStatus('error', 'Erro ao salvar na nuvem');
      }
    }, 350);
  }

  // Registra nova versão no histórico (mantém limite de 200)
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

      // Poda versões antigas se passar de 200 itens
      this.pruneHistoryIfExceeded(pieceId);
    } catch (e) {
      console.warn("Erro ao gravar histórico:", e);
    }
  }

  // Garante que o histórico não ultrapasse 200 registros na nuvem
  async pruneHistoryIfExceeded(pieceId) {
    try {
      const historyCol = collection(db, 'pieces', pieceId, 'history');
      const q = query(historyCol, orderBy('timestamp', 'desc'));
      const snap = await getDocs(q);
      
      if (snap.size > MAX_HISTORY_ITEMS) {
        const docsToDelete = snap.docs.slice(MAX_HISTORY_ITEMS);
        for (const d of docsToDelete) {
          await deleteDoc(d.ref).catch(() => {});
        }
      }
    } catch (_) {}
  }

  // Restaura uma versão do histórico
  async restoreVersion(historyItem) {
    if (!historyItem || !historyItem.snapshot) return false;
    const snap = historyItem.snapshot;
    const actionDesc = `Restaurou a versão de ${new Date(historyItem.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (${historyItem.author?.name || 'Autor'})`;
    
    this.commitLocalChange(actionDesc, snap);
    return true;
  }

  // Presença e batimento cardíaco (heartbeat)
  setupPresence(pieceId) {
    const presenceCol = collection(db, 'pieces', pieceId, 'presence');
    const myDocRef = doc(presenceCol, this.localUser.id);

    // Heartbeat periódico (a cada 12 segundos)
    const sendBeat = async () => {
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
    this.heartbeatTimer = setInterval(sendBeat, 12000);

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
        // Usuário online se visto nos últimos 35 segundos
        if (data && data.lastSeen && (now - data.lastSeen < 35000)) {
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

  computeHash(obj) {
    return `${obj.name}-${obj.baseBpm}-${obj.measures?.length}-${obj.groups?.length}-${obj.updatedAt}`;
  }

  disconnect() {
    if (this.unsubPiece) { this.unsubPiece(); this.unsubPiece = null; }
    if (this.unsubHistory) { this.unsubHistory(); this.unsubHistory = null; }
    if (this.unsubPresence) { this.unsubPresence(); this.unsubPresence = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    clearTimeout(this.pendingCommitTimer);
  }
}

export const collab = new CollabService();
