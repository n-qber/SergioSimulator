/**
 * Gerenciador de Estado do Sérgio Simulator
 * Controla a peça, compassos, grupos, andamento base, cálculos matemáticos de tempo e importação/exportação.
 */

import { PRESETS } from './presets.js';

const STORAGE_KEY = 'sergio_piece_data';

class PieceState {
  constructor() {
    this.listeners = new Set();
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

  loadPieceData(data) {
    this.id = data.id || `piece-${Date.now()}`;
    this.name = data.name !== undefined ? data.name : "Peça nº 1";
    this.description = data.description || "";
    this.baseBpm = Math.max(20, Math.min(400, Number(data.baseBpm) || 120));
    
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
      repeat: Math.max(1, Math.min(999, parseInt(m.repeat, 10) || 1))
    }));

    const maxIdx = this.measures.length > 0 ? this.measures.length - 1 : -1;
    this.groups = (data.groups || [])
      .filter(() => this.measures.length > 0)
      .map((g, idx) => ({
        id: g.id || `grp-${Date.now()}-${idx}`,
        name: g.name || `Grupo ${idx + 1}`,
        color: g.color || "#3b82f6",
        startMeasure: Math.max(0, Math.min(maxIdx, parseInt(g.startMeasure, 10) || 0)),
        endMeasure: Math.max(0, Math.min(maxIdx, parseInt(g.endMeasure, 10) || 0))
      }))
      .filter(g => g.startMeasure <= g.endMeasure);

    this.recalculateTimings();
    this.notify();
  }

  // Define andamento base com validação rigorosa (evita NaN e bugs de digitação)
  setBaseBpm(newBpm) {
    const parsed = parseFloat(newBpm);
    if (!isNaN(parsed) && parsed >= 20 && parsed <= 400) {
      this.baseBpm = Math.round(parsed);
      this.recalculateTimings();
      this.notify();
      return true;
    }
    return false;
  }

  setPieceName(name) {
    this.name = name.trim() || "Peça Sem Nome";
    this.notify();
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
    this.notify();
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
    this.notify();
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
    this.notify();
  }

  // Esvazia todos os compassos da peça
  clearAllMeasures() {
    this.measures = [];
    this.groups = [];
    this.recalculateTimings();
    this.notify();
  }

  // Reinicia para um arquivo/peça completamente nova
  createNewPiece(name = "Nova Peça", baseBpm = 120) {
    this.id = `piece-${Date.now()}`;
    this.name = name;
    this.description = "";
    this.baseBpm = Math.max(20, Math.min(400, parseInt(baseBpm, 10) || 120));
    this.measures = [];
    this.groups = [];
    this.recalculateTimings();
    this.notify();
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

    this.recalculateTimings();
    this.notify();
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
    this.notify();
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
    this.notify();
  }

  removeGroup(groupId) {
    this.groups = this.groups.filter(g => g.id !== groupId);
    this.notify();
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

      // Duração de um tempo em segundos:
      // O andamento é referente à semínima (beatUnit = 4).
      // Se beatUnit for 8 (colcheia), a duração é proporcional.
      const beatDuration = (60 / effectiveBpm) * (4 / m.beatUnit);
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
          baseBpm: this.baseBpm,
          groups: this.groups,
          measures: this.measures
        }
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      window.dispatchEvent(new CustomEvent('sergio:saved', { 
        detail: { count: this.measures.length, name: this.name } 
      }));
    } catch (e) {
      console.warn("Erro ao salvar no localStorage:", e);
    }
  }

  notify() {
    this.saveToLocalStorage();
    for (const cb of this.listeners) {
      try {
        cb(this);
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
        baseBpm: this.baseBpm,
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
