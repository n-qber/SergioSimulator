/**
 * Gerenciador de Estado do Sérgio Simulator
 * Controla a peça, compassos, grupos, andamento base, cálculos matemáticos de tempo e importação/exportação.
 */

import { PRESETS } from './presets.js';

class PieceState {
  constructor() {
    this.listeners = new Set();
    this.resetToDefault();
  }

  resetToDefault() {
    // Carrega o preset padrão
    const defaultPreset = PRESETS[0];
    this.loadPieceData(JSON.parse(JSON.stringify(defaultPreset)));
  }

  loadPieceData(data) {
    this.id = data.id || `piece-${Date.now()}`;
    this.name = data.name || "Peça nº 1";
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
      color: m.color || "#ff334b"
    }));

    if (this.measures.length === 0) {
      this.measures.push({
        id: `m-init`,
        nickname: "",
        beats: 4,
        beatUnit: 4,
        tempoMode: "ratio",
        ratioNum: 1,
        ratioDen: 1,
        customBpm: this.baseBpm,
        color: "#ff334b"
      });
    }

    this.groups = (data.groups || []).map((g, idx) => ({
      id: g.id || `grp-${Date.now()}-${idx}`,
      name: g.name || `Grupo ${idx + 1}`,
      color: g.color || "#3b82f6",
      startMeasure: Math.max(0, parseInt(g.startMeasure, 10) || 0),
      endMeasure: Math.min(this.measures.length - 1, Math.max(0, parseInt(g.endMeasure, 10) || 0))
    }));

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
      color: template?.color || prevMeasure?.color || "#ff334b"
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
      nickname: target.nickname ? `${target.nickname} (cópia)` : ""
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

  // Remover compasso
  removeMeasure(index) {
    if (this.measures.length <= 1) {
      alert("A peça precisa ter pelo menos 1 compasso.");
      return;
    }
    if (index < 0 || index >= this.measures.length) return;

    this.measures.splice(index, 1);

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

    this.recalculateTimings();
    this.notify();
  }

  // Agrupamento: criar ou atualizar grupo
  addGroup(name, color, startMeasure, endMeasure) {
    const start = Math.max(0, Math.min(startMeasure, endMeasure));
    const end = Math.min(this.measures.length - 1, Math.max(startMeasure, endMeasure));

    const newGroup = {
      id: `grp-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      name: (name || "Novo Grupo").trim(),
      color: color || "#3b82f6",
      startMeasure: start,
      endMeasure: end
    };

    // Remove sobreposições exatas ou ajusta
    this.groups.push(newGroup);
    this.notify();
    return newGroup;
  }

  updateGroup(groupId, updates) {
    const grp = this.groups.find(g => g.id === groupId);
    if (!grp) return;

    if (updates.name !== undefined) grp.name = updates.name.trim() || "Grupo";
    if (updates.color !== undefined) grp.color = updates.color;
    if (updates.startMeasure !== undefined && updates.endMeasure !== undefined) {
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
    return this.groups.find(g => measureIndex >= g.startMeasure && measureIndex <= g.endMeasure) || null;
  }

  // Recálculo matemático de tempos precisos
  recalculateTimings() {
    let accumulatedTime = 0;
    this.measureTimings = [];

    this.measures.forEach((m, idx) => {
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

      const timing = {
        measureIndex: idx,
        startTime: accumulatedTime,
        endTime: accumulatedTime + measureDuration,
        duration: measureDuration,
        effectiveBpm: effectiveBpm,
        beatDuration: beatDuration,
        beats: m.beats,
        beatUnit: m.beatUnit
      };

      this.measureTimings.push(timing);
      accumulatedTime += measureDuration;
    });

    this.totalDuration = accumulatedTime;
  }

  // Busca compasso e tempo atual dado um tempo em segundos
  getPositionAtTime(seconds) {
    if (seconds <= 0 || this.measureTimings.length === 0) {
      const first = this.measureTimings[0];
      return {
        measureIndex: 0,
        beatIndex: 0,
        beatProgress: 0,
        measure: this.measures[0],
        timing: first,
        effectiveBpm: first?.effectiveBpm || this.baseBpm
      };
    }

    if (seconds >= this.totalDuration) {
      const lastIdx = this.measures.length - 1;
      const lastTiming = this.measureTimings[lastIdx];
      return {
        measureIndex: lastIdx,
        beatIndex: lastTiming.beats - 1,
        beatProgress: 1,
        measure: this.measures[lastIdx],
        timing: lastTiming,
        effectiveBpm: lastTiming.effectiveBpm
      };
    }

    // Busca binária ou linear já que a lista de compassos é tipicamente < 200
    for (let i = 0; i < this.measureTimings.length; i++) {
      const t = this.measureTimings[i];
      if (seconds >= t.startTime && seconds < t.endTime) {
        const timeInMeasure = seconds - t.startTime;
        const beatIndex = Math.min(t.beats - 1, Math.floor(timeInMeasure / t.beatDuration));
        const beatProgress = (timeInMeasure - (beatIndex * t.beatDuration)) / t.beatDuration;

        return {
          measureIndex: i,
          beatIndex: beatIndex,
          beatProgress: Math.min(1, Math.max(0, beatProgress)),
          measure: this.measures[i],
          timing: t,
          effectiveBpm: t.effectiveBpm
        };
      }
    }

    const last = this.measureTimings[this.measureTimings.length - 1];
    return {
      measureIndex: this.measures.length - 1,
      beatIndex: last.beats - 1,
      beatProgress: 1,
      measure: this.measures[this.measures.length - 1],
      timing: last,
      effectiveBpm: last.effectiveBpm
    };
  }

  // Tempo em segundos a partir do início de um compasso
  getTimeAtMeasure(measureIndex, beatIndex = 0) {
    const idx = Math.max(0, Math.min(this.measures.length - 1, measureIndex));
    const timing = this.measureTimings[idx];
    if (!timing) return 0;
    return timing.startTime + (Math.max(0, Math.min(timing.beats - 1, beatIndex)) * timing.beatDuration);
  }

  // Inscrição de ouvintes para atualização de interface
  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notify() {
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
