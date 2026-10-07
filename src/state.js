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
    this.libraryListeners = new Set();
    this.presentationBpm = 120;
    this.isCustomPracticeBpm = false;
    this.undoStack = [];
    this.redoStack = [];
    this.maxUndoSteps = 150;
    this.isUndoingOrRedoing = false;
    this.currentSnapshot = null;
    this.items = [];
    this.measures = [];
    this.groups = [];
    this.computedGroups = [];
    this.measureTimings = [];
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
        if (pieceData && (Array.isArray(pieceData.items) || Array.isArray(pieceData.measures))) {
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
    this.isBossa = data.isBossa !== undefined ? Boolean(data.isBossa) : Boolean(data.id?.startsWith('piece-bossa-') || data.id?.startsWith('bossa-'));
    this.variables = Array.isArray(data.variables) ? data.variables.map(v => ({ ...v })) : [];
    
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
    
    const hasItems = Array.isArray(data.items) && data.items.length > 0;
    const hasBossasInItems = hasItems && data.items.some(it => it.type === 'bossa');
    const isBossaGroup = (g) => Boolean(
      g && (
        g.isBossaBlock ||
        g.sourcePieceId ||
        g.id?.startsWith('grp-bossa-') ||
        g.id?.startsWith('bossa-') ||
        (g.name && (g.name.startsWith('🔗') || /bossa/i.test(g.name)))
      )
    );
    const hasBossaGroupsInLegacy = Array.isArray(data.groups) && data.groups.some(isBossaGroup);
    const hasBossaMeasuresInLegacy = Array.isArray(data.measures) && data.measures.some(m => m.sourcePieceId || m.isLinked);

    // Se data.items não possui bossas mas data.groups ou data.measures possuía bossas vinculadas/blocos,
    // significa que data.items foi achatado acidentalmente. Priorizamos a recuperação a partir dos grupos/medidas!
    const shouldUseLegacyMigration = !hasItems || (!hasBossasInItems && (hasBossaGroupsInLegacy || hasBossaMeasuresInLegacy));

    if (!shouldUseLegacyMigration && hasItems) {
      this.items = data.items.map((it, idx) => {
        if (it.type === 'bossa') {
          let bossaMs = Array.isArray(it.measures) ? it.measures : [];
          // Se as medidas do bossaItem vieram vazias mas temos data.measures legados, recupera-os!
          if (bossaMs.length === 0 && Array.isArray(data.measures) && data.measures.length > 0) {
            const matched = data.measures.filter(m => m.sourcePieceId && m.sourcePieceId === it.sourcePieceId);
            if (matched.length > 0) bossaMs = matched;
          }
          return {
            type: 'bossa',
            id: it.id || `bossa-${Date.now()}-${idx}`,
            name: (it.name || it.sourcePieceName || 'Bossa').replace(/^[🔗📦✏️🔓\s]+/, '').trim(),
            color: it.color || '#8b5cf6',
            repeat: Math.max(1, Math.min(999, parseInt(it.repeat, 10) || 1)),
            collapsed: it.collapsed !== undefined ? Boolean(it.collapsed) : true,
            isLinked: it.isLinked !== undefined ? Boolean(it.isLinked) : Boolean(it.sourcePieceId),
            tempoMode: it.tempoMode || 'inherit',
            bpm: it.bpm ? Number(it.bpm) : null,
            ratioNum: it.ratioNum ? Number(it.ratioNum) : 1,
            ratioDen: it.ratioDen ? Number(it.ratioDen) : 1,
            sourcePieceId: it.sourcePieceId || null,
            sourcePieceName: it.sourcePieceName || it.name || 'Bossa',
            measures: bossaMs,
            groups: Array.isArray(it.groups) ? it.groups : [],
            variables: Array.isArray(it.variables) ? it.variables : [],
            variableValues: (typeof it.variableValues === 'object' && it.variableValues !== null) ? { ...it.variableValues } : {}
          };
        }
        if (it.type === 'section') {
          return {
            type: 'section',
            id: it.id || `sec-${Date.now()}-${idx}`,
            name: (it.name || 'Seção').trim(),
            color: it.color || '#3b82f6',
            repeat: Math.max(1, Math.min(999, parseInt(it.repeat, 10) || 1)),
            repeatVariable: it.repeatVariable ? String(it.repeatVariable).trim() : null
          };
        }
        return {
          type: 'measure',
          id: it.id || `m-${Date.now()}-${idx}`,
          nickname: (it.nickname || '').trim(),
          beats: Math.max(1, Math.min(32, parseInt(it.beats, 10) || 4)),
          beatUnit: [2, 4, 8, 16].includes(parseInt(it.beatUnit, 10)) ? parseInt(it.beatUnit, 10) : 4,
          tempoMode: it.tempoMode === 'fixed' ? 'fixed' : 'ratio',
          ratioNum: Math.max(1, parseInt(it.ratioNum, 10) || 1),
          ratioDen: Math.max(1, parseInt(it.ratioDen, 10) || 1),
          customBpm: Math.max(20, Math.min(500, Number(it.customBpm) || this.baseBpm)),
          color: it.color || '#ff334b',
          repeat: Math.max(1, Math.min(999, parseInt(it.repeat, 10) || 1)),
          repeatVariable: it.repeatVariable ? String(it.repeatVariable).trim() : null
        };
      });
    } else {
      // Migração e recuperação on-the-fly de dados legados (measures + groups)
      const rawMeasures = data.measures || [];
      const rawGroups = data.groups || [];
      const migratedItems = [];
      let mIdx = 0;
      while (mIdx < rawMeasures.length) {
        let bossaGrp = rawGroups.find(g => isBossaGroup(g) && g.startMeasure === mIdx && g.endMeasure >= mIdx && g.endMeasure < rawMeasures.length);
        const curM = rawMeasures[mIdx];

        // Se houver compassos com sourcePieceId mesmo sem match exato de startMeasure no grupo
        if (!bossaGrp && curM && (curM.sourcePieceId || (curM.nickname && /bossa/i.test(curM.nickname)))) {
          bossaGrp = rawGroups.find(g => isBossaGroup(g) || (curM.sourcePieceId && g.sourcePieceId === curM.sourcePieceId));
          let endIdx = mIdx;
          while (endIdx + 1 < rawMeasures.length && (
            (curM.sourcePieceId && rawMeasures[endIdx + 1].sourcePieceId === curM.sourcePieceId) ||
            (!curM.sourcePieceId && rawMeasures[endIdx + 1].nickname && /bossa/i.test(rawMeasures[endIdx + 1].nickname))
          )) {
            endIdx++;
          }
          const bossaMs = rawMeasures.slice(mIdx, endIdx + 1);
          const cleanName = (curM.sourcePieceName || bossaGrp?.name || curM.nickname || 'Bossa').replace(/^[🔗📦✏️🔓\s]+/, '').trim();
          const isLinked = curM.isLinked !== undefined
            ? Boolean(curM.isLinked)
            : (bossaGrp?.isLinked !== undefined ? Boolean(bossaGrp.isLinked) : (bossaGrp?.name?.startsWith('🔗') || true));

          let srcId = curM.sourcePieceId || bossaGrp?.sourcePieceId || null;
          if (!srcId) {
            const orig = this.findBossaOrPiece(null, cleanName);
            if (orig) srcId = orig.id;
          }

          migratedItems.push({
            type: 'bossa',
            id: bossaGrp?.id || `bossa-${Date.now()}-${migratedItems.length}`,
            name: cleanName,
            color: curM.color || bossaGrp?.color || '#8b5cf6',
            repeat: Math.max(1, Math.min(999, parseInt(bossaGrp?.repeat || 1, 10))),
            collapsed: bossaGrp?.collapsed !== undefined ? Boolean(bossaGrp.collapsed) : true,
            isLinked: isLinked,
            sourcePieceId: srcId,
            sourcePieceName: cleanName,
            measures: bossaMs.map((bm, bIdx) => ({
              ...bm,
              sourcePieceId: srcId,
              sourcePieceName: cleanName,
              isLinked: isLinked
            }))
          });
          mIdx = endIdx + 1;
          continue;
        }

        if (bossaGrp) {
          const bossaMs = rawMeasures.slice(bossaGrp.startMeasure, bossaGrp.endMeasure + 1);
          const cleanName = (bossaGrp.name || bossaGrp.sourcePieceName || 'Bossa').replace(/^[🔗📦✏️🔓\s]+/, '').trim();
          const isLinked = bossaGrp.isLinked !== undefined
            ? Boolean(bossaGrp.isLinked)
            : (bossaGrp.name?.startsWith('🔗') || Boolean(bossaGrp.sourcePieceId) || true);

          let srcId = bossaGrp.sourcePieceId || null;
          if (!srcId) {
            const mWithSrc = bossaMs.find(m => m.sourcePieceId);
            if (mWithSrc) srcId = mWithSrc.sourcePieceId;
          }
          if (!srcId) {
            const orig = this.findBossaOrPiece(null, cleanName);
            if (orig) srcId = orig.id;
          }

          migratedItems.push({
            type: 'bossa',
            id: bossaGrp.id || `bossa-${Date.now()}-${migratedItems.length}`,
            name: cleanName,
            color: bossaGrp.color || '#8b5cf6',
            repeat: Math.max(1, Math.min(999, parseInt(bossaGrp.repeat, 10) || 1)),
            collapsed: bossaGrp.collapsed !== undefined ? Boolean(bossaGrp.collapsed) : true,
            isLinked: isLinked,
            sourcePieceId: srcId,
            sourcePieceName: cleanName,
            measures: bossaMs.map((bm, bIdx) => ({
              ...bm,
              sourcePieceId: srcId,
              sourcePieceName: cleanName,
              isLinked: isLinked
            }))
          });
          mIdx = bossaGrp.endMeasure + 1;
        } else {
          migratedItems.push({
            type: 'measure',
            id: curM.id || `m-${Date.now()}-${mIdx}`,
            nickname: (curM.nickname || '').trim(),
            beats: Math.max(1, Math.min(32, parseInt(curM.beats, 10) || 4)),
            beatUnit: [2, 4, 8, 16].includes(parseInt(curM.beatUnit, 10)) ? parseInt(curM.beatUnit, 10) : 4,
            tempoMode: curM.tempoMode === 'fixed' ? 'fixed' : 'ratio',
            ratioNum: Math.max(1, parseInt(curM.ratioNum, 10) || 1),
            ratioDen: Math.max(1, parseInt(curM.ratioDen, 10) || 1),
            customBpm: Math.max(20, Math.min(500, Number(curM.customBpm) || this.baseBpm)),
            color: curM.color || '#ff334b',
            repeat: Math.max(1, Math.min(999, parseInt(curM.repeat, 10) || 1))
          });
          mIdx++;
        }
      }
      this.items = migratedItems;
    }

    // Se a peça possui grupos legados (não-bossa) e this.items ainda não possui seções, migra para seções:
    if (Array.isArray(data.groups) && !this.items.some(it => it.type === 'section')) {
      const nonBossaLegacyGroups = data.groups.filter(g => !isBossaGroup(g));
      if (nonBossaLegacyGroups.length > 0) {
        // Ordena do final para o início para não deslocar índices de inserção anteriores
        nonBossaLegacyGroups.sort((a, b) => b.startMeasure - a.startMeasure).forEach(grp => {
          let targetItemIdx = 0;
          let mCount = 0;
          for (let i = 0; i < this.items.length; i++) {
            if (mCount === grp.startMeasure) {
              targetItemIdx = i;
              break;
            }
            if (this.items[i].type === 'measure') mCount++;
            else if (this.items[i].type === 'bossa') mCount += (this.items[i].measures?.length || 1);
          }
          this.items.splice(targetItemIdx, 0, {
            type: 'section',
            id: grp.id || `sec-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
            name: (grp.name || 'Seção').trim(),
            color: grp.color || '#3b82f6',
            repeat: Math.max(1, Math.min(999, parseInt(grp.repeat, 10) || 1)),
            repeatVariable: grp.repeatVariable ? String(grp.repeatVariable).trim() : null
          });
        });
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

  // =========================================================================
  // OPERAÇÕES DE ITENS E COMPASSOS NA PARTITURA
  // =========================================================================

  // Mover qualquer item da partitura (compasso avulso ou bloco bossa inteiro)
  moveItem(fromIndex, toIndex) {
    if (fromIndex < 0 || fromIndex >= this.items.length) return false;
    if (toIndex < 0 || toIndex >= this.items.length) return false;
    if (fromIndex === toIndex) return false;

    const [moved] = this.items.splice(fromIndex, 1);
    this.items.splice(toIndex, 0, moved);

    this.recalculateTimings();
    const label = moved.type === 'bossa' ? `bossa '${moved.name}'` : `compasso`;
    this.notify(`Moveu ${label} para a posição ${toIndex + 1}`);
    return true;
  }

  // Mover item para a esquerda / trás
  moveItemLeft(itemIndex) {
    if (itemIndex <= 0) return false;
    return this.moveItem(itemIndex, itemIndex - 1);
  }

  // Mover item para a direita / frente
  moveItemRight(itemIndex) {
    if (itemIndex >= this.items.length - 1) return false;
    return this.moveItem(itemIndex, itemIndex + 1);
  }

  // Remover item por índice
  removeItem(index) {
    if (index < 0 || index >= this.items.length) return;
    const [removed] = this.items.splice(index, 1);
    this.recalculateTimings();
    const label = removed.type === 'bossa' ? `bossa '${removed.name}'` : `compasso`;
    this.notify(`Removeu ${label}`);
  }

  // Remover múltiplos itens por índices
  removeItems(indices) {
    if (!indices || indices.length === 0) return;
    const sorted = Array.from(new Set(indices))
      .filter(i => typeof i === 'number' && i >= 0 && i < this.items.length)
      .sort((a, b) => b - a);
    if (sorted.length === 0) return;
    sorted.forEach(idx => this.items.splice(idx, 1));
    this.recalculateTimings();
    this.notify(`Removeu ${sorted.length} item(ns)`);
  }

  // Atualizar propriedades de um item de primeira classe
  updateItem(index, updates) {
    const item = this.items[index];
    if (!item) return false;
    Object.assign(item, updates);
    this.recalculateTimings();
    this.notify(`Atualizou ${item.type === 'bossa' ? 'bossa' : 'compasso'}`);
    return true;
  }

  // Alternar recolher/expandir bloco de bossa
  toggleBossaCollapse(itemIndex) {
    const item = this.items[itemIndex];
    if (!item || item.type !== 'bossa') return false;
    item.collapsed = !item.collapsed;
    this.recalculateTimings();
    this.notify(`${item.collapsed ? 'Recolheu' : 'Expandiu'} bossa '${item.name}'`, false);
    return true;
  }

  // Desvincular bloco de bossa (torna cópia local com compassos independentes)
  unlinkBossa(itemIndex) {
    const item = this.items[itemIndex];
    if (!item || item.type !== 'bossa') return false;
    const measures = this.getBossaMeasures(item);
    item.measures = measures.map((m, idx) => ({
      ...m,
      id: `m-unlinked-${Date.now()}-${idx}`,
      isLinked: false
    }));
    item.isLinked = false;
    this.recalculateTimings();
    this.notify(`Desvinculou bossa '${item.name}'`);
    return true;
  }

  // Sincronizar bossa vinculada com a original
  syncLinkedBossa(itemIndex) {
    const item = this.items[itemIndex];
    if (!item || item.type !== 'bossa') return false;
    if (item.sourcePieceId || item.sourcePieceName) {
      const orig = this.findBossaOrPiece(item.sourcePieceId, item.sourcePieceName);
      if (orig) {
        item.name = orig.name;
        item.sourcePieceName = orig.name;
        if (Array.isArray(orig.measures)) {
          item.measures = JSON.parse(JSON.stringify(orig.measures));
        }
        if (Array.isArray(orig.groups)) {
          item.groups = JSON.parse(JSON.stringify(orig.groups));
        }
        if (Array.isArray(orig.variables)) {
          item.variables = JSON.parse(JSON.stringify(orig.variables));
        }
        if (!item.variableValues) item.variableValues = {};
        const vars = this.getBossaVariables(item);
        vars.forEach(v => {
          if (item.variableValues[v.name] === undefined) {
            item.variableValues[v.name] = v.defaultValue;
          }
        });
      }
    }
    this.recalculateTimings();
    this.notify(`Sincronizou bossa '${item.name}'`);
    return true;
  }

  // Adicionar compasso avulso à peça
  addMeasure(index = -1, template = null) {
    const newIdx = (index === -1 || index > this.items.length) ? this.items.length : index;
    const prevMeasure = this.measures[this.measures.length - 1] || null;

    const newMeasure = {
      type: 'measure',
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

    this.items.splice(newIdx, 0, newMeasure);
    this.recalculateTimings();
    this.notify(`Adicionou compasso (${newMeasure.beats}T)`);
    return newMeasure;
  }

  // Adiciona um compasso imediatamente à direita do compasso especificado (ou ao final se nenhum)
  addMeasureAfter(measureIndex, template = null) {
    if (measureIndex === null || measureIndex === undefined || measureIndex < 0 || measureIndex >= this.measures.length) {
      const added = this.addMeasure(-1, template);
      return { measureIndex: Math.max(0, this.measures.length - 1), measure: added };
    }

    const targetM = this.measures[measureIndex];
    if (!targetM) {
      const added = this.addMeasure(-1, template);
      return { measureIndex: Math.max(0, this.measures.length - 1), measure: added };
    }

    // Se o compasso selecionado estiver dentro de um bloco de bossa
    if (targetM._isBossa && targetM._parentItem) {
      const bossa = targetM._parentItem;
      if (bossa.isLinked) this.unlinkBossa(targetM._itemIndex);
      const newSub = {
        id: `m-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
        nickname: template?.nickname ? template.nickname.trim() : "",
        beats: template?.beats || targetM.beats || 4,
        beatUnit: template?.beatUnit || targetM.beatUnit || 4,
        tempoMode: template?.tempoMode || targetM.tempoMode || "ratio",
        ratioNum: template?.ratioNum || targetM.ratioNum || 1,
        ratioDen: template?.ratioDen || targetM.ratioDen || 1,
        customBpm: template?.customBpm || targetM.customBpm || this.baseBpm,
        color: template?.color || targetM.color || bossa.color || "#3b82f6",
        repeat: Math.max(1, Math.min(999, parseInt(template?.repeat, 10) || 1))
      };
      if (Array.isArray(bossa.measures)) {
        bossa.measures.splice(targetM._subIndex + 1, 0, newSub);
      }
      this.recalculateTimings();
      this.notify(`Adicionou compasso à direita na bossa '${bossa.name}'`);
      return { measureIndex: measureIndex + 1, measure: newSub };
    }

    // Compasso avulso comum em this.items
    const insertItemIdx = (targetM._itemIndex !== undefined) ? targetM._itemIndex + 1 : this.items.length;
    const newMeasure = {
      type: 'measure',
      id: `m-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      nickname: template?.nickname ? template.nickname.trim() : "",
      beats: template?.beats || targetM.beats || 4,
      beatUnit: template?.beatUnit || targetM.beatUnit || 4,
      tempoMode: template?.tempoMode || targetM.tempoMode || "ratio",
      ratioNum: template?.ratioNum || targetM.ratioNum || 1,
      ratioDen: template?.ratioDen || targetM.ratioDen || 1,
      customBpm: template?.customBpm || targetM.customBpm || this.baseBpm,
      color: template?.color || targetM.color || "#ff334b",
      repeat: Math.max(1, Math.min(999, parseInt(template?.repeat, 10) || 1))
    };

    this.items.splice(insertItemIdx, 0, newMeasure);
    this.recalculateTimings();
    this.notify(`Adicionou compasso à direita (${newMeasure.beats}T)`);

    const newMeasureIdx = this.measures.findIndex(m => m.id === newMeasure.id);
    return {
      measureIndex: (newMeasureIdx !== -1) ? newMeasureIdx : (measureIndex + 1),
      measure: newMeasure
    };
  }

  // Adiciona um compasso imediatamente à esquerda do compasso especificado
  addMeasureBefore(measureIndex, template = null) {
    if (measureIndex === null || measureIndex === undefined || measureIndex <= 0 || measureIndex >= this.measures.length) {
      const added = this.addMeasure(0, template);
      return { measureIndex: 0, measure: added };
    }

    const targetM = this.measures[measureIndex];
    if (!targetM) {
      const added = this.addMeasure(0, template);
      return { measureIndex: 0, measure: added };
    }

    if (targetM._isBossa && targetM._parentItem) {
      const bossa = targetM._parentItem;
      if (bossa.isLinked) this.unlinkBossa(targetM._itemIndex);
      const newSub = {
        id: `m-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
        nickname: template?.nickname ? template.nickname.trim() : "",
        beats: template?.beats || targetM.beats || 4,
        beatUnit: template?.beatUnit || targetM.beatUnit || 4,
        tempoMode: template?.tempoMode || targetM.tempoMode || "ratio",
        ratioNum: template?.ratioNum || targetM.ratioNum || 1,
        ratioDen: template?.ratioDen || targetM.ratioDen || 1,
        customBpm: template?.customBpm || targetM.customBpm || this.baseBpm,
        color: template?.color || targetM.color || bossa.color || "#3b82f6",
        repeat: Math.max(1, Math.min(999, parseInt(template?.repeat, 10) || 1))
      };
      if (Array.isArray(bossa.measures)) {
        bossa.measures.splice(targetM._subIndex, 0, newSub);
      }
      this.recalculateTimings();
      this.notify(`Adicionou compasso à esquerda na bossa '${bossa.name}'`);
      return { measureIndex: measureIndex, measure: newSub };
    }

    const insertItemIdx = (targetM._itemIndex !== undefined) ? targetM._itemIndex : 0;
    const newMeasure = {
      type: 'measure',
      id: `m-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      nickname: template?.nickname ? template.nickname.trim() : "",
      beats: template?.beats || targetM.beats || 4,
      beatUnit: template?.beatUnit || targetM.beatUnit || 4,
      tempoMode: template?.tempoMode || targetM.tempoMode || "ratio",
      ratioNum: template?.ratioNum || targetM.ratioNum || 1,
      ratioDen: template?.ratioDen || targetM.ratioDen || 1,
      customBpm: template?.customBpm || targetM.customBpm || this.baseBpm,
      color: template?.color || targetM.color || "#ff334b",
      repeat: Math.max(1, Math.min(999, parseInt(template?.repeat, 10) || 1))
    };

    this.items.splice(insertItemIdx, 0, newMeasure);
    this.recalculateTimings();
    this.notify(`Adicionou compasso à esquerda (${newMeasure.beats}T)`);

    const newMeasureIdx = this.measures.findIndex(m => m.id === newMeasure.id);
    return {
      measureIndex: (newMeasureIdx !== -1) ? newMeasureIdx : measureIndex,
      measure: newMeasure
    };
  }

  // Duplicar compasso
  duplicateMeasure(index) {
    const m = this.measures[index];
    if (!m) return;
    if (m._isBossa && m._parentItem) {
      const bossa = m._parentItem;
      if (bossa.isLinked) this.unlinkBossa(m._itemIndex);
      if (Array.isArray(bossa.measures)) {
        const copy = { ...bossa.measures[m._subIndex], id: `m-${Date.now()}` };
        bossa.measures.splice(m._subIndex + 1, 0, copy);
        this.recalculateTimings();
        this.notify(`Duplicou compasso na bossa '${bossa.name}'`);
      }
      return;
    }
    const target = this.items[m._itemIndex];
    if (target) {
      const copy = JSON.parse(JSON.stringify(target));
      copy.id = `m-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;
      this.items.splice(m._itemIndex + 1, 0, copy);
      this.recalculateTimings();
      this.notify(`Duplicou compasso`);
    }
  }

  // Mover compasso ou bloco
  moveMeasure(fromIndex, toIndex) {
    const fromM = this.measures[fromIndex];
    const toM = this.measures[toIndex];
    if (!fromM || !toM) return false;
    if (fromM._itemIndex !== undefined && toM._itemIndex !== undefined) {
      if (fromM._itemIndex !== toM._itemIndex) {
        return this.moveItem(fromM._itemIndex, toM._itemIndex);
      }
    }
    return false;
  }

  // Mover grupo / bloco de bossa (compatibilidade com chamadas existentes)
  moveGroup(groupId, targetIndex) {
    const itemIdx = this.items.findIndex(it => it.id === groupId);
    if (itemIdx < 0) return false;
    let targetItemIdx = targetIndex;
    const targetM = this.measures[targetIndex];
    if (targetM && targetM._itemIndex !== undefined) {
      targetItemIdx = targetM._itemIndex;
    }
    return this.moveItem(itemIdx, targetItemIdx);
  }

  moveGroupLeft(groupId) {
    const itemIdx = this.items.findIndex(it => it.id === groupId);
    if (itemIdx <= 0) return false;
    return this.moveItem(itemIdx, itemIdx - 1);
  }

  moveGroupRight(groupId) {
    const itemIdx = this.items.findIndex(it => it.id === groupId);
    if (itemIdx < 0 || itemIdx >= this.items.length - 1) return false;
    return this.moveItem(itemIdx, itemIdx + 1);
  }

  // Remover compasso (suporta compassos avulsos e sub-compassos de bossas)
  removeMeasure(index) {
    const m = this.measures[index];
    if (!m) return;
    if (m._isBossa && m._parentItem) {
      const bossa = m._parentItem;
      if (bossa.isLinked) this.unlinkBossa(m._itemIndex);
      if (Array.isArray(bossa.measures)) {
        bossa.measures.splice(m._subIndex, 1);
        if (bossa.measures.length === 0) {
          this.removeItem(m._itemIndex);
          return;
        }
      }
      this.recalculateTimings();
      this.notify(`Excluiu compasso da bossa`);
      return;
    }
    if (m._itemIndex !== undefined) {
      this.removeItem(m._itemIndex);
    }
  }

  // Remover múltiplos compassos
  removeMeasures(indices) {
    if (!indices || indices.length === 0) return;
    const itemIndicesToRemove = new Set();
    indices.forEach(idx => {
      const m = this.measures[idx];
      if (m && !m._isBossa && m._itemIndex !== undefined) {
        itemIndicesToRemove.add(m._itemIndex);
      }
    });
    if (itemIndicesToRemove.size > 0) {
      this.removeItems(Array.from(itemIndicesToRemove));
    }
  }

  // Duplicar múltiplos compassos
  duplicateMeasures(indices) {
    if (!indices || indices.length === 0) return null;
    const unique = Array.from(new Set(indices)).sort((a, b) => a - b);
    unique.forEach(idx => this.duplicateMeasure(idx));
    return true;
  }

  // Inserir múltiplos compassos
  insertMeasures(targetIndex, measuresList) {
    if (!measuresList || measuresList.length === 0) return null;
    let insertIdx = (targetIndex === -1 || targetIndex === undefined || targetIndex === null || targetIndex > this.items.length)
      ? this.items.length
      : Math.max(0, targetIndex);

    const copies = measuresList.map((target, i) => ({
      type: 'measure',
      id: `m-${Date.now()}-${i}-${Math.random().toString(36).substr(2, 5)}`,
      nickname: target.nickname ? target.nickname.trim() : "",
      beats: parseInt(target.beats, 10) || 4,
      beatUnit: parseInt(target.beatUnit, 10) || 4,
      tempoMode: target.tempoMode || "ratio",
      ratioNum: parseInt(target.ratioNum, 10) || 1,
      ratioDen: parseInt(target.ratioDen, 10) || 1,
      customBpm: target.customBpm ? parseFloat(target.customBpm) : this.baseBpm,
      color: target.color || "#ff334b",
      repeat: Math.max(1, Math.min(999, parseInt(target.repeat, 10) || 1))
    }));

    this.items.splice(insertIdx, 0, ...copies);
    this.recalculateTimings();
    this.notify(`Colou ${copies.length} compasso${copies.length > 1 ? 's' : ''}`);
    return { start: insertIdx, end: insertIdx + copies.length - 1 };
  }

  // Esvazia todos os compassos da peça
  clearAllMeasures() {
    this.items = [];
    this.recalculateTimings();
    this.notify("Limpou todos os compassos");
  }

  // Salva a peça atual na biblioteca local do usuário (para nunca perder composições anteriores)
  saveCurrentPieceToLibrary() {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(LIBRARY_KEY);
      let library = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(library)) library = [];

      const isBossaVal = this.isBossa !== undefined ? Boolean(this.isBossa) : Boolean(this.id?.startsWith('piece-bossa-') || this.id?.startsWith('bossa-'));

      const pieceData = {
        id: this.id,
        name: this.name || (isBossaVal ? "Bossa Sem Nome" : "Peça Sem Nome"),
        description: this.description || "",
        presentationBpm: this.presentationBpm,
        baseBpm: this.baseBpm,
        ownerId: this.ownerId || null,
        ownerName: this.ownerName || null,
        access: this.access || 'edit_link',
        isBossa: isBossaVal,
        items: (this.items || []).map(it => ({ ...it })),
        measures: this.measures.map(m => ({ ...m })),
        groups: this.groups.map(g => ({ ...g })),
        variables: (this.variables || []).map(v => ({ ...v })),
        updatedAt: Date.now()
      };

      const existingIdx = library.findIndex(p => p.id === this.id);
      if (existingIdx >= 0) {
        library[existingIdx] = pieceData;
      } else {
        library.unshift(pieceData);
      }

      // Mantém até 100 peças locais
      if (library.length > 100) {
        library = library.slice(0, 100);
      }

      localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
      return pieceData;
    } catch (e) {
      console.warn("Erro ao salvar peça na biblioteca:", e);
      return null;
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
      this.notifyLibraryChange();
    } catch (e) {
      console.warn("Erro ao atualizar biblioteca local:", e);
    }
  }

  // Salva ou atualiza um item qualquer (peça ou bossa) na biblioteca local
  saveItemToLibrary(item) {
    if (!item || !item.id) return false;
    const library = this.getLibraryPieces();
    const existingIdx = library.findIndex(p => p.id === item.id);
    if (existingIdx >= 0) {
      library[existingIdx] = item;
    } else {
      library.unshift(item);
    }
    this.setLibraryPieces(library);
    return true;
  }

  // Define um resolver externo para peças (ex: cache da nuvem/Firestore)
  setExternalPieceResolver(resolverFn) {
    this.externalPieceResolver = resolverFn;
  }

  // Busca uma bossa ou peça na biblioteca ou presets por ID ou nome
  findBossaOrPiece(pieceId, pieceName) {
    const library = this.getLibraryPieces();
    if (pieceId) {
      const found = library.find(p => p.id === pieceId) || PRESETS.find(p => p.id === pieceId);
      if (found) return found;
    }
    if (pieceName) {
      const clean = pieceName.replace(/^[🔗📦✏️🔓\s]+/, '').trim().toLowerCase();
      const found = library.find(p => p.name && p.name.replace(/^[🔗📦✏️🔓\s]+/, '').trim().toLowerCase() === clean)
        || PRESETS.find(p => p.name && p.name.replace(/^[🔗📦✏️🔓\s]+/, '').trim().toLowerCase() === clean);
      if (found) return found;
    }
    if (typeof this.externalPieceResolver === 'function') {
      try {
        const ext = this.externalPieceResolver(pieceId, pieceName);
        if (ext) return ext;
      } catch (_) {}
    }
    return null;
  }

  // Retorna apenas as bossas salvas na biblioteca local
  getBossaPieces() {
    const all = this.getLibraryPieces();
    return all.filter(p => p.isBossa !== undefined ? Boolean(p.isBossa) : Boolean(p.id?.startsWith('piece-bossa-') || p.id?.startsWith('bossa-')));
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
      this.notifyLibraryChange();
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
    this.isBossa = false;
    this.presentationBpm = Math.max(20, Math.min(400, parseInt(baseBpm, 10) || 120));
    this.baseBpm = this.presentationBpm;
    this.isCustomPracticeBpm = false;
    try {
      localStorage.removeItem(`sergio_practice_bpm_${this.id}`);
    } catch (_) {}

    // 3. Inicializa com 1 compasso padrão 4/4 pronto para tocar
    this.items = [
      {
        type: 'measure',
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
    if (this.items && this.items.length > 0) {
      this.saveCurrentPieceToLibrary();
    }

    const newId = `piece-${Date.now()}`;
    this.id = newId;
    this.name = customName || this.name;
    this.ownerId = null;
    this.access = 'edit_link';

    // Gera novos IDs para os itens
    this.items = (this.items || []).map((it, idx) => {
      if (it.type === 'bossa') {
        return {
          ...it,
          id: `bossa-${Date.now()}-${idx}-${Math.random().toString(36).substr(2, 4)}`,
          measures: Array.isArray(it.measures) ? it.measures.map((bm, bi) => ({
            ...bm,
            id: `m-bossa-${Date.now()}-${idx}-${bi}`
          })) : []
        };
      }
      return {
        ...it,
        id: `m-${Date.now()}-${idx}-${Math.random().toString(36).substr(2, 4)}`
      };
    });

    this.recalculateTimings();
    this.currentSnapshot = this.getSnapshot();
    this.undoStack = [];
    this.redoStack = [];

    this.saveToLocalStorage();
    this.saveCurrentPieceToLibrary();
    this.notify(`Criou uma cópia pessoal '${this.name}'`);
    return newId;
  }

  // Atualizar múltiplos compassos de uma vez (edição em lote atômica)
  updateMeasures(indices, updates) {
    if (!Array.isArray(indices) || indices.length === 0 || this.measures.length === 0) return null;
    const sorted = Array.from(new Set(indices))
      .filter(idx => typeof idx === 'number' && idx >= 0 && idx < this.measures.length)
      .sort((a, b) => a - b);

    if (sorted.length === 0) return null;

    sorted.forEach(idx => {
      const m = this.measures[idx];
      if (!m) return;

      if (m._isBossa && m._parentItem) {
        const bossa = m._parentItem;
        if (!Array.isArray(bossa.measures) || bossa.measures.length === 0) {
          const currentMs = this.getBossaMeasures(bossa);
          bossa.measures = JSON.parse(JSON.stringify(currentMs));
        }
        if (Array.isArray(bossa.measures) && bossa.measures[m._subIndex]) {
          const target = bossa.measures[m._subIndex];
          if (updates.nickname !== undefined) target.nickname = (updates.nickname || "").trim();
          if (updates.beats !== undefined) target.beats = Math.max(1, Math.min(32, parseInt(updates.beats, 10) || 4));
          if (updates.beatUnit !== undefined) target.beatUnit = parseInt(updates.beatUnit, 10) || 4;
          if (updates.tempoMode !== undefined) target.tempoMode = updates.tempoMode;
          if (updates.ratioNum !== undefined) target.ratioNum = Math.max(1, parseInt(updates.ratioNum, 10) || 1);
          if (updates.ratioDen !== undefined) target.ratioDen = Math.max(1, parseInt(updates.ratioDen, 10) || 1);
          if (updates.customBpm !== undefined) target.customBpm = Math.max(20, Math.min(500, Number(updates.customBpm) || this.baseBpm));
          if (updates.color !== undefined) target.color = updates.color;
          if (updates.repeat !== undefined) target.repeat = Math.max(1, Math.min(999, parseInt(updates.repeat, 10) || 1));
          if (updates.repeatVariable !== undefined) target.repeatVariable = updates.repeatVariable ? String(updates.repeatVariable).trim() : null;
        }
      } else if (m._itemIndex !== undefined && this.items[m._itemIndex]) {
        const target = this.items[m._itemIndex];
        if (updates.nickname !== undefined) target.nickname = (updates.nickname || "").trim();
        if (updates.beats !== undefined) target.beats = Math.max(1, Math.min(32, parseInt(updates.beats, 10) || 4));
        if (updates.beatUnit !== undefined) target.beatUnit = parseInt(updates.beatUnit, 10) || 4;
        if (updates.tempoMode !== undefined) target.tempoMode = updates.tempoMode;
        if (updates.ratioNum !== undefined) target.ratioNum = Math.max(1, parseInt(updates.ratioNum, 10) || 1);
        if (updates.ratioDen !== undefined) target.ratioDen = Math.max(1, parseInt(updates.ratioDen, 10) || 1);
        if (updates.customBpm !== undefined) target.customBpm = Math.max(20, Math.min(500, Number(updates.customBpm) || this.baseBpm));
        if (updates.color !== undefined) target.color = updates.color;
        if (updates.repeat !== undefined) target.repeat = Math.max(1, Math.min(999, parseInt(updates.repeat, 10) || 1));
        if (updates.repeatVariable !== undefined) target.repeatVariable = updates.repeatVariable ? String(updates.repeatVariable).trim() : null;
      }
    });

    this.recalculateTimings();
    if (sorted.length === 1) {
      this.notify(`Atualizou compasso ${sorted[0] + 1}`);
    } else {
      this.notify(`Atualizou ${sorted.length} compassos`);
    }

    return { count: sorted.length };
  }

  // Atualizar compasso individual existente
  updateMeasure(index, updates) {
    return this.updateMeasures([index], updates);
  }

  // =========================================================================
  // SISTEMA DE SEÇÕES E GRUPOS
  // =========================================================================

  // Adicionar seção em uma posição específica de this.items
  addSection(itemIndex = -1, options = {}) {
    const defaultName = (options.name || "Nova Seção").trim();
    const defaultColor = options.color || "#3b82f6";
    const repeat = Math.max(1, Math.min(999, parseInt(options.repeat, 10) || 1));

    const newSection = {
      type: 'section',
      id: options.id || `sec-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      name: defaultName,
      color: defaultColor,
      repeat: repeat,
      repeatVariable: options.repeatVariable ? String(options.repeatVariable).trim() : null
    };

    const insertIdx = (itemIndex === -1 || itemIndex === undefined || itemIndex > this.items.length)
      ? this.items.length
      : Math.max(0, itemIndex);

    this.items.splice(insertIdx, 0, newSection);
    this.recalculateTimings();
    this.notify(`Criou seção '${newSection.name}'`);
    return newSection;
  }

  // Atualizar propriedades de uma seção
  updateSection(sectionId, updates, isLocalOnly = false) {
    const sec = this.items.find(it => it.id === sectionId && it.type === 'section');
    if (!sec) return;

    if (updates.name !== undefined) sec.name = (updates.name || "Seção").trim();
    if (updates.color !== undefined) sec.color = updates.color;
    if (updates.repeat !== undefined) sec.repeat = Math.max(1, Math.min(999, parseInt(updates.repeat, 10) || 1));
    if (updates.repeatVariable !== undefined) sec.repeatVariable = updates.repeatVariable ? String(updates.repeatVariable).trim() : null;

    this.recalculateTimings();
    this.notify(`Atualizou seção '${sec.name}'`, isLocalOnly);
  }

  // Remover apenas a linha divisória da seção (desagrupar mantendo os compassos na peça)
  removeSection(sectionId) {
    const idx = this.items.findIndex(it => it.id === sectionId && it.type === 'section');
    if (idx >= 0) {
      const [removed] = this.items.splice(idx, 1);
      this.recalculateTimings();
      this.notify(`Desagrupou seção '${removed.name}'`);
    }
  }

  // Mover seção para trás (troca com o item anterior)
  moveSectionLeft(sectionId) {
    const idx = this.items.findIndex(it => it.id === sectionId && it.type === 'section');
    if (idx > 0) {
      return this.moveItem(idx, idx - 1);
    }
    return false;
  }

  // Mover seção para frente (troca com o item seguinte)
  moveSectionRight(sectionId) {
    const idx = this.items.findIndex(it => it.id === sectionId && it.type === 'section');
    if (idx >= 0 && idx < this.items.length - 1) {
      return this.moveItem(idx, idx + 1);
    }
    return false;
  }

  // Agrupamento: criar ou atualizar grupo (compatibilidade com modal e chamadas externas)
  addGroup(name, color, startMeasure, endMeasure, repeat = 1, repeatVariable = null) {
    if (this.measures.length === 0) return null;
    const start = Math.max(0, Math.min(startMeasure, endMeasure));
    const targetM = this.measures[start];
    const targetItemIdx = (targetM && targetM._itemIndex !== undefined) ? targetM._itemIndex : 0;
    return this.addSection(targetItemIdx, {
      name: name || "Nova Seção",
      color: color || "#3b82f6",
      repeat: repeat || 1,
      repeatVariable: repeatVariable || null
    });
  }

  updateGroup(groupId, updates, isLocalOnly = false) {
    const item = this.items.find(it => it.id === groupId);
    if (item && item.type === 'bossa') {
      if (updates.name !== undefined) item.name = updates.name.trim() || item.name;
      if (updates.color !== undefined) item.color = updates.color;
      if (updates.repeat !== undefined) item.repeat = Math.max(1, Math.min(999, parseInt(updates.repeat, 10) || 1));
      if (updates.collapsed !== undefined) item.collapsed = Boolean(updates.collapsed);
      this.recalculateTimings();
      this.notify(`Atualizou bossa '${item.name}'`, isLocalOnly);
      return;
    }
    if (item && item.type === 'section') {
      return this.updateSection(groupId, updates, isLocalOnly);
    }
    const grp = this.groups.find(g => g.id === groupId);
    if (!grp) return;

    if (updates.name !== undefined) grp.name = updates.name.trim() || "Grupo";
    if (updates.color !== undefined) grp.color = updates.color;
    if (updates.repeat !== undefined) grp.repeat = Math.max(1, Math.min(999, parseInt(updates.repeat, 10) || 1));
    if (updates.repeatVariable !== undefined) grp.repeatVariable = updates.repeatVariable ? String(updates.repeatVariable).trim() : null;
    if (updates.collapsed !== undefined) grp.collapsed = Boolean(updates.collapsed);
    this.recalculateTimings();
    this.notify(`Atualizou grupo '${grp.name}'`, isLocalOnly);
  }

  removeGroup(groupId) {
    const itemIdx = this.items.findIndex(it => it.id === groupId);
    if (itemIdx >= 0) {
      this.removeItem(itemIdx);
      return;
    }
    this.groups = this.groups.filter(g => g.id !== groupId);
    this.recalculateTimings();
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

  // Insere uma Bossa como item estrutural de primeira classe na partitura
  insertBossa(bossaPiece, targetIndex = -1, isLinked = true) {
    if (!bossaPiece) return null;

    let insertPos = this.items.length;
    if (targetIndex >= 0 && targetIndex <= this.items.length) {
      insertPos = targetIndex;
    } else {
      // Se targetIndex veio como índice de compasso na lista linear, acha o item correspondente
      const targetM = this.measures[targetIndex];
      if (targetM && targetM._itemIndex !== undefined) {
        insertPos = targetM._itemIndex + 1;
      }
    }
    insertPos = Math.max(0, Math.min(this.items.length, insertPos));

    const bossaColors = [
      "#8b5cf6", // Violeta
      "#06b6d4", // Ciano
      "#10b981", // Esmeralda
      "#f59e0b", // Âmbar
      "#ec4899", // Rosa choque
      "#3b82f6"  // Azul royal
    ];
    const bossaCount = this.items.filter(it => it.type === 'bossa').length;
    const bossaColor = bossaPiece.color || bossaColors[bossaCount % bossaColors.length];

    const cleanName = (bossaPiece.name || "Bossa").replace(/^[🔗📦✏️🔓\s]+/, '').trim();

    const bossaItem = {
      type: 'bossa',
      id: `bossa-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      sourcePieceId: bossaPiece.id || null,
      sourcePieceName: cleanName,
      name: cleanName,
      color: bossaColor,
      repeat: 1,
      collapsed: true,
      isLinked: Boolean(isLinked),
      tempoMode: 'inherit',
      bpm: bossaPiece.presentationBpm || bossaPiece.baseBpm || this.baseBpm,
      ratioNum: 1,
      ratioDen: 1,
      measures: Array.isArray(bossaPiece.measures)
        ? JSON.parse(JSON.stringify(bossaPiece.measures))
        : [],
      groups: Array.isArray(bossaPiece.groups)
        ? JSON.parse(JSON.stringify(bossaPiece.groups))
        : [],
      variables: Array.isArray(bossaPiece.variables)
        ? JSON.parse(JSON.stringify(bossaPiece.variables))
        : [],
      variableValues: {}
    };

    const vars = this.getBossaVariables(bossaItem);
    vars.forEach(v => {
      bossaItem.variableValues[v.name] = v.defaultValue;
    });

    this.items.splice(insertPos, 0, bossaItem);
    this.recalculateTimings();
    this.notify(`Inseriu bossa '${cleanName}' (${isLinked ? 'vinculada' : 'cópia'})`);
    return {
      item: bossaItem,
      itemIndex: insertPos,
      startIndex: Math.max(0, this.measures.findIndex(m => m._itemIndex === insertPos))
    };
  }

  // Sincroniza manualmente um bloco específico de bossa
  syncBossaBlock(groupId) {
    const itemIdx = this.items.findIndex(it => it.id === groupId);
    if (itemIdx >= 0) {
      return this.syncLinkedBossa(itemIdx);
    }
    return false;
  }

  // Desvincula todos os compassos de um bloco de bossa (torna 100% locais e independentes)
  unlinkBossaBlock(groupId) {
    const itemIdx = this.items.findIndex(it => it.id === groupId);
    if (itemIdx >= 0) {
      return this.unlinkBossa(itemIdx);
    }
    return false;
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

  // Salva uma seleção de compassos como uma nova Bossa ou Peça na biblioteca local
  saveMeasuresAsItem(indices, itemName, isBossa = true) {
    if (!indices || indices.length === 0) return null;
    const sorted = Array.from(new Set(indices))
      .filter(idx => typeof idx === 'number' && idx >= 0 && idx < this.measures.length)
      .sort((a, b) => a - b);

    if (sorted.length === 0) return null;

    const defaultPrefix = isBossa ? 'Bossa' : 'Peça';
    const name = (itemName || "").trim() || `${defaultPrefix} (${sorted.length} comp.)`;
    const newId = isBossa ? `piece-bossa-${Date.now()}` : `piece-${Date.now()}`;

    const itemMeasures = sorted.map((idx, i) => {
      const m = this.measures[idx];
      return {
        id: `m-${isBossa ? 'bossa' : 'piece'}-${Date.now()}-${i}`,
        nickname: m.nickname || `Compasso ${i + 1}`,
        beats: m.beats,
        beatUnit: m.beatUnit,
        tempoMode: m.tempoMode,
        ratioNum: m.ratioNum,
        ratioDen: m.ratioDen,
        customBpm: m.customBpm,
        color: m.color || (isBossa ? "#8b5cf6" : "#ff334b"),
        repeat: m.repeat || 1
      };
    });

    const itemData = {
      id: newId,
      name: name,
      description: `${isBossa ? 'Bossa' : 'Peça'} extraída da apresentação '${this.name}'`,
      presentationBpm: this.presentationBpm,
      baseBpm: this.baseBpm,
      isBossa: Boolean(isBossa),
      measures: itemMeasures,
      groups: isBossa ? [
        {
          id: `grp-${newId}`,
          name: name,
          color: "#8b5cf6",
          startMeasure: 0,
          endMeasure: itemMeasures.length - 1,
          isBossaBlock: true
        }
      ] : [],
      updatedAt: Date.now(),
      createdAt: Date.now()
    };

    // Salva na biblioteca local
    let library = this.getLibraryPieces();
    library.unshift(itemData);
    if (library.length > 100) library = library.slice(0, 100);
    this.setLibraryPieces(library);

    return itemData;
  }

  // Wrapper compatível com chamadas legadas
  saveMeasuresAsBossa(indices, bossaName) {
    return this.saveMeasuresAsItem(indices, bossaName, true);
  }

  // Calcula timings detalhados para qualquer lista de compassos (usado em prévias de áudio)
  // Calcula timings detalhados para qualquer lista de compassos (usado em prévias de áudio)
  calculateTimingsForMeasures(measures, baseBpm = 120, groups = []) {
    if (!Array.isArray(measures) || measures.length === 0) {
      return { timings: [], totalDuration: 0 };
    }
    let accumulatedTime = 0;
    const timings = [];
    let globalTimingIndex = 0;
    const measuresCount = measures.length;

    const pushMeasureTimings = (idx, groupContext = null) => {
      const m = measures[idx];
      if (!m) return;
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
          groupId: groupContext ? groupContext.id : null,
          groupRepeatIteration: groupContext ? groupContext.iteration : 0,
          groupRepeatCount: groupContext ? groupContext.repeatCount : 1,
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
    };

    let idx = 0;
    while (idx < measuresCount) {
      const grp = Array.isArray(groups) ? groups.find(g => g.startMeasure === idx && g.endMeasure >= idx && g.endMeasure < measuresCount) : null;
      if (grp) {
        const grpRepeat = Math.max(1, Math.min(999, parseInt(grp.repeat, 10) || 1));
        const start = grp.startMeasure;
        const end = grp.endMeasure;
        for (let gr = 0; gr < grpRepeat; gr++) {
          const groupContext = { id: grp.id, iteration: gr, repeatCount: grpRepeat };
          for (let mIdx = start; mIdx <= end; mIdx++) {
            pushMeasureTimings(mIdx, groupContext);
          }
        }
        idx = end + 1;
      } else {
        pushMeasureTimings(idx, null);
        idx++;
      }
    }

    return { timings, totalDuration: accumulatedTime };
  }

  // Retorna o grupo ao qual pertence o compasso, se houver
  getGroupByMeasureIndex(measureIndex) {
    if (measureIndex < 0 || this.measures.length === 0) return null;
    return (this.groups || []).find(g => typeof g.startMeasure === 'number' && g.startMeasure >= 0 && measureIndex >= g.startMeasure && measureIndex <= g.endMeasure) || null;
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

  // Obtém os compassos de um bloco de Bossa (da bossa original se vinculada, ou de measures locais como fallback)
  getBossaMeasures(bossaItem) {
    if (!bossaItem) return [];
    if (bossaItem.isLinked && (bossaItem.sourcePieceId || bossaItem.sourcePieceName)) {
      const orig = this.findBossaOrPiece(bossaItem.sourcePieceId, bossaItem.sourcePieceName);
      if (orig && Array.isArray(orig.measures) && orig.measures.length > 0) {
        return orig.measures.map((m, idx) => {
          const localM = (Array.isArray(bossaItem.measures) && bossaItem.measures[idx]) ? bossaItem.measures[idx] : null;
          return {
            ...m,
            tempoMode: localM?.tempoMode || m.tempoMode || 'ratio',
            ratioNum: localM?.ratioNum !== undefined ? localM.ratioNum : (m.ratioNum || 1),
            ratioDen: localM?.ratioDen !== undefined ? localM.ratioDen : (m.ratioDen || 1),
            customBpm: localM?.customBpm !== undefined ? localM.customBpm : m.customBpm,
            beats: localM?.beats || m.beats || 4,
            repeat: localM?.repeat || m.repeat || 1,
            id: `${bossaItem.id}-${m.id || idx}`,
            sourceMeasureId: m.id || null,
            sourcePieceId: bossaItem.sourcePieceId || orig.id,
            sourcePieceName: orig.name || bossaItem.name,
            color: localM?.color || m.color || bossaItem.color || '#8b5cf6',
            repeatVariable: localM?.repeatVariable || m.repeatVariable || null,
            isLinked: true
          };
        });
      }
    }
    // Fallback gracioso: usa as measures locais/armazenadas dentro do bossaItem
    return (bossaItem.measures || []).map((m, idx) => ({
      ...m,
      id: m.id || `${bossaItem.id}-sub-${idx}`,
      sourcePieceId: bossaItem.sourcePieceId || null,
      sourcePieceName: bossaItem.sourcePieceName || bossaItem.name,
      color: m.color || bossaItem.color || '#8b5cf6',
      repeatVariable: m.repeatVariable || null,
      isLinked: Boolean(bossaItem.isLinked)
    }));
  }

  // Retorna o andamento base de referência efetivo para a bossa
  getBossaEffectiveBpm(bossaItem) {
    if (!bossaItem) return this.baseBpm;
    if (bossaItem.tempoMode === 'fixed' && bossaItem.bpm) {
      return Math.round(Number(bossaItem.bpm));
    }
    if (bossaItem.tempoMode === 'ratio') {
      const num = Number(bossaItem.ratioNum) || 1;
      const den = Number(bossaItem.ratioDen) || 1;
      return Math.round(this.baseBpm * (num / den));
    }
    if (bossaItem.bpm && bossaItem.tempoMode !== 'inherit') {
      return Math.round(Number(bossaItem.bpm));
    }
    return this.baseBpm;
  }

  // Atualiza andamento (BPM/Modulação) de um bloco de bossa (mantendo-o vinculado)
  updateBossaTempo(bossaId, updates = {}) {
    const item = this.items.find(it => it.id === bossaId && it.type === 'bossa');
    if (!item) return false;

    if (updates.tempoMode !== undefined) {
      item.tempoMode = updates.tempoMode;
    }
    if (updates.bpm !== undefined) {
      const parsed = Math.max(20, Math.min(400, Math.round(Number(updates.bpm)) || this.baseBpm));
      item.bpm = parsed;
      if (!updates.tempoMode) item.tempoMode = 'fixed';
    }
    if (updates.ratioNum !== undefined) {
      item.ratioNum = Math.max(1, parseInt(updates.ratioNum, 10) || 1);
    }
    if (updates.ratioDen !== undefined) {
      item.ratioDen = Math.max(1, parseInt(updates.ratioDen, 10) || 1);
    }

    this.recalculateTimings();
    this.notify(`Alterou andamento da bossa '${item.name}'`);
    return true;
  }

  // Obtém todas as variáveis de repetição suportadas por um bloco de Bossa
  getBossaVariables(bossaItem) {
    if (!bossaItem) return [];
    const orig = (bossaItem.isLinked && (bossaItem.sourcePieceId || bossaItem.sourcePieceName))
      ? this.findBossaOrPiece(bossaItem.sourcePieceId, bossaItem.sourcePieceName)
      : null;

    const bossaMs = (orig && Array.isArray(orig.measures) && orig.measures.length > 0)
      ? orig.measures
      : (bossaItem.measures || []);

    const bossaGrps = (orig && Array.isArray(orig.groups))
      ? orig.groups
      : (Array.isArray(bossaItem.groups) ? bossaItem.groups : []);

    const declaredVars = (orig && Array.isArray(orig.variables))
      ? orig.variables
      : (Array.isArray(bossaItem.variables) ? bossaItem.variables : []);

    const varsMap = new Map();

    // 1. Variáveis explicitamente declaradas
    declaredVars.forEach(v => {
      if (v && v.name) {
        const key = String(v.name).trim();
        if (key) {
          varsMap.set(key, {
            name: key,
            label: (v.label || v.name).trim(),
            defaultValue: Math.max(1, Math.min(999, parseInt(v.defaultValue || v.default || 1, 10)))
          });
        }
      }
    });

    // 2. Variáveis usadas em grupos internos
    bossaGrps.forEach(g => {
      if (g && g.repeatVariable && !g.isBossaBlock) {
        const key = String(g.repeatVariable).trim();
        if (key && !varsMap.has(key)) {
          varsMap.set(key, {
            name: key,
            label: g.name ? g.name.trim() : `Grupo ${key}`,
            defaultValue: Math.max(1, Math.min(999, parseInt(g.repeat || 1, 10)))
          });
        }
      }
    });

    // 3. Variáveis usadas em compassos
    bossaMs.forEach((m, idx) => {
      if (m && m.repeatVariable) {
        const key = String(m.repeatVariable).trim();
        if (key && !varsMap.has(key)) {
          varsMap.set(key, {
            name: key,
            label: m.nickname ? m.nickname.trim() : `c. ${idx + 1}`,
            defaultValue: Math.max(1, Math.min(999, parseInt(m.repeat || 1, 10)))
          });
        }
      }
    });

    return Array.from(varsMap.values());
  }

  // Atualiza o valor de uma variável de repetição da Bossa vinculada na peça
  updateBossaVariable(itemIdx, varName, value, isLocalOnly = false) {
    const item = this.items[itemIdx];
    if (!item || item.type !== 'bossa') return;
    if (!item.variableValues) item.variableValues = {};
    const val = Math.max(1, Math.min(999, parseInt(value, 10) || 1));
    item.variableValues[varName] = val;
    this.recalculateTimings();
    this.notify(`Atualizou variável '${varName}' da bossa '${item.name}' para ${val}x`, isLocalOnly);
  }

  // Recálculo matemático de tempos precisos considerando estrutura em blocos de itens (compassos e bossas)
  recalculateTimings() {
    let accumulatedTime = 0;
    this.measureTimings = [];
    this.firstTimingByMeasure = new Map();
    this.lastTimingByMeasure = new Map();

    if (!Array.isArray(this.items) || this.items.length === 0) {
      this.measures = [];
      this.groups = [];
      this.computedGroups = [];
      this.totalDuration = 0;
      return;
    }

    const flattenedMeasures = [];
    const computedGroups = [];
    let globalTimingIndex = 0;

    // 1. Agrupa os itens em blocos delimitados por seções
    const sectionBlocks = [];
    let activeSection = null;
    let currentBlockItems = [];

    this.items.forEach((item, itemIdx) => {
      if (item.type === 'section') {
        if (activeSection !== null || currentBlockItems.length > 0) {
          sectionBlocks.push({
            section: activeSection,
            itemsWithIdx: currentBlockItems
          });
        }
        activeSection = item;
        currentBlockItems = [];
      } else {
        currentBlockItems.push({ item, itemIdx });
      }
    });

    if (activeSection !== null || currentBlockItems.length > 0) {
      sectionBlocks.push({
        section: activeSection,
        itemsWithIdx: currentBlockItems
      });
    }

    // 2. Cria a lista única e sequencial de compassos (flattenedMeasures) e registra grupos de seção e bossas
    sectionBlocks.forEach(block => {
      const blockStartMeasureIdx = flattenedMeasures.length;

      block.itemsWithIdx.forEach(({ item, itemIdx }) => {
        if (item.type === 'bossa') {
          const bossaMs = this.getBossaMeasures(item);
          const bossaStartIdx = flattenedMeasures.length;
          bossaMs.forEach((bm, subIdx) => {
            flattenedMeasures.push({
              ...bm,
              _itemIndex: itemIdx,
              _subIndex: subIdx,
              _parentItem: item,
              _isBossa: true,
              _sectionId: block.section ? block.section.id : null
            });
          });
          const bossaEndIdx = flattenedMeasures.length - 1;
          const repeatCount = Math.max(1, Math.min(999, parseInt(item.repeat, 10) || 1));
          if (bossaEndIdx >= bossaStartIdx) {
            computedGroups.push({
              id: item.id,
              name: item.name,
              color: item.color || '#8b5cf6',
              startMeasure: bossaStartIdx,
              endMeasure: bossaEndIdx,
              repeat: repeatCount,
              isBossaBlock: true,
              isLinked: Boolean(item.isLinked),
              tempoMode: item.tempoMode || 'inherit',
              bpm: item.bpm || null,
              ratioNum: item.ratioNum || 1,
              ratioDen: item.ratioDen || 1,
              effectiveBpm: this.getBossaEffectiveBpm(item),
              sourcePieceId: item.sourcePieceId || null,
              sourcePieceName: item.sourcePieceName || item.name,
              collapsed: Boolean(item.collapsed)
            });
          }
        } else {
          // Compasso avulso
          flattenedMeasures.push({
            ...item,
            _itemIndex: itemIdx,
            _subIndex: 0,
            _parentItem: null,
            _isBossa: false,
            _sectionId: block.section ? block.section.id : null
          });
        }
      });

      const blockEndMeasureIdx = flattenedMeasures.length - 1;

      // Se este bloco possui uma seção identificadora
      if (block.section) {
        const hasBlockMeasures = blockEndMeasureIdx >= blockStartMeasureIdx;
        const secRepeat = Math.max(1, Math.min(999, parseInt(block.section.repeat, 10) || 1));
        computedGroups.push({
          id: block.section.id,
          name: block.section.name || 'Seção',
          color: block.section.color || '#3b82f6',
          startMeasure: hasBlockMeasures ? blockStartMeasureIdx : -1,
          endMeasure: hasBlockMeasures ? blockEndMeasureIdx : -1,
          repeat: secRepeat,
          repeatVariable: block.section.repeatVariable || null,
          isBossaBlock: false
        });
      }
    });

    // 3. Geração de timings com precisão de sample para reprodução na esteira e metrônomo
    sectionBlocks.forEach(block => {
      const secRepeat = block.section
        ? Math.max(1, Math.min(999, parseInt(block.section.repeat, 10) || 1))
        : 1;

      for (let sr = 0; sr < secRepeat; sr++) {
        block.itemsWithIdx.forEach(({ item, itemIdx }) => {
          if (item.type === 'bossa') {
            const bossaMs = this.getBossaMeasures(item);
            const bossaStartMeasureIdx = flattenedMeasures.findIndex(m => m._itemIndex === itemIdx);
            if (bossaStartMeasureIdx < 0) return;
            const repeatCount = Math.max(1, Math.min(999, parseInt(item.repeat, 10) || 1));
            const bossaRefBpm = this.getBossaEffectiveBpm(item);

            const origBossa = (item.isLinked && (item.sourcePieceId || item.sourcePieceName))
              ? this.findBossaOrPiece(item.sourcePieceId, item.sourcePieceName)
              : null;
            const rawInternalGroups = (origBossa && Array.isArray(origBossa.groups))
              ? origBossa.groups
              : (Array.isArray(item.groups) ? item.groups : []);

            const internalGroups = rawInternalGroups.filter(g =>
              !g.isBossaBlock &&
              typeof g.startMeasure === 'number' &&
              typeof g.endMeasure === 'number' &&
              g.startMeasure >= 0 &&
              g.endMeasure < bossaMs.length &&
              g.startMeasure <= g.endMeasure
            );

            const resolveRepeat = (target) => {
              if (target && target.repeatVariable && item.variableValues && item.variableValues[target.repeatVariable] !== undefined) {
                return Math.max(1, Math.min(999, parseInt(item.variableValues[target.repeatVariable], 10) || 1));
              }
              return Math.max(1, Math.min(999, parseInt(target?.repeat, 10) || 1));
            };

            for (let r = 0; r < repeatCount; r++) {
              let subIdx = 0;
              while (subIdx < bossaMs.length) {
                const intGrp = internalGroups.find(g => g.startMeasure === subIdx && g.endMeasure >= subIdx && g.endMeasure < bossaMs.length);
                if (intGrp) {
                  const grpRepeat = resolveRepeat(intGrp);
                  const gStart = intGrp.startMeasure;
                  const gEnd = intGrp.endMeasure;
                  for (let gr = 0; gr < grpRepeat; gr++) {
                    for (let s = gStart; s <= gEnd; s++) {
                      const mIdx = bossaStartMeasureIdx + s;
                      const m = flattenedMeasures[mIdx];
                      const mRepeat = resolveRepeat(m);

                      let effectiveBpm = bossaRefBpm;
                      if (m.tempoMode === "ratio") {
                        effectiveBpm = bossaRefBpm * ((m.ratioNum || 1) / (m.ratioDen || 1));
                      } else if (m.tempoMode === "fixed") {
                        effectiveBpm = m.customBpm || bossaRefBpm;
                      } else {
                        effectiveBpm = bossaRefBpm;
                      }
                      const beatDuration = 60 / effectiveBpm;
                      const measureDuration = (m.beats || 4) * beatDuration;

                      for (let mr = 0; mr < mRepeat; mr++) {
                        const timing = {
                          timingIndex: globalTimingIndex++,
                          measureIndex: mIdx,
                          repeatIteration: mr,
                          repeatCount: mRepeat,
                          groupId: block.section ? block.section.id : item.id,
                          groupRepeatIteration: block.section ? sr : r,
                          groupRepeatCount: block.section ? secRepeat : repeatCount,
                          bossaGroupId: item.id,
                          bossaRepeatIteration: r,
                          bossaRepeatCount: repeatCount,
                          subGroupId: intGrp.id,
                          subGroupRepeatIteration: gr,
                          subGroupRepeatCount: grpRepeat,
                          startTime: accumulatedTime,
                          endTime: accumulatedTime + measureDuration,
                          duration: measureDuration,
                          effectiveBpm: effectiveBpm,
                          beatDuration: beatDuration,
                          beats: m.beats || 4,
                          beatUnit: m.beatUnit || 4
                        };
                        this.measureTimings.push(timing);
                        if (!this.firstTimingByMeasure.has(mIdx)) {
                          this.firstTimingByMeasure.set(mIdx, timing);
                        }
                        this.lastTimingByMeasure.set(mIdx, timing);
                        accumulatedTime += measureDuration;
                      }
                    }
                  }
                  subIdx = gEnd + 1;
                } else {
                  const mIdx = bossaStartMeasureIdx + subIdx;
                  const m = flattenedMeasures[mIdx];
                  const mRepeat = resolveRepeat(m);

                  let effectiveBpm = bossaRefBpm;
                  if (m.tempoMode === "ratio") {
                    effectiveBpm = bossaRefBpm * ((m.ratioNum || 1) / (m.ratioDen || 1));
                  } else if (m.tempoMode === "fixed") {
                    effectiveBpm = m.customBpm || bossaRefBpm;
                  } else {
                    effectiveBpm = bossaRefBpm;
                  }
                  const beatDuration = 60 / effectiveBpm;
                  const measureDuration = (m.beats || 4) * beatDuration;

                  for (let mr = 0; mr < mRepeat; mr++) {
                    const timing = {
                      timingIndex: globalTimingIndex++,
                      measureIndex: mIdx,
                      repeatIteration: mr,
                      repeatCount: mRepeat,
                      groupId: block.section ? block.section.id : item.id,
                      groupRepeatIteration: block.section ? sr : r,
                      groupRepeatCount: block.section ? secRepeat : repeatCount,
                      bossaGroupId: item.id,
                      bossaRepeatIteration: r,
                      bossaRepeatCount: repeatCount,
                      startTime: accumulatedTime,
                      endTime: accumulatedTime + measureDuration,
                      duration: measureDuration,
                      effectiveBpm: effectiveBpm,
                      beatDuration: beatDuration,
                      beats: m.beats || 4,
                      beatUnit: m.beatUnit || 4
                    };
                    this.measureTimings.push(timing);
                    if (!this.firstTimingByMeasure.has(mIdx)) {
                      this.firstTimingByMeasure.set(mIdx, timing);
                    }
                    this.lastTimingByMeasure.set(mIdx, timing);
                    accumulatedTime += measureDuration;
                  }
                  subIdx++;
                }
              }
            }
          } else {
            // Compasso avulso
            const mIdx = flattenedMeasures.findIndex(m => m._itemIndex === itemIdx);
            if (mIdx < 0) return;
            const m = flattenedMeasures[mIdx];
            const mRepeat = Math.max(1, Math.min(999, parseInt(item.repeat, 10) || 1));
            let effectiveBpm = this.baseBpm;
            if (item.tempoMode === "ratio") {
              effectiveBpm = this.baseBpm * ((item.ratioNum || 1) / (item.ratioDen || 1));
            } else {
              effectiveBpm = item.customBpm || this.baseBpm;
            }

            const beatDuration = 60 / effectiveBpm;
            const measureDuration = (item.beats || 4) * beatDuration;

            for (let mr = 0; mr < mRepeat; mr++) {
              const timing = {
                timingIndex: globalTimingIndex++,
                measureIndex: mIdx,
                repeatIteration: mr,
                repeatCount: mRepeat,
                groupId: block.section ? block.section.id : null,
                groupRepeatIteration: sr,
                groupRepeatCount: secRepeat,
                startTime: accumulatedTime,
                endTime: accumulatedTime + measureDuration,
                duration: measureDuration,
                effectiveBpm: effectiveBpm,
                beatDuration: beatDuration,
                beats: item.beats || 4,
                beatUnit: item.beatUnit || 4
              };

              this.measureTimings.push(timing);
              if (!this.firstTimingByMeasure.has(mIdx)) {
                this.firstTimingByMeasure.set(mIdx, timing);
              }
              this.lastTimingByMeasure.set(mIdx, timing);
              accumulatedTime += measureDuration;
            }
          }
        });
      }
    });

    this.measures = flattenedMeasures;
    this.groups = computedGroups;
    this.computedGroups = computedGroups;
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

  // Inscrição de ouvintes para atualização de interface da partitura
  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  // Inscrição de ouvintes para alterações da biblioteca de peças e bossas (repertório salvo)
  subscribeLibrary(callback) {
    if (!this.libraryListeners) {
      this.libraryListeners = new Set();
    }
    this.libraryListeners.add(callback);
    return () => this.libraryListeners.delete(callback);
  }

  // Notifica ouvintes de que a biblioteca local foi modificada (sem alterar a peça aberta)
  notifyLibraryChange() {
    if (!this.libraryListeners) {
      this.libraryListeners = new Set();
    }
    const library = this.getLibraryPieces();
    for (const cb of this.libraryListeners) {
      try {
        cb(library);
      } catch (err) {
        console.error("Erro no ouvinte de biblioteca:", err);
      }
    }
  }

  // Salvar no localStorage automaticamente
  saveToLocalStorage() {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
    try {
      const data = {
        app: "Sérgio Simulator",
        version: "2.0.0",
        savedAt: new Date().toISOString(),
        piece: {
          id: this.id,
          name: this.name,
          description: this.description,
          presentationBpm: this.presentationBpm,
          baseBpm: this.presentationBpm,
          practiceBpm: this.baseBpm,
          items: (this.items || []).map(it => ({ ...it })),
          groups: this.groups,
          measures: this.measures
        }
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      if (this.id && this.items && this.items.length > 0) {
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
      items: JSON.parse(JSON.stringify(this.items || []))
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
    this.items = JSON.parse(JSON.stringify(snapshot.items || []));
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
    // Grava histórico de Desfazer se for alteração local e não for chamada durante undo/redo e não for ação local exclusiva
    if (!isRemote && !isLocalOnly && !this.isUndoingOrRedoing) {
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
