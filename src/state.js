/**
 * Gerenciador de Estado do Sérgio Simulator
 * Controla a peça, compassos, grupos, andamento base, cálculos matemáticos de tempo e importação/exportação.
 */

import { PRESETS } from './presets.js';

const STORAGE_KEY = 'sergio_piece_data';
const LIBRARY_KEY = 'sergio_pieces_library';

class PieceState {
  constructor() {
    this.listeners = new Set();
    this.presentationBpm = 120;
    this.isCustomPracticeBpm = false;
    this.undoStack = [];
    this.redoStack = [];
    this.maxUndoSteps = 150;
    this.isUndoingOrRedoing = false;
    this.currentSnapshot = null;
    this.loadInitialState();
  }

  loadInitialState() {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
      this.resetToDefault();
      return;
    }
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        const pieceData = parsed.piece || parsed;
        if (pieceData && Array.isArray(pieceData.measures)) {
          this.loadPieceData(pieceData);
          return;
        }
      }
    } catch (e) {
      console.warn("Não foi possível carregar peça salva:", e);
    }
    this.resetToDefault();
  }

  resetToDefault() {
    // Carrega o preset padrão
    const defaultPreset = PRESETS[0];
    this.loadPieceData(JSON.parse(JSON.stringify(defaultPreset)));
  }

  loadPieceData(data, isRemote = false) {
    this.id = data.id || `piece-${Date.now()}`;
    this.name = data.name !== undefined ? data.name : "Peça nº 1";
    this.description = data.description || "";
    this.ownerId = data.ownerId || null;
    this.ownerName = data.ownerName || null;
    this.access = data.access || 'edit_link';
    
    // BPM oficial de apresentação da peça (da partitura/nuvem)
    this.presentationBpm = Math.max(20, Math.min(400, Number(data.presentationBpm || data.baseBpm) || 120));

    // Andamento ativo de reprodução / treino
    if (!isRemote) {
      try {
        const savedPractice = localStorage.getItem(`sergio_practice_bpm_${this.id}`);
        if (savedPractice && !isNaN(parseInt(savedPractice, 10))) {
          this.baseBpm = Math.max(20, Math.min(400, parseInt(savedPractice, 10)));
          this.isCustomPracticeBpm = (this.baseBpm !== this.presentationBpm);
        } else {
          this.baseBpm = this.presentationBpm;
          this.isCustomPracticeBpm = false;
        }
      } catch (_) {
        this.baseBpm = this.presentationBpm;
        this.isCustomPracticeBpm = false;
      }
    } else if (!this.isCustomPracticeBpm) {
      // Se for atualização remota e o usuário NÃO estiver treinando em andamento específico:
      this.baseBpm = this.presentationBpm;
    }
    
    this.measures = (data.measures || []).map((m, idx) => ({
      id: m.id || `m-${Date.now()}-${idx}-${Math.random().toString(36).substr(2, 4)}`,
      nickname: (m.nickname || "").trim(),
      beats: Math.max(1, Math.min(32, parseInt(m.beats, 10) || 4)),
      beatUnit: [2, 4, 8, 16].includes(parseInt(m.beatUnit, 10)) ? parseInt(m.beatUnit, 10) : 4,
      tempoMode: m.tempoMode === "fixed" ? "fixed" : "ratio",
      ratioNum: Math.max(1, parseInt(m.ratioNum, 10) || 1),
      ratioDen: Math.max(1, parseInt(m.ratioDen, 10) || 1),
      customBpm: Math.max(20, Math.min(500, Number(m.customBpm) || this.baseBpm)),
      color: m.color || "#ff334b",
      repeat: Math.max(1, Math.min(999, parseInt(m.repeat, 10) || 1)),
      sourcePieceId: m.sourcePieceId || null,
      sourcePieceName: m.sourcePieceName || null,
      sourceMeasureId: m.sourceMeasureId || null,
      isLinked: m.isLinked === undefined ? (!!m.sourcePieceId) : !!m.isLinked,
      isLocallyModified: !!m.isLocallyModified
    }));

    const maxIdx = this.measures.length > 0 ? this.measures.length - 1 : -1;
    this.groups = (data.groups || [])
      .filter(() => this.measures.length > 0)
      .map((g, idx) => ({
        id: g.id || `grp-${Date.now()}-${idx}`,
        name: g.name || `Grupo ${idx + 1}`,
        color: g.color || "#3b82f6",
        startMeasure: Math.max(0, Math.min(maxIdx, parseInt(g.startMeasure, 10) || 0)),
        endMeasure: Math.max(0, Math.min(maxIdx, parseInt(g.endMeasure, 10) || 0)),
        isBossaBlock: !!g.isBossaBlock,
        sourcePieceId: g.sourcePieceId || null,
        sourcePieceName: g.sourcePieceName || null,
        isLinked: g.isLinked === undefined ? (!!g.sourcePieceId) : !!g.isLinked
      }))
      .filter(g => g.startMeasure <= g.endMeasure);

    // Sincronização automática silenciosa de bossas vinculadas
    if (!isRemote) {
      try {
        this.syncLinkedBossas();
      } catch (err) {
        console.warn("Aviso ao sincronizar bossas vinculadas:", err);
      }
    }

    this.recalculateTimings();
    this.currentSnapshot = this.getSnapshot();
    if (!isRemote) {
      this.undoStack = [];
      this.redoStack = [];
    }
    this.isUndoingOrRedoing = true;
    try {
      this.notify("Dados da peça atualizados", isRemote);
    } finally {
      this.isUndoingOrRedoing = false;
    }
  }

  // Define andamento base local (treino/prática sem afetar o banco de dados)
  setBaseBpm(newBpm, isLocalOnly = true) {
    const parsed = parseFloat(newBpm);
    if (!isNaN(parsed) && parsed >= 20 && parsed <= 400) {
      this.baseBpm = Math.round(parsed);
      this.isCustomPracticeBpm = (this.baseBpm !== this.presentationBpm);

      try {
        if (this.isCustomPracticeBpm) {
          localStorage.setItem(`sergio_practice_bpm_${this.id}`, this.baseBpm.toString());
        } else {
          localStorage.removeItem(`sergio_practice_bpm_${this.id}`);
        }
      } catch (_) {}

      this.recalculateTimings();
      this.notify(
        this.isCustomPracticeBpm ? `Alterou BPM base de treino para ${this.baseBpm}` : `Restaurou BPM para ${this.baseBpm}`,
        false,
        isLocalOnly
      );
      return true;
    }
    return false;
  }

  // Define o BPM oficial de apresentação da peça (salva no banco de dados)
  setPresentationBpm(newBpm) {
    const parsed = parseFloat(newBpm);
    if (!isNaN(parsed) && parsed >= 20 && parsed <= 400) {
      this.presentationBpm = Math.round(parsed);
      this.baseBpm = this.presentationBpm;
      this.isCustomPracticeBpm = false;
      try {
        localStorage.removeItem(`sergio_practice_bpm_${this.id}`);
      } catch (_) {}
      this.recalculateTimings();
      this.notify(`Definiu BPM oficial da apresentação para ${this.presentationBpm}`, false, false);
      return true;
    }
    return false;
  }

  // Restaura o BPM local para o BPM oficial da apresentação
  resetToPresentationBpm() {
    return this.setBaseBpm(this.presentationBpm, true);
  }

  setPieceName(name) {
    this.name = name.trim() || "Peça Sem Nome";
    this.notify(`Renomeou a peça para '${this.name}'`);
  }

  // Total de compassos tocados considerando repetições
  getTotalMeasureCount() {
    if (this.measures.length === 0) return 0;
    return this.measures.reduce((acc, m) => acc + (m.repeat || 1), 0);
  }

  // Adicionar compasso
  addMeasure(index = -1, template = null) {
    const newIdx = index === -1 ? this.measures.length : index;
    const prevMeasure = this.measures[Math.max(0, newIdx - 1)] || null;

    const newMeasure = {
      id: `m-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      nickname: template?.nickname ? template.nickname.trim() : "",
      beats: template?.beats || prevMeasure?.beats || 4,
      beatUnit: template?.beatUnit || prevMeasure?.beatUnit || 4,
      tempoMode: template?.tempoMode || prevMeasure?.tempoMode || "ratio",
      ratioNum: template?.ratioNum || prevMeasure?.ratioNum || 1,
      ratioDen: template?.ratioDen || prevMeasure?.ratioDen || 1,
      customBpm: template?.customBpm || prevMeasure?.customBpm || this.baseBpm,
      color: template?.color || prevMeasure?.color || "#ff334b",
      repeat: Math.max(1, Math.min(999, parseInt(template?.repeat, 10) || 1))
    };

    if (index === -1 || index >= this.measures.length) {
      this.measures.push(newMeasure);
    } else {
      this.measures.splice(index, 0, newMeasure);
      // Ajusta índices dos grupos
      this.groups.forEach(g => {
        if (g.startMeasure >= index) g.startMeasure++;
        if (g.endMeasure >= index) g.endMeasure++;
      });
    }

    this.recalculateTimings();
    this.notify(`Adicionou compasso (${newMeasure.beats}T)`);
    return newMeasure;
  }

  // Duplicar compasso
  duplicateMeasure(index) {
    if (index < 0 || index >= this.measures.length) return;
    const target = this.measures[index];
    this.addMeasure(index + 1, {
      ...target,
      nickname: target.nickname ? `${target.nickname} (cópia)` : "",
      repeat: target.repeat || 1
    });
  }

  // Mover / reordenar compasso
  moveMeasure(fromIndex, toIndex) {
    if (fromIndex === toIndex) return false;
    if (fromIndex < 0 || fromIndex >= this.measures.length) return false;
    if (toIndex < 0 || toIndex >= this.measures.length) return false;

    // Vincula cada compasso ao seu ID de grupo atual antes de mover
    this.measures.forEach((m, idx) => {
      const grp = this.groups.find(g => idx >= g.startMeasure && idx <= g.endMeasure);
      m._assignedGroupId = grp ? grp.id : null;
    });

    const [moved] = this.measures.splice(fromIndex, 1);
    this.measures.splice(toIndex, 0, moved);

    // Atualiza limites dos grupos conforme a nova distribuição dos compassos
    this.groups.forEach(grp => {
      const indices = [];
      this.measures.forEach((m, idx) => {
        if (m._assignedGroupId === grp.id) {
          indices.push(idx);
        }
      });
      if (indices.length > 0) {
        grp.startMeasure = Math.min(...indices);
        grp.endMeasure = Math.max(...indices);
      }
    });

    // Remove tags temporárias
    this.measures.forEach(m => delete m._assignedGroupId);

    this.recalculateTimings();
    this.notify(`Moveu compasso ${fromIndex + 1} para posição ${toIndex + 1}`);
    return true;
  }

  // Remover compasso (permite ficar com 0 compassos)
  removeMeasure(index) {
    if (this.measures.length === 0) return;
    if (index < 0 || index >= this.measures.length) return;

    this.measures.splice(index, 1);

    if (this.measures.length === 0) {
      this.groups = [];
    } else {
      // Ajusta grupos após remoção
      this.groups = this.groups.filter(g => {
        if (index >= g.startMeasure && index <= g.endMeasure) {
          // Se o grupo tinha 1 compasso e foi removido
          if (g.startMeasure === g.endMeasure) return false;
          g.endMeasure--;
        } else if (index < g.startMeasure) {
          g.startMeasure--;
          g.endMeasure--;
        }
        return g.startMeasure <= g.endMeasure && g.startMeasure < this.measures.length;
      });
    }

    this.recalculateTimings();
    this.notify(`Excluiu compasso ${index + 1}`);
  }

  // Remover múltiplos compassos de uma vez (seleção múltipla)
  removeMeasures(indices) {
    if (!indices || indices.length === 0 || this.measures.length === 0) return;
    
    // Converte para Set para eliminar duplicatas e ordena em ordem decrescente
    const uniqueSorted = Array.from(new Set(indices))
      .filter(idx => typeof idx === 'number' && idx >= 0 && idx < this.measures.length)
      .sort((a, b) => b - a);

    if (uniqueSorted.length === 0) return;

    for (const index of uniqueSorted) {
      this.measures.splice(index, 1);
      
      if (this.measures.length === 0) {
        this.groups = [];
      } else {
        this.groups = this.groups.filter(g => {
          if (index >= g.startMeasure && index <= g.endMeasure) {
            if (g.startMeasure === g.endMeasure) return false;
            g.endMeasure--;
          } else if (index < g.startMeasure) {
            g.startMeasure--;
            g.endMeasure--;
          }
          return g.startMeasure <= g.endMeasure && g.startMeasure < this.measures.length;
        });
      }
    }

    this.recalculateTimings();
    this.notify(`Excluiu ${uniqueSorted.length} compasso${uniqueSorted.length > 1 ? 's' : ''}`);
  }

  // Duplicar múltiplos compassos de uma vez
  duplicateMeasures(indices) {
    if (!indices || indices.length === 0 || this.measures.length === 0) return null;
    const sorted = Array.from(new Set(indices))
      .filter(idx => typeof idx === 'number' && idx >= 0 && idx < this.measures.length)
      .sort((a, b) => a - b);

    if (sorted.length === 0) return null;

    const insertIndex = sorted[sorted.length - 1] + 1;
    const copies = sorted.map(idx => {
      const target = this.measures[idx];
      return {
        id: `m-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
        nickname: target.nickname ? `${target.nickname} (cópia)` : "",
        beats: target.beats,
        beatUnit: target.beatUnit,
        tempoMode: target.tempoMode,
        ratioNum: target.ratioNum,
        ratioDen: target.ratioDen,
        customBpm: target.customBpm,
        color: target.color,
        repeat: target.repeat || 1
      };
    });

    this.measures.splice(insertIndex, 0, ...copies);

    // Ajusta grupos após inserção em bloco
    const count = copies.length;
    this.groups.forEach(g => {
      if (g.startMeasure >= insertIndex) g.startMeasure += count;
      if (g.endMeasure >= insertIndex) g.endMeasure += count;
    });

    this.recalculateTimings();
    this.notify(`Duplicou ${copies.length} compasso${copies.length > 1 ? 's' : ''}`);
    return { start: insertIndex, end: insertIndex + count - 1 };
  }

  // Esvazia todos os compassos da peça
  clearAllMeasures() {
    this.measures = [];
    this.groups = [];
    this.recalculateTimings();
    this.notify("Limpou todos os compassos");
  }

  // Salva a peça atual na biblioteca local do usuário (para nunca perder composições anteriores)
  saveCurrentPieceToLibrary() {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(LIBRARY_KEY);
      let library = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(library)) library = [];

      const pieceData = {
        id: this.id,
        name: this.name || "Peça Sem Nome",
        description: this.description || "",
        presentationBpm: this.presentationBpm,
        baseBpm: this.baseBpm,
        ownerId: this.ownerId || null,
        ownerName: this.ownerName || null,
        access: this.access || 'edit_link',
        measures: this.measures.map(m => ({ ...m })),
        groups: this.groups.map(g => ({ ...g })),
        updatedAt: new Date().toISOString()
      };

      const existingIdx = library.findIndex(p => p.id === this.id);
      if (existingIdx >= 0) {
        library[existingIdx] = pieceData;
      } else {
        library.unshift(pieceData);
      }

      // Mantém até 50 peças locais
      if (library.length > 50) {
        library = library.slice(0, 50);
      }

      localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
    } catch (e) {
      console.warn("Erro ao salvar peça na biblioteca:", e);
    }
  }

  // Retorna todas as peças salvas na biblioteca local
  getLibraryPieces() {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') return [];
    try {
      const raw = localStorage.getItem(LIBRARY_KEY);
      const library = raw ? JSON.parse(raw) : [];
      return Array.isArray(library) ? library : [];
    } catch (_) {
      return [];
    }
  }

  // Carrega uma peça da biblioteca pelo ID
  loadPieceFromLibrary(pieceId) {
    const library = this.getLibraryPieces();
    const found = library.find(p => p.id === pieceId);
    if (found) {
      // Salva a peça atual antes de trocar para garantir que nenhuma alteração se perca
      if (this.measures && this.measures.length > 0) {
        this.saveCurrentPieceToLibrary();
      }
      this.loadPieceData(JSON.parse(JSON.stringify(found)));
      return true;
    }
    return false;
  }

  // Define a lista de peças na biblioteca local e salva no localStorage
  setLibraryPieces(library) {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
    try {
      if (!Array.isArray(library)) return;
      if (library.length > 100) library = library.slice(0, 100);
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
      this.notify('Biblioteca de peças e bossas atualizada');
    } catch (e) {
      console.warn("Erro ao atualizar biblioteca local:", e);
    }
  }

  // Retorna apenas as bossas salvas na biblioteca local
  getBossaPieces() {
    const all = this.getLibraryPieces();
    return all.filter(p => Boolean(p.isBossa || p.id?.startsWith('piece-bossa-') || p.id?.startsWith('bossa-')));
  }

  // Renomeia uma bossa na biblioteca local
  renameBossa(bossaId, newName) {
    const cleanName = (newName || '').trim();
    if (!cleanName) return false;
    const library = this.getLibraryPieces();
    const item = library.find(p => p.id === bossaId);
    if (item) {
      item.name = cleanName;
      item.updatedAt = Date.now();
      if (Array.isArray(item.groups) && item.groups[0]) {
        item.groups[0].name = cleanName;
      }
      this.setLibraryPieces(library);
      this.notify(`Bossa renomeada para '${cleanName}'`);
      return true;
    }
    return false;
  }

  // Remove uma peça ou bossa da biblioteca
  deletePieceFromLibrary(pieceId) {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(LIBRARY_KEY);
      let library = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(library)) return;
      library = library.filter(p => p.id !== pieceId);
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
      this.notify('Item removido da biblioteca');
    } catch (_) {}
  }

  // Cria uma nova peça efetivamente, preservando a peça atual na biblioteca
  createNewPiece(name = "Nova Peça", baseBpm = 120) {
    // 1. Salva a peça atual antes de criar a nova
    if (this.measures && this.measures.length > 0) {
      this.saveCurrentPieceToLibrary();
    }

    // 2. Gera novo ID exclusivo e limpa dados
    this.id = `piece-${Date.now()}`;
    this.name = name;
    this.description = "";
    this.presentationBpm = Math.max(20, Math.min(400, parseInt(baseBpm, 10) || 120));
    this.baseBpm = this.presentationBpm;
    this.isCustomPracticeBpm = false;
    try {
      localStorage.removeItem(`sergio_practice_bpm_${this.id}`);
    } catch (_) {}

    // 3. Inicializa com 1 compasso padrão 4/4 pronto para tocar
    this.measures = [
      {
        id: `m-${Date.now()}-0-${Math.random().toString(36).substr(2, 4)}`,
        nickname: "Compasso 1",
        beats: 4,
        beatUnit: 4,
        tempoMode: "ratio",
        ratioNum: 1,
        ratioDen: 1,
        customBpm: this.baseBpm,
        color: "#ff334b",
        repeat: 1
      }
    ];
    this.groups = [];
    this.recalculateTimings();
    this.currentSnapshot = this.getSnapshot();
    this.undoStack = [];
    this.redoStack = [];

    // Salva a nova peça no storage ativo e registra na biblioteca
    this.saveToLocalStorage();
    this.saveCurrentPieceToLibrary();

    this.notify(`Criou nova peça '${this.name}'`);
  }

  // Clona a peça atual criando uma cópia independente (Fork / Fazer Cópia)
  duplicateCurrentPiece(customName = null) {
    if (this.measures && this.measures.length > 0) {
      this.saveCurrentPieceToLibrary();
    }

    const newId = `piece-${Date.now()}`;
    this.id = newId;
    this.name = customName || `${this.name} (Cópia)`;
    this.ownerId = null;
    this.access = 'edit_link';

    // Gera novos IDs para os compassos
    this.measures = this.measures.map((m, idx) => ({
      ...m,
      id: `m-${Date.now()}-${idx}-${Math.random().toString(36).substr(2, 4)}`
    }));

    // Gera novos IDs para os grupos
    this.groups = this.groups.map((g, idx) => ({
      ...g,
      id: `g-${Date.now()}-${idx}-${Math.random().toString(36).substr(2, 4)}`
    }));

    this.recalculateTimings();
    this.currentSnapshot = this.getSnapshot();
    this.undoStack = [];
    this.redoStack = [];

    this.saveToLocalStorage();
    this.saveCurrentPieceToLibrary();
    this.notify(`Criou uma cópia pessoal '${this.name}'`);
    return newId;
  }

  // Atualizar compasso existente
  updateMeasure(index, updates) {
    if (index < 0 || index >= this.measures.length) return;
    const m = this.measures[index];
    
    if (updates.nickname !== undefined) m.nickname = (updates.nickname || "").trim();
    if (updates.beats !== undefined) m.beats = Math.max(1, Math.min(32, parseInt(updates.beats, 10) || 4));
    if (updates.beatUnit !== undefined) m.beatUnit = parseInt(updates.beatUnit, 10) || 4;
    if (updates.tempoMode !== undefined) m.tempoMode = updates.tempoMode;
    if (updates.ratioNum !== undefined) m.ratioNum = Math.max(1, parseInt(updates.ratioNum, 10) || 1);
    if (updates.ratioDen !== undefined) m.ratioDen = Math.max(1, parseInt(updates.ratioDen, 10) || 1);
    if (updates.customBpm !== undefined) m.customBpm = Math.max(20, Math.min(500, Number(updates.customBpm) || this.baseBpm));
    if (updates.color !== undefined) m.color = updates.color;
    if (updates.repeat !== undefined) m.repeat = Math.max(1, Math.min(999, parseInt(updates.repeat, 10) || 1));

    // Suporte a metadados de Bossa e cópia na escrita (copy-on-write)
    if (updates.isLinked !== undefined) {
      m.isLinked = !!updates.isLinked;
    }
    if (updates.isLocallyModified !== undefined) {
      m.isLocallyModified = !!updates.isLocallyModified;
    }
    if (updates.sourcePieceId !== undefined) {
      m.sourcePieceId = updates.sourcePieceId;
    }
    if (updates.sourcePieceName !== undefined) {
      m.sourcePieceName = updates.sourcePieceName;
    }

    // Se o compasso faz parte de uma bossa vinculada e sofreu edição sem passar isLinked explicitamente,
    // marca automaticamente como personalização local para não ser sobrescrito pelo auto-sync
    if (m.sourcePieceId && m.isLinked && updates.isLinked === undefined && (
      updates.nickname !== undefined ||
      updates.beats !== undefined ||
      updates.tempoMode !== undefined ||
      updates.ratioNum !== undefined ||
      updates.ratioDen !== undefined ||
      updates.customBpm !== undefined ||
      updates.repeat !== undefined
    )) {
      m.isLinked = false;
      m.isLocallyModified = true;
    }

    this.recalculateTimings();
    this.notify(`Atualizou compasso ${index + 1}`);
  }

  // Agrupamento: criar ou atualizar grupo
  addGroup(name, color, startMeasure, endMeasure) {
    if (this.measures.length === 0) return null;
    const start = Math.max(0, Math.min(startMeasure, endMeasure));
    const end = Math.min(this.measures.length - 1, Math.max(startMeasure, endMeasure));

    const newGroup = {
      id: `grp-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      name: (name || "Novo Grupo").trim(),
      color: color || "#3b82f6",
      startMeasure: start,
      endMeasure: end
    };

    this.groups.push(newGroup);
    this.notify(`Criou grupo '${newGroup.name}'`);
    return newGroup;
  }

  updateGroup(groupId, updates) {
    const grp = this.groups.find(g => g.id === groupId);
    if (!grp) return;

    if (updates.name !== undefined) grp.name = updates.name.trim() || "Grupo";
    if (updates.color !== undefined) grp.color = updates.color;
    if (updates.startMeasure !== undefined && updates.endMeasure !== undefined && this.measures.length > 0) {
      grp.startMeasure = Math.max(0, Math.min(updates.startMeasure, updates.endMeasure));
      grp.endMeasure = Math.min(this.measures.length - 1, Math.max(updates.startMeasure, updates.endMeasure));
    }
    this.notify(`Atualizou grupo '${grp.name}'`);
  }

  removeGroup(groupId) {
    this.groups = this.groups.filter(g => g.id !== groupId);
    this.notify("Removeu grupo");
  }

  // =========================================================================
  // SISTEMA DE BOSSAS / APRESENTAÇÕES POR REFERÊNCIA
  // =========================================================================

  // Sincroniza silenciosamente todas as bossas vinculadas com a fonte original
  syncLinkedBossas() {
    if (!this.measures || this.measures.length === 0) return 0;
    
    // Identifica todos os sourcePieceIds vinculados
    const linkedPieceIds = new Set();
    this.measures.forEach(m => {
      if (m.sourcePieceId && m.isLinked) {
        linkedPieceIds.add(m.sourcePieceId);
      }
    });

    if (linkedPieceIds.size === 0) return 0;

    const library = this.getLibraryPieces();
    let updatedCount = 0;

    linkedPieceIds.forEach(pieceId => {
      // Busca a peça original na biblioteca ou nos presets
      const origPiece = library.find(p => p.id === pieceId) 
        || PRESETS.find(p => p.id === pieceId);

      if (!origPiece || !Array.isArray(origPiece.measures) || origPiece.measures.length === 0) {
        return;
      }

      // Atualiza nome da bossa nos grupos se mudou
      this.groups.forEach(g => {
        if (g.sourcePieceId === pieceId && g.isBossaBlock) {
          g.sourcePieceName = origPiece.name;
          if (g.isLinked && !g.name.includes(origPiece.name)) {
            g.name = `🔗 ${origPiece.name}`;
          }
        }
      });

      // Mapeia os compassos da peça original por ID para correspondência precisa
      const origMeasureMap = new Map();
      origPiece.measures.forEach((om) => {
        if (om.id) origMeasureMap.set(om.id, om);
      });

      // Atualiza os compassos que estão vinculados e não foram modificados localmente
      this.measures.forEach((m) => {
        if (m.sourcePieceId === pieceId && m.isLinked && !m.isLocallyModified) {
          let targetOrig = null;
          if (m.sourceMeasureId && origMeasureMap.has(m.sourceMeasureId)) {
            targetOrig = origMeasureMap.get(m.sourceMeasureId);
          } else {
            // Acha o índice relativo do compasso dentro da bossa
            const bossaMeasuresInPiece = this.measures.filter(item => item.sourcePieceId === pieceId);
            const relIdx = bossaMeasuresInPiece.indexOf(m);
            if (relIdx >= 0 && relIdx < origPiece.measures.length) {
              targetOrig = origPiece.measures[relIdx];
            }
          }

          if (targetOrig) {
            // Atualiza propriedades musicais preservando personalizações
            m.nickname = targetOrig.nickname || m.nickname;
            m.beats = targetOrig.beats || m.beats;
            m.beatUnit = targetOrig.beatUnit || m.beatUnit;
            m.tempoMode = targetOrig.tempoMode || m.tempoMode;
            m.ratioNum = targetOrig.ratioNum || m.ratioNum;
            m.ratioDen = targetOrig.ratioDen || m.ratioDen;
            m.customBpm = targetOrig.customBpm || m.customBpm;
            m.repeat = targetOrig.repeat || m.repeat;
            m.sourcePieceName = origPiece.name;
            updatedCount++;
          }
        }
      });
    });

    if (updatedCount > 0) {
      this.recalculateTimings();
    }
    return updatedCount;
  }

  // Insere uma Bossa / Peça completa na partitura (por referência vinculada ou cópia estática)
  insertBossa(bossaPiece, targetIndex = -1, isLinked = true) {
    if (!bossaPiece) return null;

    const sourceMeasures = Array.isArray(bossaPiece.measures) && bossaPiece.measures.length > 0
      ? bossaPiece.measures
      : [
          {
            id: `m-bossa-default`,
            nickname: bossaPiece.name || "Bossa",
            beats: 4,
            beatUnit: 4,
            tempoMode: "ratio",
            ratioNum: 1,
            ratioDen: 1,
            customBpm: bossaPiece.baseBpm || this.baseBpm,
            color: "#8b5cf6",
            repeat: 1
          }
        ];

    // Posição de inserção
    const insertPos = (targetIndex >= 0 && targetIndex < this.measures.length)
      ? targetIndex + 1
      : this.measures.length;

    // Cores temáticas para blocos de bossas
    const bossaColors = [
      "#8b5cf6", // Violeta
      "#06b6d4", // Ciano
      "#10b981", // Esmeralda
      "#f59e0b", // Âmbar
      "#ec4899", // Rosa choque
      "#3b82f6"  // Azul royal
    ];
    const colorIdx = this.groups.filter(g => g.isBossaBlock).length % bossaColors.length;
    const bossaColor = bossaPiece.color || bossaColors[colorIdx];

    // Clona compassos e atribui metadados de referência
    const bossaMeasures = sourceMeasures.map((om, idx) => ({
      id: `m-${Date.now()}-${idx}-${Math.random().toString(36).substr(2, 4)}`,
      nickname: (om.nickname || "").trim() || `${bossaPiece.name} (${idx + 1})`,
      beats: Math.max(1, Math.min(32, parseInt(om.beats, 10) || 4)),
      beatUnit: [2, 4, 8, 16].includes(parseInt(om.beatUnit, 10)) ? parseInt(om.beatUnit, 10) : 4,
      tempoMode: om.tempoMode === "fixed" ? "fixed" : "ratio",
      ratioNum: Math.max(1, parseInt(om.ratioNum, 10) || 1),
      ratioDen: Math.max(1, parseInt(om.ratioDen, 10) || 1),
      customBpm: Math.max(20, Math.min(500, Number(om.customBpm) || bossaPiece.baseBpm || this.baseBpm)),
      color: bossaColor,
      repeat: Math.max(1, Math.min(999, parseInt(om.repeat, 10) || 1)),
      sourcePieceId: bossaPiece.id || null,
      sourcePieceName: bossaPiece.name || "Bossa",
      sourceMeasureId: om.id || null,
      isLinked: !!isLinked,
      isLocallyModified: false
    }));

    const count = bossaMeasures.length;

    // Ajusta índices de grupos existentes que estejam após o ponto de inserção
    this.groups.forEach(g => {
      if (g.startMeasure >= insertPos) g.startMeasure += count;
      if (g.endMeasure >= insertPos) g.endMeasure += count;
    });

    // Insere os compassos na partitura
    this.measures.splice(insertPos, 0, ...bossaMeasures);

    // Cria o Grupo da Bossa (com identificação de bloco)
    const bossaGroup = {
      id: `grp-bossa-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      name: isLinked ? `🔗 ${bossaPiece.name || "Bossa"}` : `${bossaPiece.name || "Bossa"}`,
      color: bossaColor,
      startMeasure: insertPos,
      endMeasure: insertPos + count - 1,
      isBossaBlock: true,
      sourcePieceId: bossaPiece.id || null,
      sourcePieceName: bossaPiece.name || "Bossa",
      isLinked: !!isLinked
    };
    this.groups.push(bossaGroup);

    this.recalculateTimings();
    this.notify(`Inseriu ${isLinked ? 'bossa vinculada' : 'cópia da bossa'} '${bossaPiece.name}' (${count} comp.)`);
    return {
      group: bossaGroup,
      measures: bossaMeasures,
      startIndex: insertPos,
      count: count
    };
  }

  // Sincroniza manualmente um bloco específico de bossa
  syncBossaBlock(groupId) {
    const grp = this.groups.find(g => g.id === groupId);
    if (!grp || !grp.sourcePieceId) return false;

    const library = this.getLibraryPieces();
    const origPiece = library.find(p => p.id === grp.sourcePieceId) 
      || PRESETS.find(p => p.id === grp.sourcePieceId);

    if (!origPiece || !Array.isArray(origPiece.measures)) return false;

    let updated = 0;
    const start = Math.max(0, grp.startMeasure);
    const end = Math.min(this.measures.length - 1, grp.endMeasure);

    for (let i = start; i <= end; i++) {
      const m = this.measures[i];
      if (m && m.sourcePieceId === grp.sourcePieceId && m.isLinked && !m.isLocallyModified) {
        const origM = origPiece.measures.find(om => om.id === m.sourceMeasureId) 
          || origPiece.measures[i - start];
        if (origM) {
          m.nickname = origM.nickname || m.nickname;
          m.beats = origM.beats;
          m.beatUnit = origM.beatUnit;
          m.tempoMode = origM.tempoMode;
          m.ratioNum = origM.ratioNum;
          m.ratioDen = origM.ratioDen;
          m.customBpm = origM.customBpm;
          m.repeat = origM.repeat || 1;
          updated++;
        }
      }
    }

    if (updated > 0) {
      this.recalculateTimings();
      this.notify(`Sincronizou ${updated} compassos da bossa '${origPiece.name}'`);
    }
    return true;
  }

  // Desvincula todos os compassos de um bloco de bossa (torna 100% locais e independentes)
  unlinkBossaBlock(groupId) {
    const grp = this.groups.find(g => g.id === groupId);
    if (!grp) return false;

    const start = Math.max(0, grp.startMeasure);
    const end = Math.min(this.measures.length - 1, grp.endMeasure);

    for (let i = start; i <= end; i++) {
      const m = this.measures[i];
      if (m) {
        m.isLinked = false;
        m.isLocallyModified = true;
      }
    }

    grp.name = grp.name.replace(/^🔗\s*/, '');
    grp.isLinked = false;
    grp.isBossaBlock = false;

    this.notify(`Desvinculou bossa '${grp.name}' (agora é independente)`);
    return true;
  }

  // Desvincula um único compasso para edição local livre
  unlinkMeasure(measureIndex) {
    if (measureIndex < 0 || measureIndex >= this.measures.length) return false;
    const m = this.measures[measureIndex];
    m.isLinked = false;
    m.isLocallyModified = true;
    this.notify(`Desvinculou compasso ${measureIndex + 1} para edição local`);
    return true;
  }

  // Restaura um compasso modificado de volta para a versão da bossa original
  restoreMeasureFromBossa(measureIndex) {
    if (measureIndex < 0 || measureIndex >= this.measures.length) return false;
    const m = this.measures[measureIndex];
    if (!m.sourcePieceId) return false;

    const library = this.getLibraryPieces();
    const origPiece = library.find(p => p.id === m.sourcePieceId) 
      || PRESETS.find(p => p.id === m.sourcePieceId);

    if (!origPiece || !Array.isArray(origPiece.measures)) return false;

    const origM = origPiece.measures.find(om => om.id === m.sourceMeasureId) 
      || origPiece.measures[0];

    if (!origM) return false;

    m.nickname = origM.nickname || m.nickname;
    m.beats = origM.beats;
    m.beatUnit = origM.beatUnit;
    m.tempoMode = origM.tempoMode;
    m.ratioNum = origM.ratioNum;
    m.ratioDen = origM.ratioDen;
    m.customBpm = origM.customBpm;
    m.repeat = origM.repeat || 1;
    m.isLinked = true;
    m.isLocallyModified = false;

    this.recalculateTimings();
    this.notify(`Restaurou compasso ${measureIndex + 1} da bossa original`);
    return true;
  }

  // Salva uma seleção de compassos como uma nova Bossa / Peça na biblioteca local
  saveMeasuresAsBossa(indices, bossaName) {
    if (!indices || indices.length === 0) return null;
    const sorted = Array.from(new Set(indices))
      .filter(idx => typeof idx === 'number' && idx >= 0 && idx < this.measures.length)
      .sort((a, b) => a - b);

    if (sorted.length === 0) return null;

    const name = (bossaName || "").trim() || `Bossa (${sorted.length} comp.)`;
    const newId = `piece-bossa-${Date.now()}`;

    const bossaMeasures = sorted.map((idx, i) => {
      const m = this.measures[idx];
      return {
        id: `m-bossa-${Date.now()}-${i}`,
        nickname: m.nickname || `Compasso ${i + 1}`,
        beats: m.beats,
        beatUnit: m.beatUnit,
        tempoMode: m.tempoMode,
        ratioNum: m.ratioNum,
        ratioDen: m.ratioDen,
        customBpm: m.customBpm,
        color: m.color || "#8b5cf6",
        repeat: m.repeat || 1
      };
    });

    const bossaData = {
      id: newId,
      name: name,
      description: `Bossa extraída da apresentação '${this.name}'`,
      presentationBpm: this.presentationBpm,
      baseBpm: this.baseBpm,
      isBossa: true,
      measures: bossaMeasures,
      groups: [
        {
          id: `grp-${newId}`,
          name: name,
          color: "#8b5cf6",
          startMeasure: 0,
          endMeasure: bossaMeasures.length - 1,
          isBossaBlock: true
        }
      ],
      updatedAt: Date.now(),
      createdAt: Date.now()
    };

    // Salva na biblioteca local
    let library = this.getLibraryPieces();
    library.unshift(bossaData);
    if (library.length > 100) library = library.slice(0, 100);
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
      } catch (e) {
        console.warn("Não foi possível salvar bossa na biblioteca local:", e);
      }
    }

    this.notify(`Criou e salvou nova bossa '${name}'`);
    return bossaData;
  }

  // Calcula timings detalhados para qualquer lista de compassos (usado em prévias de áudio)
  calculateTimingsForMeasures(measures, baseBpm = 120) {
    if (!Array.isArray(measures) || measures.length === 0) {
      return { timings: [], totalDuration: 0 };
    }
    let accumulatedTime = 0;
    const timings = [];
    let globalTimingIndex = 0;

    measures.forEach((m, idx) => {
      const repeat = Math.max(1, Math.min(999, parseInt(m.repeat, 10) || 1));
      let effectiveBpm = baseBpm;
      if (m.tempoMode === "ratio") {
        effectiveBpm = baseBpm * ((m.ratioNum || 1) / (m.ratioDen || 1));
      } else {
        effectiveBpm = m.customBpm || baseBpm;
      }
      const beatDuration = 60 / effectiveBpm;
      const measureDuration = (m.beats || 4) * beatDuration;

      for (let r = 0; r < repeat; r++) {
        timings.push({
          timingIndex: globalTimingIndex++,
          measureIndex: idx,
          repeatIteration: r,
          repeatCount: repeat,
          startTime: accumulatedTime,
          endTime: accumulatedTime + measureDuration,
          duration: measureDuration,
          effectiveBpm: effectiveBpm,
          beatDuration: beatDuration,
          beats: m.beats || 4,
          beatUnit: m.beatUnit || 4
        });
        accumulatedTime += measureDuration;
      }
    });

    return { timings, totalDuration: accumulatedTime };
  }

  // Retorna o grupo ao qual pertence o compasso, se houver
  getGroupByMeasureIndex(measureIndex) {
    if (measureIndex < 0 || this.measures.length === 0) return null;
    return this.groups.find(g => measureIndex >= g.startMeasure && measureIndex <= g.endMeasure) || null;
  }

  // Retorna o primeiro timing (repetição 0) de um compasso (O(1))
  getFirstTimingForMeasure(measureIndex) {
    if (!this.firstTimingByMeasure) return null;
    return this.firstTimingByMeasure.get(measureIndex) || null;
  }

  // Retorna o último timing (última repetição) de um compasso (O(1))
  getLastTimingForMeasure(measureIndex) {
    if (!this.lastTimingByMeasure) return null;
    return this.lastTimingByMeasure.get(measureIndex) || null;
  }

  // Retorna o timing de uma repetição específica de um compasso
  getTimingForMeasure(measureIndex, repeatIteration = 0) {
    if (this.measureTimings.length === 0) return null;
    const match = this.measureTimings.find(t => t.measureIndex === measureIndex && t.repeatIteration === repeatIteration);
    return match || this.getFirstTimingForMeasure(measureIndex);
  }

  // Recálculo matemático de tempos precisos considerando repetições
  recalculateTimings() {
    let accumulatedTime = 0;
    this.measureTimings = [];
    this.firstTimingByMeasure = new Map();
    this.lastTimingByMeasure = new Map();

    if (this.measures.length === 0) {
      this.totalDuration = 0;
      return;
    }

    let globalTimingIndex = 0;

    this.measures.forEach((m, idx) => {
      // Garante repetição válida (padrão 1, mínimo 1, máximo 999)
      m.repeat = Math.max(1, Math.min(999, parseInt(m.repeat, 10) || 1));

      // Cálculo do BPM efetivo para a semínima
      let effectiveBpm = this.baseBpm;
      if (m.tempoMode === "ratio") {
        effectiveBpm = this.baseBpm * (m.ratioNum / m.ratioDen);
      } else {
        effectiveBpm = m.customBpm;
      }

      // Duração de um tempo (pulso) em segundos:
      // O andamento (BPM) define diretamente a frequência dos tempos/pulsos.
      const beatDuration = 60 / effectiveBpm;
      const measureDuration = m.beats * beatDuration;

      for (let r = 0; r < m.repeat; r++) {
        const timing = {
          timingIndex: globalTimingIndex++,
          measureIndex: idx,
          repeatIteration: r,
          repeatCount: m.repeat,
          startTime: accumulatedTime,
          endTime: accumulatedTime + measureDuration,
          duration: measureDuration,
          effectiveBpm: effectiveBpm,
          beatDuration: beatDuration,
          beats: m.beats,
          beatUnit: m.beatUnit
        };

        this.measureTimings.push(timing);
        if (!this.firstTimingByMeasure.has(idx)) {
          this.firstTimingByMeasure.set(idx, timing);
        }
        this.lastTimingByMeasure.set(idx, timing);

        accumulatedTime += measureDuration;
      }
    });

    this.totalDuration = accumulatedTime;
  }

  // Busca compasso e tempo atual dado um tempo em segundos via Busca Binária O(log N)
  getPositionAtTime(seconds) {
    if (this.measures.length === 0 || this.measureTimings.length === 0) {
      return {
        measureIndex: -1,
        timingIndex: 0,
        repeatIteration: 0,
        repeatCount: 1,
        beatIndex: 0,
        beatProgress: 0,
        measure: null,
        timing: null,
        effectiveBpm: this.baseBpm
      };
    }

    if (seconds <= 0) {
      const first = this.measureTimings[0];
      return {
        measureIndex: first.measureIndex,
        timingIndex: 0,
        repeatIteration: first.repeatIteration,
        repeatCount: first.repeatCount,
        beatIndex: 0,
        beatProgress: 0,
        measure: this.measures[first.measureIndex] || null,
        timing: first,
        effectiveBpm: first?.effectiveBpm || this.baseBpm
      };
    }

    if (seconds >= this.totalDuration) {
      const lastTiming = this.measureTimings[this.measureTimings.length - 1];
      const mIdx = lastTiming ? lastTiming.measureIndex : 0;
      return {
        measureIndex: mIdx,
        timingIndex: this.measureTimings.length - 1,
        repeatIteration: lastTiming ? lastTiming.repeatIteration : 0,
        repeatCount: lastTiming ? lastTiming.repeatCount : 1,
        beatIndex: lastTiming ? lastTiming.beats - 1 : 0,
        beatProgress: 1,
        measure: this.measures[mIdx] || null,
        timing: lastTiming || null,
        effectiveBpm: lastTiming?.effectiveBpm || this.baseBpm
      };
    }

    // Busca binária O(log N) de alto desempenho (máximo 8 iterações mesmo com 500 compassos)
    let low = 0;
    let high = this.measureTimings.length - 1;
    let foundIdx = -1;

    while (low <= high) {
      const mid = (low + high) >> 1;
      const t = this.measureTimings[mid];
      if (seconds < t.startTime) {
        high = mid - 1;
      } else if (seconds >= t.endTime) {
        low = mid + 1;
      } else {
        foundIdx = mid;
        break;
      }
    }

    const t = foundIdx !== -1 ? this.measureTimings[foundIdx] : (this.measureTimings[Math.max(0, Math.min(this.measureTimings.length - 1, low))]);
    if (t) {
      const timeInMeasure = Math.max(0, seconds - t.startTime);
      const beatIndex = Math.min(t.beats - 1, Math.max(0, Math.floor(timeInMeasure / t.beatDuration)));
      const beatProgress = Math.min(1, Math.max(0, (timeInMeasure - (beatIndex * t.beatDuration)) / t.beatDuration));

      return {
        measureIndex: t.measureIndex,
        timingIndex: t.timingIndex,
        repeatIteration: t.repeatIteration,
        repeatCount: t.repeatCount,
        beatIndex: beatIndex,
        beatProgress: beatProgress,
        measure: this.measures[t.measureIndex] || null,
        timing: t,
        effectiveBpm: t.effectiveBpm
      };
    }

    const last = this.measureTimings[this.measureTimings.length - 1];
    const mIdx = last ? last.measureIndex : 0;
    return {
      measureIndex: mIdx,
      timingIndex: this.measureTimings.length - 1,
      repeatIteration: last ? last.repeatIteration : 0,
      repeatCount: last ? last.repeatCount : 1,
      beatIndex: last ? last.beats - 1 : 0,
      beatProgress: 1,
      measure: this.measures[mIdx] || null,
      timing: last || null,
      effectiveBpm: last?.effectiveBpm || this.baseBpm
    };
  }

  // Tempo em segundos a partir do início de um compasso (opcionalmente escolhendo a repetição)
  getTimeAtMeasure(measureIndex, beatIndex = 0, repeatIteration = 0) {
    if (this.measures.length === 0 || this.measureTimings.length === 0) return 0;
    const timing = this.getTimingForMeasure(measureIndex, repeatIteration);
    if (!timing) return 0;
    return timing.startTime + (Math.max(0, Math.min(timing.beats - 1, beatIndex)) * timing.beatDuration);
  }

  // Inscrição de ouvintes para atualização de interface
  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  // Salvar no localStorage automaticamente
  saveToLocalStorage() {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
    try {
      const data = {
        app: "Sérgio Simulator",
        version: "1.0.0",
        savedAt: new Date().toISOString(),
        piece: {
          id: this.id,
          name: this.name,
          description: this.description,
          presentationBpm: this.presentationBpm,
          baseBpm: this.presentationBpm,
          practiceBpm: this.baseBpm,
          groups: this.groups,
          measures: this.measures
        }
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      if (this.id && this.measures && this.measures.length > 0) {
        this.saveCurrentPieceToLibrary();
      }
      window.dispatchEvent(new CustomEvent('sergio:saved', { 
        detail: { count: this.measures.length, name: this.name } 
      }));
    } catch (e) {
      console.warn("Erro ao salvar no localStorage:", e);
    }
  }

  // Captura um instantâneo do estado estrutural da peça
  getSnapshot() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      presentationBpm: this.presentationBpm,
      baseBpm: this.baseBpm,
      isCustomPracticeBpm: this.isCustomPracticeBpm,
      measures: this.measures.map(m => ({ ...m })),
      groups: this.groups.map(g => ({ ...g }))
    };
  }

  // Restaura um instantâneo
  applySnapshot(snapshot) {
    if (!snapshot) return;
    this.id = snapshot.id;
    this.name = snapshot.name;
    this.description = snapshot.description || "";
    this.presentationBpm = snapshot.presentationBpm || 120;
    this.baseBpm = snapshot.baseBpm || this.presentationBpm;
    this.isCustomPracticeBpm = Boolean(snapshot.isCustomPracticeBpm);
    this.measures = (snapshot.measures || []).map(m => ({ ...m }));
    this.groups = (snapshot.groups || []).map(g => ({ ...g }));
    this.recalculateTimings();
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  // Desfaz a última ação (Ctrl+Z)
  undo() {
    if (!this.canUndo()) return null;
    const entry = this.undoStack.pop();
    const current = this.getSnapshot();
    this.redoStack.push({
      action: entry.action,
      snapshot: current
    });
    this.isUndoingOrRedoing = true;
    try {
      this.applySnapshot(entry.snapshot);
      this.currentSnapshot = this.getSnapshot();
      this.notify(`Desfez: ${entry.action}`, false, false);
      return entry.action;
    } finally {
      this.isUndoingOrRedoing = false;
    }
  }

  // Refaz a última ação desfeita (Ctrl+Y / Ctrl+Shift+Z)
  redo() {
    if (!this.canRedo()) return null;
    const entry = this.redoStack.pop();
    const current = this.getSnapshot();
    this.undoStack.push({
      action: entry.action,
      snapshot: current
    });
    this.isUndoingOrRedoing = true;
    try {
      this.applySnapshot(entry.snapshot);
      this.currentSnapshot = this.getSnapshot();
      this.notify(`Refez: ${entry.action}`, false, false);
      return entry.action;
    } finally {
      this.isUndoingOrRedoing = false;
    }
  }

  notify(action = "Alteração na peça", isRemote = false, isLocalOnly = false) {
    // Grava histórico de Desfazer se for alteração local e não for chamada durante undo/redo
    if (!isRemote && !this.isUndoingOrRedoing) {
      if (this.currentSnapshot) {
        this.undoStack.push({
          action: action,
          snapshot: this.currentSnapshot
        });
        if (this.undoStack.length > this.maxUndoSteps) {
          this.undoStack.shift();
        }
        this.redoStack = [];
      }
      this.currentSnapshot = this.getSnapshot();
    }

    this.saveToLocalStorage();
    for (const cb of this.listeners) {
      try {
        cb(this, action, isRemote, isLocalOnly);
      } catch (err) {
        console.error("Erro no ouvinte de estado:", err);
      }
    }
  }

  // Exportação para JSON
  exportJSON() {
    const data = {
      app: "Sérgio Simulator",
      version: "1.0.0",
      exportedAt: new Date().toISOString(),
      piece: {
        id: this.id,
        name: this.name,
        description: this.description,
        presentationBpm: this.presentationBpm,
        baseBpm: this.presentationBpm,
        practiceBpm: this.baseBpm,
        groups: this.groups,
        measures: this.measures
      }
    };
    return JSON.stringify(data, null, 2);
  }

  // Importação a partir de JSON
  importJSON(jsonString) {
    try {
      const parsed = JSON.parse(jsonString);
      const pieceData = parsed.piece || parsed;
      if (!pieceData.measures || !Array.isArray(pieceData.measures)) {
        throw new Error("Formato inválido: a peça deve conter uma lista de compassos.");
      }
      this.loadPieceData(pieceData);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

export const state = new PieceState();
