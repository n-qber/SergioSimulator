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

    // Interação com Compassos e Timeline na Esteira (DJ Runner)
    this.selectedMeasureIndex = null;
    this.selectedMeasureIndices = new Set();
    this.hoveredMeasureIndex = null;
    this.isDraggingRunner = false;
    this.isDraggingMinimap = false;
    this.dragStartX = 0;
    this.dragStartTime = 0;
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

  setSelectedMeasures(indices) {
    if (!indices || indices.length === 0) {
      this.selectedMeasureIndices.clear();
      this.selectedMeasureIndex = null;
    } else {
      this.selectedMeasureIndices = new Set(indices);
      this.selectedMeasureIndex = indices[0];
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

  initEvents() {
    this.canvas.style.touchAction = 'none';
    this.minimapCanvas.style.touchAction = 'none';

    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => {
      setTimeout(() => this.resize(), 100);
    });

    // Multi-touch pinch-to-zoom para celulares
    this.activePointers = new Map();
    this.initialPinchDistance = 0;
    this.initialPps = this.pixelsPerSecond;

    // 1. Pointer Down (Mouse, Touch, Pen): Inicia deslizamento suave da esteira (scrubbing/pan) ou pinch zoom
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return; // Apenas botão principal / touch

      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this.activePointers.size === 2) {
        this.isDraggingRunner = false;
        const pts = Array.from(this.activePointers.values());
        this.initialPinchDistance = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        this.initialPps = this.pixelsPerSecond;
        return;
      }

      const rect = this.canvas.getBoundingClientRect();
      this.currentMouseX = e.clientX - rect.left;
      this.currentMouseY = e.clientY - rect.top;

      this.mouseDownX = e.clientX;
      this.mouseDownY = e.clientY;
      this.isDraggingRunner = true;
      this.dragStartX = e.clientX;
      this.dragStartTime = this.lastCurrentTime || 0;
      this.canvas.style.cursor = 'grabbing';

      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch (err) {}
    });

    // 2. Pointer Move: Gerencia deslizamento suave da esteira (scrubbing), pinch-to-zoom e hover
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.activePointers.has(e.pointerId)) {
        this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }

      if (this.activePointers.size === 2 && this.initialPinchDistance > 10) {
        const pts = Array.from(this.activePointers.values());
        const currentDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const scale = currentDist / this.initialPinchDistance;
        this.pixelsPerSecond = Math.max(80, Math.min(500, this.initialPps * scale));
        return;
      }

      const rect = this.canvas.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;
      this.currentMouseX = canvasX;
      this.currentMouseY = canvasY;

      if (this.isDraggingRunner) {
        const dx = e.clientX - this.dragStartX;
        const dt = -dx / this.pixelsPerSecond;
        const newTime = Math.max(0, Math.min(this.state.totalDuration, this.dragStartTime + dt));
        if (this.onSeek) this.onSeek(newTime);
        this.canvas.style.cursor = 'grabbing';
        return;
      }

      // Detecção de Hover
      const hit = this.getMeasureAtPoint(canvasX, canvasY);
      if (hit) {
        this.hoveredMeasureIndex = hit.index;
        this.canvas.style.cursor = 'pointer';
      } else {
        this.hoveredMeasureIndex = null;
        this.canvas.style.cursor = 'ew-resize';
      }
    });

    // 3. Pointer Up & Cancel
    const endRunnerDrag = (e) => {
      this.activePointers.delete(e.pointerId);
      if (this.activePointers.size < 2) {
        this.initialPinchDistance = 0;
      }

      if (this.isDraggingRunner) {
        const dist = Math.hypot(e.clientX - this.mouseDownX, e.clientY - this.mouseDownY);
        // Se foi apenas um toque/clique (sem arrasto > 5px), seleciona o compasso e pula para o início dele
        if (dist <= 5) {
          const hit = this.getMeasureAtPoint(this.currentMouseX, this.currentMouseY);
          if (hit) {
            this.selectedMeasureIndex = hit.index;
            if (this.onSelectMeasure) this.onSelectMeasure(hit.index, e);
            const startTime = hit.timing ? hit.timing.startTime : this.state.getFirstTimingForMeasure(hit.index)?.startTime;
            if (startTime !== undefined && startTime !== null && this.onSeek) {
              this.onSeek(startTime);
            }
          }
        }
        try {
          if (this.canvas.hasPointerCapture && this.canvas.hasPointerCapture(e.pointerId)) {
            this.canvas.releasePointerCapture(e.pointerId);
          }
        } catch (err) {}
      }

      this.isDraggingRunner = false;
      this.isDraggingMinimap = false;
      if (this.canvas) {
        const hit = this.getMeasureAtPoint(this.currentMouseX, this.currentMouseY);
        this.canvas.style.cursor = hit ? 'pointer' : 'ew-resize';
      }
    };

    this.canvas.addEventListener('pointerup', endRunnerDrag);
    this.canvas.addEventListener('pointercancel', endRunnerDrag);
    window.addEventListener('pointerup', endRunnerDrag);

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

    // 5. Menu de Contexto (Botão Direito ou Toque Longo)
    this.canvas.addEventListener('contextmenu', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;
      const hit = this.getMeasureAtPoint(canvasX, canvasY);
      if (hit) {
        e.preventDefault();
        this.selectedMeasureIndex = hit.index;
        if (this.onSelectMeasure) this.onSelectMeasure(hit.index, e);
        if (this.onContextMenu) this.onContextMenu(hit.index, e.clientX, e.clientY);
      }
    });

    // 6. Scrubbing e navegação no Minimapa (com Pointer Events)
    this.minimapCanvas.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      this.isDraggingMinimap = true;
      try {
        this.minimapCanvas.setPointerCapture(e.pointerId);
      } catch (err) {}
      this.handleMinimapClick(e);
    });

    this.minimapCanvas.addEventListener('pointermove', (e) => {
      if (this.isDraggingMinimap) {
        this.handleMinimapClick(e);
      }
    });

    const endMinimapDrag = (e) => {
      if (this.isDraggingMinimap) {
        try {
          if (this.minimapCanvas.hasPointerCapture && this.minimapCanvas.hasPointerCapture(e.pointerId)) {
            this.minimapCanvas.releasePointerCapture(e.pointerId);
          }
        } catch (err) {}
        this.isDraggingMinimap = false;
      }
    };

    this.minimapCanvas.addEventListener('pointerup', endMinimapDrag);
    this.minimapCanvas.addEventListener('pointercancel', endMinimapDrag);
    window.addEventListener('pointerup', endMinimapDrag);

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
    this.needleFlashAlpha = isAccent ? 1.0 : 0.65;
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

      const isSelected = this.selectedMeasureIndices.has(t.measureIndex) || (this.selectedMeasureIndex === t.measureIndex);
      const isHovered = (this.hoveredMeasureIndex === t.measureIndex);

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
    }

    // 5. AGULHA CENTRAL (PLAYHEAD)
    if (this.needleFlashAlpha > 0) {
      ctx.fillStyle = `rgba(255, 42, 77, ${this.needleFlashAlpha * 0.45})`;
      ctx.fillRect(playheadX - 10, 0, 20, h);
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
