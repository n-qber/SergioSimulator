/**
 * Renderizador de Visão Corrida estilo DJ (Canvas 60 FPS) para o Sérgio Simulator
 * Versão Leve (Minimalista & Ultra-Rápida):
 * - Sem partículas desnecessárias
 * - Renderização geométrica limpa e de alta nitidez
 * - Linhas e fontes nítidas, estilo console moderno de estúdio (Pioneer / Teenage Engineering)
 */

export class DJRunnerRenderer {
  constructor(canvas, minimapCanvas, state, onSeek) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.minimapCanvas = minimapCanvas;
    this.minimapCtx = minimapCanvas.getContext('2d', { alpha: false });
    this.state = state;
    this.onSeek = onSeek;

    // Zoom horizontal
    this.pixelsPerSecond = 200;
    this.playheadRatio = 0.5;

    // Estado de interação
    this.isDraggingRunner = false;
    this.isDraggingMinimap = false;
    this.dragStartX = 0;
    this.dragStartTime = 0;

    // Dimensões
    this.width = 0;
    this.height = 0;
    this.minimapWidth = 0;
    this.minimapHeight = 0;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);

    // Feedback de pulso na agulha (apenas brilho instantâneo, sem partículas pesadas)
    this.needleFlashAlpha = 0;

    this.initEvents();
    this.resize();
  }

  resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);

    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.floor(rect.width * this.dpr);
    this.canvas.height = Math.floor(rect.height * this.dpr);

    const miniRect = this.minimapCanvas.getBoundingClientRect();
    this.minimapWidth = miniRect.width;
    this.minimapHeight = miniRect.height;
    this.minimapCanvas.width = Math.floor(miniRect.width * this.dpr);
    this.minimapCanvas.height = Math.floor(miniRect.height * this.dpr);
  }

  initEvents() {
    window.addEventListener('resize', () => this.resize());

    // Scrubbing no DJ Runner
    this.canvas.addEventListener('mousedown', (e) => {
      this.isDraggingRunner = true;
      this.dragStartX = e.clientX;
      this.dragStartTime = this.lastCurrentTime || 0;
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isDraggingRunner) {
        const dx = e.clientX - this.dragStartX;
        const dt = -dx / this.pixelsPerSecond;
        const newTime = Math.max(0, Math.min(this.state.totalDuration, this.dragStartTime + dt));
        if (this.onSeek) this.onSeek(newTime);
      } else if (this.isDraggingMinimap) {
        this.handleMinimapClick(e);
      }
    });

    window.addEventListener('mouseup', () => {
      this.isDraggingRunner = false;
      this.isDraggingMinimap = false;
    });

    // Scrubbing no Minimapa
    this.minimapCanvas.addEventListener('mousedown', (e) => {
      this.isDraggingMinimap = true;
      this.handleMinimapClick(e);
    });

    // Zoom
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

  triggerBeatHit(isAccent = false) {
    // Flash sutil na agulha sem peso de CPU
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

    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    // Fundo limpo flat (sem gradientes custosos)
    ctx.fillStyle = "#0c0e12";
    ctx.fillRect(0, 0, w, h);

    const playheadX = w * this.playheadRatio;
    const visibleTimeStart = currentTime - (playheadX / this.pixelsPerSecond) - 0.5;
    const visibleTimeEnd = currentTime + ((w - playheadX) / this.pixelsPerSecond) + 0.5;

    const timings = this.state.measureTimings;
    if (!timings || timings.length === 0) {
      ctx.restore();
      return;
    }

    // 1. Faixas de Grupos (Minimalistas e limpas)
    const groups = this.state.groups || [];
    const bannerHeight = 22;

    for (let g = 0; g < groups.length; g++) {
      const grp = groups[g];
      const startTiming = timings[grp.startMeasure];
      const endTiming = timings[grp.endMeasure];
      if (!startTiming || !endTiming) continue;

      if (endTiming.endTime < visibleTimeStart || startTiming.startTime > visibleTimeEnd) continue;

      const grpX1 = playheadX + (startTiming.startTime - currentTime) * this.pixelsPerSecond;
      const grpX2 = playheadX + (endTiming.endTime - currentTime) * this.pixelsPerSecond;
      const grpW = grpX2 - grpX1;

      // Barra de grupo sutil
      ctx.fillStyle = `${grp.color}18`;
      ctx.fillRect(grpX1, 3, grpW, bannerHeight);

      ctx.fillStyle = grp.color;
      ctx.fillRect(grpX1, 3, grpW, 2.5);

      ctx.fillStyle = "#ffffff";
      ctx.font = "600 10.5px 'Outfit', sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";

      const textX = Math.max(grpX1 + 8, 12);
      if (textX < grpX2 - 16) {
        ctx.fillText(`⯈ ${grp.name}`, textX, 3 + bannerHeight / 2);
      }
    }

    // 2. Blocos de Compasso
    const topY = 28;
    const bottomY = h - 12;
    const blockH = bottomY - topY;

    for (let idx = 0; idx < timings.length; idx++) {
      const t = timings[idx];
      if (t.endTime < visibleTimeStart || t.startTime > visibleTimeEnd) continue;

      const m = this.state.measures[idx];
      const mX = playheadX + (t.startTime - currentTime) * this.pixelsPerSecond;
      const mW = t.duration * this.pixelsPerSecond;
      const mColor = m.color || "#ff334b";

      // Bloco do compasso
      ctx.fillStyle = "#12151c";
      ctx.fillRect(mX, topY, mW, blockH);

      // Borda lateral esquerda identificadora
      ctx.fillStyle = mColor;
      ctx.fillRect(mX, topY, 2.5, blockH);

      // Borda sutil delimitadora
      ctx.strokeStyle = "rgba(255, 255, 255, 0.07)";
      ctx.lineWidth = 1;
      ctx.strokeRect(mX, topY, mW, blockH);

      // Divisões e Marcadores de Beat
      const beatW = t.beatDuration * this.pixelsPerSecond;
      for (let b = 0; b < t.beats; b++) {
        const beatX = mX + b * beatW;

        if (b > 0) {
          ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(beatX, topY + 30);
          ctx.lineTo(beatX, bottomY - 22);
          ctx.stroke();
        }

        // Tique de percussão minimalista no centro do compasso
        const isFirst = (b === 0);
        const tickH = isFirst ? 28 : 16;
        const tickY = topY + blockH * 0.55;

        ctx.fillStyle = isFirst ? `${mColor}cc` : "rgba(255, 255, 255, 0.22)";
        ctx.fillRect(beatX + (isFirst ? 3 : 0), tickY - tickH / 2, isFirst ? 2 : 1.5, tickH);

        // Número do tempo discreto
        ctx.fillStyle = isFirst ? "#ffffff" : "rgba(255, 255, 255, 0.35)";
        ctx.font = "600 9.5px 'JetBrains Mono', monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`${b + 1}`, beatX + (isFirst ? 4 : 0), topY + 40);
      }

      // 3. APELIDO DO COMPASSO (DESTAQUE PRINCIPAL)
      const nicknameX = mX + 12;
      const nicknameY = topY + 18;

      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 14px 'Outfit', sans-serif";

      const maxTextWidth = Math.max(10, mW - 18);
      ctx.fillText(m.nickname || `Compasso ${idx + 1}`, nicknameX, nicknameY, maxTextWidth);

      // Número do compasso (Tag c. X)
      ctx.fillStyle = `${mColor}ee`;
      ctx.font = "bold 9.5px 'JetBrains Mono', monospace";
      ctx.fillText(`c. ${idx + 1}`, nicknameX, nicknameY - 11);

      // 4. Métrica e Andamento Secundários (Discretos)
      const badgeY = bottomY - 10;
      ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
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

      ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
      ctx.font = "500 9.5px 'JetBrains Mono', monospace";
      ctx.fillText(`• ${tempoText}`, nicknameX + 32, badgeY);
    }

    // 5. AGULHA CENTRAL (PLAYHEAD) - Limpa, nítida e direta
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

  renderMinimap(currentTime) {
    const ctx = this.minimapCtx;
    const w = this.minimapWidth;
    const h = this.minimapHeight;
    if (w <= 0 || h <= 0) return;

    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    ctx.fillStyle = "#0c0e12";
    ctx.fillRect(0, 0, w, h);

    const totalDuration = this.state.totalDuration || 1;
    const timings = this.state.measureTimings;
    if (!timings || timings.length === 0) {
      ctx.restore();
      return;
    }

    for (let idx = 0; idx < timings.length; idx++) {
      const t = timings[idx];
      const x = (t.startTime / totalDuration) * w;
      const blockW = Math.max(1.5, (t.duration / totalDuration) * w);
      const m = this.state.measures[idx];

      ctx.fillStyle = `${m.color || "#ff334b"}33`;
      ctx.fillRect(x, 0, blockW, h);

      ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x, 0, blockW, h);
    }

    const groups = this.state.groups || [];
    for (let g = 0; g < groups.length; g++) {
      const grp = groups[g];
      const st = timings[grp.startMeasure];
      const et = timings[grp.endMeasure];
      if (!st || !et) continue;

      const gx1 = (st.startTime / totalDuration) * w;
      const gx2 = (et.endTime / totalDuration) * w;
      ctx.fillStyle = grp.color;
      ctx.fillRect(gx1, 0, gx2 - gx1, 2.5);
    }

    const curX = Math.max(0, Math.min(w, (currentTime / totalDuration) * w));
    ctx.fillStyle = "#ff2a4d";
    ctx.fillRect(curX - 1.5, 0, 3, h);

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(curX - 0.5, 0, 1, h);

    ctx.restore();
  }
}
