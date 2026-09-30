/**
 * Renderizador de Visão Corrida estilo DJ (Canvas 60 FPS) para o Sérgio Simulator
 * Versão Interativa & Redimensionável:
 * - Adaptação dinâmica a qualquer altura
 * - Reordenação de compassos diretamente na esteira (Arrastar e Soltar)
 * - Seleção de compasso, menu de contexto e edição por duplo clique
 * - Tiques e números de beat centralizados e proporcionais
 * - Renderização geométrica limpa e de alta nitidez
 */

export class DJRunnerRenderer {
  constructor(canvas, minimapCanvas, state, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.minimapCanvas = minimapCanvas;
    this.minimapCtx = minimapCanvas.getContext('2d', { alpha: false });
    this.state = state;

    // Callbacks de interação
    this.onSeek = callbacks.onSeek || null;
    this.onSelectMeasure = callbacks.onSelectMeasure || null;
    this.onMoveMeasure = callbacks.onMoveMeasure || null;
    this.onEditMeasure = callbacks.onEditMeasure || null;
    this.onContextMenu = callbacks.onContextMenu || null;

    // Zoom horizontal
    this.pixelsPerSecond = 200;
    this.playheadRatio = 0.5;

    // Estado de interação
    this.isDraggingRunner = false;
    this.isDraggingMinimap = false;
    this.dragStartX = 0;
    this.dragStartTime = 0;

    // Interação com Compassos na Esteira ("Mexer compassos nela")
    this.selectedMeasureIndex = null;
    this.hoveredMeasureIndex = null;
    this.hoveredZone = null; // 'header' | 'body'
    this.isPreparingMeasureDrag = false;
    this.isDraggingMeasure = false;
    this.draggedMeasureIndex = null;
    this.dropTargetIndex = null;
    this.mouseDownX = 0;
    this.mouseDownY = 0;
    this.currentMouseX = 0;
    this.currentMouseY = 0;
    this.lastCurrentTime = 0;

    // Dimensões
    this.width = 0;
    this.height = 0;
    this.minimapWidth = 0;
    this.minimapHeight = 0;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);

    // Cache de fundo do minimapa offscreen (elimina ~99% de redraws na esteira)
    this.minimapTrackCanvas = document.createElement('canvas');
    this.minimapTrackCtx = this.minimapTrackCanvas.getContext('2d', { alpha: false });
    this.minimapTrackDirty = true;
    this.lastMinimapTheme = null;

    // Feedback de pulso na agulha
    this.needleFlashAlpha = 0;

    this.initEvents();
    this.resize();

    // Observa redimensionamento dinâmico do elemento pai
    if (window.ResizeObserver && this.canvas.parentElement) {
      this.resizeObserver = new ResizeObserver(() => {
        this.resize();
      });
      this.resizeObserver.observe(this.canvas.parentElement);
    }
  }

  resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);

    const rect = this.canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this.width = rect.width;
      this.height = rect.height;
      this.canvas.width = Math.floor(rect.width * this.dpr);
      this.canvas.height = Math.floor(rect.height * this.dpr);
    }

    const miniRect = this.minimapCanvas.getBoundingClientRect();
    if (miniRect.width > 0 && miniRect.height > 0) {
      this.minimapWidth = miniRect.width;
      this.minimapHeight = miniRect.height;
      this.minimapCanvas.width = Math.floor(miniRect.width * this.dpr);
      this.minimapCanvas.height = Math.floor(miniRect.height * this.dpr);
    }

    this.minimapTrackDirty = true;
  }

  markMinimapDirty() {
    this.minimapTrackDirty = true;
  }

  // Identifica compasso e zona (cabeçalho ou corpo) sob o ponteiro em O(log N)
  getMeasureAtPoint(canvasX, canvasY) {
    const topY = 28;
    const bottomY = this.height - 12;
    if (canvasY < topY || canvasY > bottomY) return null;

    const playheadX = this.width * this.playheadRatio;
    const currentTime = this.lastCurrentTime || 0;
    const timings = this.state.measureTimings;
    if (!timings || timings.length === 0) return null;

    const targetTime = currentTime + (canvasX - playheadX) / this.pixelsPerSecond;
    let low = 0;
    let high = timings.length - 1;

    while (low <= high) {
      const mid = (low + high) >> 1;
      const t = timings[mid];
      if (targetTime < t.startTime) {
        high = mid - 1;
      } else if (targetTime >= t.endTime) {
        low = mid + 1;
      } else {
        const mX = playheadX + (t.startTime - currentTime) * this.pixelsPerSecond;
        const mW = t.duration * this.pixelsPerSecond;
        const zone = (canvasY <= topY + 40) ? 'header' : 'body';
        return { 
          index: t.measureIndex, 
          timingIndex: mid, 
          timing: t, 
          mX, 
          mW, 
          zone 
        };
      }
    }
    return null;
  }

  // Calcula o índice de inserção (drop target) ao arrastar um compasso em O(log N)
  calculateDropTargetIndex(canvasX) {
    const playheadX = this.width * this.playheadRatio;
    const currentTime = this.lastCurrentTime || 0;
    const timeAtX = currentTime + (canvasX - playheadX) / this.pixelsPerSecond;

    const timings = this.state.measureTimings;
    if (!timings || timings.length === 0) return 0;

    let low = 0;
    let high = timings.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const t = timings[mid];
      const midTime = t.startTime + (t.duration * 0.5);
      if (timeAtX < midTime) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    const idx = Math.max(0, Math.min(timings.length - 1, low));
    return timings[idx] ? timings[idx].measureIndex : 0;
  }

  initEvents() {
    window.addEventListener('resize', () => this.resize());

    // 1. Mouse Move: Detecta hover e gerencia arrasto de compasso ou scrubbing
    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;
      this.currentMouseX = canvasX;
      this.currentMouseY = canvasY;

      if (this.isPreparingMeasureDrag && !this.isDraggingMeasure) {
        const dist = Math.hypot(e.clientX - this.mouseDownX, e.clientY - this.mouseDownY);
        if (dist > 5) {
          this.isDraggingMeasure = true;
          this.isDraggingRunner = false;
        }
      }

      if (this.isDraggingMeasure) {
        this.dropTargetIndex = this.calculateDropTargetIndex(canvasX);
        this.canvas.style.cursor = 'grabbing';
        return;
      }

      if (this.isDraggingRunner) {
        const dx = e.clientX - this.dragStartX;
        const dt = -dx / this.pixelsPerSecond;
        const newTime = Math.max(0, Math.min(this.state.totalDuration, this.dragStartTime + dt));
        if (this.onSeek) this.onSeek(newTime);
        return;
      }

      // Detecção de Hover
      const hit = this.getMeasureAtPoint(canvasX, canvasY);
      if (hit) {
        this.hoveredMeasureIndex = hit.index;
        this.hoveredZone = hit.zone;
        this.canvas.style.cursor = (hit.zone === 'header') ? 'grab' : 'pointer';
      } else {
        this.hoveredMeasureIndex = null;
        this.hoveredZone = null;
        this.canvas.style.cursor = 'default';
      }
    });

    // 2. Mouse Down: Inicia arrasto de compasso, seleção ou scrubbing
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // Apenas botão esquerdo

      const rect = this.canvas.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;

      this.mouseDownX = e.clientX;
      this.mouseDownY = e.clientY;
      this.currentMouseX = canvasX;
      this.currentMouseY = canvasY;

      const hit = this.getMeasureAtPoint(canvasX, canvasY);
      if (hit) {
        this.draggedMeasureIndex = hit.index;
        this.draggedTiming = hit.timing;
        this.isPreparingMeasureDrag = true;

        if (hit.zone === 'header') {
          // Clique direto no cabeçalho/alça: prioridade para mover compasso
          this.isDraggingRunner = false;
        } else {
          // Clique no corpo: prepara para scrub ou seleção se soltar sem mover
          this.isDraggingRunner = true;
          this.dragStartX = e.clientX;
          this.dragStartTime = this.lastCurrentTime || 0;
        }
      } else {
        this.draggedTiming = null;
        this.isDraggingRunner = true;
        this.dragStartX = e.clientX;
        this.dragStartTime = this.lastCurrentTime || 0;
      }
    });

    // 3. Mouse Up Global
    window.addEventListener('mouseup', (e) => {
      if (this.isDraggingMeasure) {
        if (this.dropTargetIndex !== null && this.dropTargetIndex !== this.draggedMeasureIndex) {
          if (this.onMoveMeasure) {
            this.onMoveMeasure(this.draggedMeasureIndex, this.dropTargetIndex);
          }
          this.selectedMeasureIndex = this.dropTargetIndex;
        }
        this.isDraggingMeasure = false;
        this.isPreparingMeasureDrag = false;
        this.draggedMeasureIndex = null;
        this.draggedTiming = null;
        this.dropTargetIndex = null;
        return;
      }

      // Se preparou o arrasto mas não moveu > 5px, interpreta como clique de seleção
      if (this.isPreparingMeasureDrag) {
        const dist = Math.hypot(e.clientX - this.mouseDownX, e.clientY - this.mouseDownY);
        if (dist <= 6 && this.draggedMeasureIndex !== null) {
          const idx = this.draggedMeasureIndex;
          this.selectedMeasureIndex = idx;
          if (this.onSelectMeasure) this.onSelectMeasure(idx);

          const startTime = this.draggedTiming ? this.draggedTiming.startTime : this.state.getFirstTimingForMeasure(idx)?.startTime;
          if (startTime !== undefined && startTime !== null && this.onSeek) {
            this.onSeek(startTime);
          }
        }
      }

      this.isPreparingMeasureDrag = false;
      this.draggedMeasureIndex = null;
      this.draggedTiming = null;
      this.isDraggingRunner = false;
      this.isDraggingMinimap = false;
    });

    // 4. Duplo Clique: Abre modal de configuração do compasso clicado
    this.canvas.addEventListener('dblclick', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;
      const hit = this.getMeasureAtPoint(canvasX, canvasY);
      if (hit && this.onEditMeasure) {
        this.onEditMeasure(hit.index);
      }
    });

    // 5. Menu de Contexto (Botão Direito)
    this.canvas.addEventListener('contextmenu', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;
      const hit = this.getMeasureAtPoint(canvasX, canvasY);
      if (hit) {
        e.preventDefault();
        this.selectedMeasureIndex = hit.index;
        if (this.onSelectMeasure) this.onSelectMeasure(hit.index);
        if (this.onContextMenu) this.onContextMenu(hit.index, e.clientX, e.clientY);
      }
    });

    // 6. Scrubbing e navegação no Minimapa
    this.minimapCanvas.addEventListener('mousedown', (e) => {
      this.isDraggingMinimap = true;
      this.handleMinimapClick(e);
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isDraggingMinimap) {
        this.handleMinimapClick(e);
      }
    });

    // 7. Zoom horizontal com roda do mouse
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
      this.pixelsPerSecond = Math.max(80, Math.min(500, this.pixelsPerSecond * zoomFactor));
    }, { passive: false });
  }

  handleMinimapClick(e) {
    const rect = this.minimapCanvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const seekTime = ratio * this.state.totalDuration;
    if (this.onSeek) this.onSeek(seekTime);
  }

  get isLightTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light';
  }

  triggerBeatHit(isAccent = false) {
    this.needleFlashAlpha = isAccent ? 0.7 : 0.35;
  }

  render(currentTime, dt = 0.016) {
    this.lastCurrentTime = currentTime;
    if (this.needleFlashAlpha > 0) {
      this.needleFlashAlpha = Math.max(0, this.needleFlashAlpha - dt * 5.0);
    }

    this.renderRunner(currentTime);
    this.renderMinimap(currentTime);
  }

  renderRunner(currentTime) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    if (w <= 0 || h <= 0) return;

    const isLight = this.isLightTheme;

    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    // Fundo limpo
    ctx.fillStyle = isLight ? "#f8fafc" : "#0c0e12";
    ctx.fillRect(0, 0, w, h);

    const playheadX = w * this.playheadRatio;
    const timings = this.state.measureTimings;

    // Se não há compassos (0 compassos na peça)
    if (!timings || timings.length === 0) {
      // Linha central pontilhada sutil
      ctx.strokeStyle = isLight ? "rgba(15, 23, 42, 0.12)" : "rgba(255, 255, 255, 0.08)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, h);
      ctx.stroke();
      ctx.setLineDash([]);

      // Mensagem de estado vazio bonita e elegante
      ctx.fillStyle = isLight ? "#475569" : "rgba(255, 255, 255, 0.5)";
      ctx.font = "600 13.5px 'Outfit', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Nenhum compasso na peça", w / 2, h / 2 - 12);

      ctx.fillStyle = isLight ? "#94a3b8" : "rgba(255, 255, 255, 0.28)";
      ctx.font = "500 11px 'JetBrains Mono', monospace";
      ctx.fillText("Adicione compassos para visualizar e modular o ritmo", w / 2, h / 2 + 12);

      ctx.restore();
      return;
    }

    const visibleTimeStart = currentTime - (playheadX / this.pixelsPerSecond) - 0.5;
    const visibleTimeEnd = currentTime + ((w - playheadX) / this.pixelsPerSecond) + 0.5;

    // 1. Faixas de Grupos (apenas os visíveis)
    const groups = this.state.groups || [];
    if (groups.length > 0) {
      const bannerHeight = 22;
      ctx.font = "600 10.5px 'Outfit', sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";

      for (let g = 0; g < groups.length; g++) {
        const grp = groups[g];
        const startTiming = this.state.getFirstTimingForMeasure(grp.startMeasure);
        const endTiming = this.state.getLastTimingForMeasure(grp.endMeasure);
        if (!startTiming || !endTiming) continue;

        if (endTiming.endTime < visibleTimeStart || startTiming.startTime > visibleTimeEnd) continue;

        const grpX1 = playheadX + (startTiming.startTime - currentTime) * this.pixelsPerSecond;
        const grpX2 = playheadX + (endTiming.endTime - currentTime) * this.pixelsPerSecond;
        const grpW = grpX2 - grpX1;

        ctx.fillStyle = `${grp.color}18`;
        ctx.fillRect(grpX1, 3, grpW, bannerHeight);

        ctx.fillStyle = grp.color;
        ctx.fillRect(grpX1, 3, grpW, 2.5);

        ctx.fillStyle = isLight ? "#0f172a" : "#ffffff";
        const textX = Math.max(grpX1 + 8, 12);
        if (textX < grpX2 - 16) {
          ctx.fillText(`⯈ ${grp.name}`, textX, 3 + bannerHeight / 2);
        }
      }
    }

    // 2. Blocos de Compasso com Culling por Busca Binária O(log N)
    // Localiza o primeiro timing visível em O(log N) em vez de iterar por todos
    let startIdx = 0;
    let low = 0;
    let high = timings.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (timings[mid].endTime < visibleTimeStart) {
        low = mid + 1;
      } else {
        startIdx = mid;
        high = mid - 1;
      }
    }

    const topY = 28;
    const bottomY = h - 12;
    const blockH = Math.max(80, bottomY - topY);
    const midY = topY + blockH * 0.52;
    const maxTickH = Math.min(blockH * 0.42, 90);

    const defaultBorderColor = isLight ? "rgba(15, 23, 42, 0.12)" : "rgba(255, 255, 255, 0.08)";
    const beatLineColor = isLight ? "rgba(15, 23, 42, 0.08)" : "rgba(255, 255, 255, 0.08)";
    const normalTickColor = isLight ? "rgba(15, 23, 42, 0.2)" : "rgba(255, 255, 255, 0.22)";
    const normalNumColor = isLight ? "rgba(15, 23, 42, 0.55)" : "rgba(255, 255, 255, 0.38)";
    const accentNumColor = isLight ? "#0f172a" : "#ffffff";

    for (let idx = startIdx; idx < timings.length; idx++) {
      const t = timings[idx];
      // Termina imediatamente assim que ultrapassar a borda direita do viewport
      if (t.startTime > visibleTimeEnd) break;

      const m = this.state.measures[t.measureIndex];
      if (!m) continue;

      const mX = playheadX + (t.startTime - currentTime) * this.pixelsPerSecond;
      const mW = t.duration * this.pixelsPerSecond;
      const mColor = m.color || "#ff334b";

      const isSelected = (this.selectedMeasureIndex === t.measureIndex);
      const isHovered = (this.hoveredMeasureIndex === t.measureIndex);
      const isBeingDragged = (this.isDraggingMeasure && this.draggedMeasureIndex === t.measureIndex);

      if (isBeingDragged) {
        ctx.globalAlpha = 0.35;
      }

      // Bloco do compasso
      ctx.fillStyle = isSelected ? (isLight ? "#eff6ff" : "#181d28") : (isLight ? "#ffffff" : "#12151c");
      ctx.fillRect(mX, topY, mW, blockH);

      // Borda lateral esquerda identificadora
      ctx.fillStyle = mColor;
      ctx.fillRect(mX, topY, 3, blockH);

      // Borda delimitadora
      ctx.strokeStyle = isSelected ? "#3b82f6" : defaultBorderColor;
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.strokeRect(mX, topY, mW, blockH);

      // Destaque de seleção
      if (isSelected) {
        ctx.fillStyle = isLight ? "rgba(59, 130, 246, 0.1)" : "rgba(59, 130, 246, 0.08)";
        ctx.fillRect(mX, topY, mW, blockH);
      }

      // Destaque de hover no cabeçalho
      if (isHovered && this.hoveredZone === 'header') {
        ctx.fillStyle = isLight ? "rgba(15, 23, 42, 0.04)" : "rgba(255, 255, 255, 0.06)";
        ctx.fillRect(mX, topY, mW, 38);
      }

      // Sinalização musical de repetição (pontos de repetição nas bordas do bloco)
      if (t.repeatCount > 1) {
        ctx.fillStyle = mColor;
        if (t.repeatIteration === 0) {
          ctx.beginPath();
          ctx.arc(mX + 8, midY - 6, 2.2, 0, Math.PI * 2);
          ctx.arc(mX + 8, midY + 6, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
        if (t.repeatIteration === t.repeatCount - 1) {
          ctx.beginPath();
          ctx.arc(mX + mW - 8, midY - 6, 2.2, 0, Math.PI * 2);
          ctx.arc(mX + mW - 8, midY + 6, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Divisões e Marcadores de Beat
      const beatW = t.beatDuration * this.pixelsPerSecond;
      const accentTickColor = `${mColor}ee`;

      for (let b = 0; b < t.beats; b++) {
        const beatX = mX + b * beatW;

        if (b > 0) {
          ctx.strokeStyle = beatLineColor;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(beatX, topY + 36);
          ctx.lineTo(beatX, bottomY - 24);
          ctx.stroke();
        }

        const isFirst = (b === 0);
        const tickH = isFirst ? Math.max(30, maxTickH) : Math.max(18, maxTickH * 0.55);

        ctx.fillStyle = isFirst ? accentTickColor : normalTickColor;
        ctx.fillRect(beatX + (isFirst ? 3 : 0), midY - tickH / 2, isFirst ? 2.5 : 1.5, tickH);
      }

      // Números dos beats (fonte setada uma única vez para todos os tempos do compasso)
      ctx.font = "600 10px 'JetBrains Mono', monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      for (let b = 0; b < t.beats; b++) {
        const beatX = mX + b * beatW;
        const isFirst = (b === 0);
        const tickH = isFirst ? Math.max(30, maxTickH) : Math.max(18, maxTickH * 0.55);

        ctx.fillStyle = isFirst ? accentNumColor : normalNumColor;
        ctx.fillText(`${b + 1}`, beatX + (isFirst ? 4 : 0), midY - tickH / 2 - 12);
      }

      // 3. APELIDO / IDENTIFICAÇÃO DO COMPASSO (Cabeçalho Interativo)
      const nicknameX = mX + 12;
      const nicknameY = topY + 18;
      const maxTextWidth = Math.max(10, mW - 36);

      ctx.textAlign = "left";
      ctx.textBaseline = "middle";

      const hasNickname = !!(m.nickname && m.nickname.trim());
      const repeatTag = (t.repeatCount > 1) ? ` [${t.repeatIteration + 1}/${t.repeatCount}]` : '';

      if (hasNickname) {
        // Tag c. X discreta com repetição acima
        ctx.fillStyle = accentTickColor;
        ctx.font = "bold 9.5px 'JetBrains Mono', monospace";
        ctx.fillText(`c. ${t.measureIndex + 1}${repeatTag}`, nicknameX, nicknameY - 10);

        // Apelido em destaque
        ctx.fillStyle = isLight ? "#0f172a" : "#ffffff";
        ctx.font = "bold 13.5px 'Outfit', sans-serif";
        ctx.fillText(m.nickname, nicknameX, nicknameY + 2, maxTextWidth);
      } else {
        // Compasso sem nome: exibe "c. X [rep/total]" com destaque limpo
        ctx.fillStyle = isLight ? "#0f172a" : "#ffffff";
        ctx.font = "bold 14px 'Outfit', sans-serif";
        ctx.fillText(`c. ${t.measureIndex + 1}${repeatTag}`, nicknameX, nicknameY - 1, maxTextWidth);
      }

      // Alça de arrastar (⠿) no cabeçalho do compasso
      if (mW > 42) {
        ctx.fillStyle = (isHovered && this.hoveredZone === 'header') 
          ? (isLight ? "rgba(15, 23, 42, 0.85)" : "rgba(255, 255, 255, 0.7)") 
          : (isLight ? "rgba(15, 23, 42, 0.35)" : "rgba(255, 255, 255, 0.2)");
        ctx.font = "11px 'JetBrains Mono', monospace";
        ctx.textAlign = "right";
        ctx.fillText("⠿", mX + mW - 8, topY + 16);
      }

      // 4. Métrica e Andamento Secundários (Rodapé do compasso)
      const badgeY = bottomY - 10;
      ctx.textAlign = "left";
      ctx.fillStyle = isLight ? "rgba(15, 23, 42, 0.8)" : "rgba(255, 255, 255, 0.75)";
      ctx.font = "600 10.5px 'JetBrains Mono', monospace";
      ctx.fillText(`${m.beats}/${m.beatUnit}`, nicknameX, badgeY);

      let tempoText = "";
      if (m.tempoMode === "ratio") {
        if (m.ratioNum === 1 && m.ratioDen === 1) {
          tempoText = `${Math.round(t.effectiveBpm)} BPM`;
        } else {
          tempoText = `${Math.round(t.effectiveBpm)} BPM (${m.ratioNum}/${m.ratioDen})`;
        }
      } else {
        tempoText = `${Math.round(t.effectiveBpm)} BPM`;
      }

      const repFootText = (t.repeatCount > 1) ? ` • rep. ${t.repeatIteration + 1}/${t.repeatCount}` : '';

      ctx.fillStyle = isLight ? "rgba(15, 23, 42, 0.55)" : "rgba(255, 255, 255, 0.4)";
      ctx.font = "500 9.5px 'JetBrains Mono', monospace";
      ctx.fillText(`• ${tempoText}${repFootText}`, nicknameX + 32, badgeY);

      if (isBeingDragged) {
        ctx.globalAlpha = 1.0;
      }
    }

    // 5. Linha de Destino ao Arrastar Compasso (Drop Target Indicator)
    if (this.isDraggingMeasure && this.dropTargetIndex !== null) {
      const targetIdx = Math.max(0, Math.min(timings.length, this.dropTargetIndex));
      let dropX = 0;
      if (targetIdx < timings.length) {
        const targetTiming = timings[targetIdx];
        dropX = playheadX + (targetTiming.startTime - currentTime) * this.pixelsPerSecond;
      } else {
        const lastTiming = timings[timings.length - 1];
        dropX = playheadX + (lastTiming.endTime - currentTime) * this.pixelsPerSecond;
      }

      // Linha vertical de inserção brilhante
      ctx.strokeStyle = "#ff2a4d";
      ctx.lineWidth = 4;
      ctx.shadowColor = "rgba(255, 42, 77, 0.8)";
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(dropX, topY - 6);
      ctx.lineTo(dropX, bottomY + 6);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Marcador indicador com texto
      ctx.fillStyle = "#ff2a4d";
      ctx.font = "bold 11px 'Outfit', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText("▼ Inserir aqui", dropX, topY - 8);

      // Cartão flutuante (Ghost) acompanhando o mouse
      const ghostW = 124;
      const ghostH = 34;
      const gx = Math.max(ghostW / 2, Math.min(w - ghostW / 2, this.currentMouseX));
      const gy = Math.max(ghostH + 10, this.currentMouseY);

      ctx.fillStyle = isLight ? "#ffffff" : "#151a24";
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(gx - ghostW / 2, gy - ghostH - 12, ghostW, ghostH, 6);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = isLight ? "#0f172a" : "#ffffff";
      ctx.font = "bold 11px 'Outfit', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const movedM = this.state.measures[this.draggedMeasureIndex];
      const movedTitle = movedM?.nickname ? `c. ${this.draggedMeasureIndex + 1} (${movedM.nickname})` : `c. ${this.draggedMeasureIndex + 1}`;
      ctx.fillText(`Mover ${movedTitle}`, gx, gy - ghostH / 2 - 12);
    }

    // 6. AGULHA CENTRAL (PLAYHEAD)
    if (this.needleFlashAlpha > 0) {
      ctx.fillStyle = `rgba(255, 42, 77, ${this.needleFlashAlpha * 0.3})`;
      ctx.fillRect(playheadX - 6, 0, 12, h);
    }

    // Linha vermelha com centro branco
    ctx.strokeStyle = "#ff2a4d";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, h);
    ctx.stroke();

    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, h);
    ctx.stroke();

    // Marcadores triangulares superior e inferior
    this.drawCueMarker(ctx, playheadX, 7, true);
    this.drawCueMarker(ctx, playheadX, h - 7, false);

    ctx.restore();
  }

  drawCueMarker(ctx, x, y, pointingDown) {
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    if (pointingDown) {
      ctx.moveTo(x - 5, y - 6);
      ctx.lineTo(x + 5, y - 6);
      ctx.lineTo(x, y + 1);
    } else {
      ctx.moveTo(x - 5, y + 6);
      ctx.lineTo(x + 5, y + 6);
      ctx.lineTo(x, y - 1);
    }
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = "#ff2a4d";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /**
   * Atualiza a pista do minimapa no canvas offscreen apenas quando há alterações estruturais ou resize.
   * Evita redesenhar centenas de blocos e bordas 60 vezes por segundo.
   */
  updateMinimapTrack() {
    const w = this.minimapWidth;
    const h = this.minimapHeight;
    if (w <= 0 || h <= 0) return;

    const canvasW = this.minimapCanvas.width;
    const canvasH = this.minimapCanvas.height;

    if (this.minimapTrackCanvas.width !== canvasW || this.minimapTrackCanvas.height !== canvasH) {
      this.minimapTrackCanvas.width = canvasW;
      this.minimapTrackCanvas.height = canvasH;
    }

    const ctx = this.minimapTrackCtx;
    const isLight = this.isLightTheme;
    this.lastMinimapTheme = isLight;

    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    // Fundo limpo
    ctx.fillStyle = isLight ? "#f1f5f9" : "#0c0e12";
    ctx.fillRect(0, 0, w, h);

    const totalDuration = this.state.totalDuration || 1;
    const timings = this.state.measureTimings;
    if (timings && timings.length > 0) {
      const strokeColor = isLight ? "rgba(15, 23, 42, 0.08)" : "rgba(255, 255, 255, 0.08)";
      ctx.lineWidth = 1;

      for (let idx = 0; idx < timings.length; idx++) {
        const t = timings[idx];
        const x = (t.startTime / totalDuration) * w;
        const blockW = Math.max(1.5, (t.duration / totalDuration) * w);
        const m = this.state.measures[t.measureIndex];

        ctx.fillStyle = `${m?.color || "#ff334b"}33`;
        ctx.fillRect(x, 0, blockW, h);

        ctx.strokeStyle = strokeColor;
        ctx.strokeRect(x, 0, blockW, h);
      }

      const groups = this.state.groups || [];
      for (let g = 0; g < groups.length; g++) {
        const grp = groups[g];
        const st = this.state.getFirstTimingForMeasure(grp.startMeasure);
        const et = this.state.getLastTimingForMeasure(grp.endMeasure);
        if (!st || !et) continue;

        const gx1 = (st.startTime / totalDuration) * w;
        const gx2 = (et.endTime / totalDuration) * w;
        ctx.fillStyle = grp.color;
        ctx.fillRect(gx1, 0, gx2 - gx1, 2.5);
      }
    }

    ctx.restore();
    this.minimapTrackDirty = false;
  }

  /**
   * Renderiza o minimapa em 60 FPS com overhead próximo a zero.
   * Utiliza a pista pré-renderizada em cache e apenas posiciona a agulha atual.
   */
  renderMinimap(currentTime) {
    const ctx = this.minimapCtx;
    const w = this.minimapWidth;
    const h = this.minimapHeight;
    if (w <= 0 || h <= 0) return;

    const isLight = this.isLightTheme;
    if (this.minimapTrackDirty || this.lastMinimapTheme !== isLight) {
      this.updateMinimapTrack();
    }

    // Desenho instantâneo da esteira via textura GPU offscreen
    ctx.drawImage(this.minimapTrackCanvas, 0, 0);

    const totalDuration = this.state.totalDuration || 1;
    if (!this.state.measureTimings || this.state.measureTimings.length === 0) return;

    const curX = Math.max(0, Math.min(w, (currentTime / totalDuration) * w));

    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    ctx.fillStyle = "#ff2a4d";
    ctx.fillRect(curX - 1.5, 0, 3, h);

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(curX - 0.5, 0, 1, h);

    ctx.restore();
  }
}
