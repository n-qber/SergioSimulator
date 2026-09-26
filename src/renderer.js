/**
 * Renderizador de Visão Corrida estilo DJ (Canvas 60 FPS) para o Sérgio Simulator
 * Exibe timeline com agulha centralizada, compassos, apelidos em destaque, grupos,
 * pulsos rítmicos e minimapa de navegação instantânea.
 * Altamente otimizado para evitar travamentos ou quedas de frame.
 */

export class DJRunnerRenderer {
  constructor(canvas, minimapCanvas, state, onSeek) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.minimapCanvas = minimapCanvas;
    this.minimapCtx = minimapCanvas.getContext('2d', { alpha: false });
    this.state = state;
    this.onSeek = onSeek;

    // Configurações visuais (pixels por segundo)
    this.pixelsPerSecond = 220; // Zoom horizontal do DJ runner
    this.playheadRatio = 0.5; // Agulha no centro exato da tela

    // Estado de interação do mouse
    this.isDraggingRunner = false;
    this.isDraggingMinimap = false;
    this.dragStartX = 0;
    this.dragStartTime = 0;

    // Cache de dimensões
    this.width = 0;
    this.height = 0;
    this.minimapWidth = 0;
    this.minimapHeight = 0;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);

    // Partículas de impacto na agulha
    this.hitParticles = [];

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

    // Interação no DJ Runner (Arrastar para scrub / clique)
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

    // Interação no Minimapa
    this.minimapCanvas.addEventListener('mousedown', (e) => {
      this.isDraggingMinimap = true;
      this.handleMinimapClick(e);
    });

    // Zoom com roda do mouse
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
      this.pixelsPerSecond = Math.max(80, Math.min(600, this.pixelsPerSecond * zoomFactor));
    }, { passive: false });
  }

  handleMinimapClick(e) {
    const rect = this.minimapCanvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const seekTime = ratio * this.state.totalDuration;
    if (this.onSeek) this.onSeek(seekTime);
  }

  triggerBeatHit(isAccent = false) {
    const count = isAccent ? 8 : 4;
    const playheadX = this.width * this.playheadRatio;
    for (let i = 0; i < count; i++) {
      this.hitParticles.push({
        x: playheadX + (Math.random() * 6 - 3),
        y: this.height * 0.5 + (Math.random() * 30 - 15),
        vx: (Math.random() - 0.5) * 100,
        vy: (Math.random() - 0.5) * 60,
        color: isAccent ? "#ffffff" : "#ff334b",
        radius: isAccent ? 2.5 : 1.8,
        alpha: 1.0,
        decay: Math.random() * 3 + 3
      });
    }
  }

  updateParticles(dt) {
    for (let i = this.hitParticles.length - 1; i >= 0; i--) {
      const p = this.hitParticles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.alpha -= p.decay * dt;
      if (p.alpha <= 0) {
        this.hitParticles.splice(i, 1);
      }
    }
  }

  render(currentTime, dt = 0.016) {
    this.lastCurrentTime = currentTime;
    this.updateParticles(dt);

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

    // Fundo escuro sólido
    ctx.fillStyle = "#0c0e12";
    ctx.fillRect(0, 0, w, h);

    // Linha central horizontal discreta
    ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h * 0.5);
    ctx.lineTo(w, h * 0.5);
    ctx.stroke();

    const playheadX = w * this.playheadRatio;
    const visibleTimeStart = currentTime - (playheadX / this.pixelsPerSecond) - 0.5;
    const visibleTimeEnd = currentTime + ((w - playheadX) / this.pixelsPerSecond) + 0.5;

    const timings = this.state.measureTimings;
    if (!timings || timings.length === 0) {
      ctx.restore();
      return;
    }

    // 1. Renderiza GRUPOS visíveis
    const groups = this.state.groups || [];
    const bannerHeight = 24;

    for (let g = 0; g < groups.length; g++) {
      const grp = groups[g];
      const startTiming = timings[grp.startMeasure];
      const endTiming = timings[grp.endMeasure];
      if (!startTiming || !endTiming) continue;

      if (endTiming.endTime < visibleTimeStart || startTiming.startTime > visibleTimeEnd) continue;

      const grpX1 = playheadX + (startTiming.startTime - currentTime) * this.pixelsPerSecond;
      const grpX2 = playheadX + (endTiming.endTime - currentTime) * this.pixelsPerSecond;
      const grpW = grpX2 - grpX1;

      // Fundo e borda superior do grupo
      ctx.fillStyle = `${grp.color}22`;
      ctx.fillRect(grpX1, 4, grpW, bannerHeight);

      ctx.fillStyle = grp.color;
      ctx.fillRect(grpX1, 4, grpW, 3);

      ctx.strokeStyle = `${grp.color}88`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(grpX1, 4);
      ctx.lineTo(grpX1, 4 + bannerHeight + 6);
      ctx.moveTo(grpX2, 4);
      ctx.lineTo(grpX2, 4 + bannerHeight + 6);
      ctx.stroke();

      ctx.fillStyle = "#ffffff";
      ctx.font = "600 11px 'Outfit', sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";

      const textX = Math.max(grpX1 + 10, 16);
      if (textX < grpX2 - 20) {
        ctx.fillText(`⯈ ${grp.name.toUpperCase()}`, textX, 4 + bannerHeight / 2);
      }
    }

    // 2. Renderiza COMPASSOS visíveis
    const topY = 34;
    const bottomY = h - 14;
    const blockH = bottomY - topY;

    for (let idx = 0; idx < timings.length; idx++) {
      const t = timings[idx];
      if (t.endTime < visibleTimeStart || t.startTime > visibleTimeEnd) continue;

      const m = this.state.measures[idx];
      const mX = playheadX + (t.startTime - currentTime) * this.pixelsPerSecond;
      const mW = t.duration * this.pixelsPerSecond;
      const mColor = m.color || "#ff334b";

      // Fundo e borda esquerda do bloco
      ctx.fillStyle = `${mColor}0e`;
      ctx.fillRect(mX, topY, mW, blockH);

      ctx.fillStyle = mColor;
      ctx.fillRect(mX, topY, 2.5, blockH);

      ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
      ctx.lineWidth = 1;
      ctx.strokeRect(mX, topY, mW, blockH);

      // Formas de onda de percussão otimizadas (renderização ultrarrápida sem Math.exp)
      this.drawFastPercussionWaveform(ctx, mX, topY, mW, blockH, t, mColor);

      // Marcadores dos beats
      const beatW = t.beatDuration * this.pixelsPerSecond;
      for (let b = 0; b < t.beats; b++) {
        const beatX = mX + b * beatW;

        if (b > 0) {
          ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(beatX, topY + 36);
          ctx.lineTo(beatX, bottomY - 28);
          ctx.stroke();
        }

        const isFirstBeat = (b === 0);
        const beatDotY = topY + 42;

        ctx.beginPath();
        ctx.arc(beatX + (isFirstBeat ? 4 : 0), beatDotY, isFirstBeat ? 3.5 : 2, 0, Math.PI * 2);
        ctx.fillStyle = isFirstBeat ? "#ffffff" : "rgba(255, 255, 255, 0.4)";
        ctx.fill();

        ctx.fillStyle = isFirstBeat ? "#ffffff" : "rgba(255, 255, 255, 0.35)";
        ctx.font = "600 10px 'JetBrains Mono', monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`${b + 1}`, beatX + (isFirstBeat ? 4 : 0), beatDotY + 13);
      }

      // 3. APELIDO DO COMPASSO (HERO TITLE)
      const nicknameX = mX + 12;
      const nicknameY = topY + 20;

      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 15px 'Outfit', sans-serif";

      const maxTextWidth = Math.max(10, mW - 20);
      ctx.fillText(m.nickname || `Compasso ${idx + 1}`, nicknameX, nicknameY, maxTextWidth);

      // Tag do compasso (c. X)
      ctx.fillStyle = `${mColor}dd`;
      ctx.font = "bold 10px 'JetBrains Mono', monospace";
      ctx.fillText(`c. ${idx + 1}`, nicknameX, nicknameY - 13);

      // 4. Métrica e Andamento Secundários
      const badgeY = bottomY - 14;
      ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
      ctx.font = "600 11px 'JetBrains Mono', monospace";
      ctx.fillText(`${m.beats}/${m.beatUnit}`, nicknameX, badgeY);

      let tempoText = "";
      if (m.tempoMode === "ratio") {
        if (m.ratioNum === 1 && m.ratioDen === 1) {
          tempoText = `${Math.round(t.effectiveBpm)} BPM`;
        } else {
          tempoText = `${Math.round(t.effectiveBpm)} BPM (${m.ratioNum}/${m.ratioDen})`;
        }
      } else {
        tempoText = `${Math.round(t.effectiveBpm)} BPM (Fixo)`;
      }

      ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
      ctx.font = "500 10px 'JetBrains Mono', monospace";
      ctx.fillText(`• ${tempoText}`, nicknameX + 36, badgeY);
    }

    // 5. Partículas de impacto
    for (let p = 0; p < this.hitParticles.length; p++) {
      const part = this.hitParticles[p];
      ctx.beginPath();
      ctx.arc(part.x, part.y, part.radius, 0, Math.PI * 2);
      ctx.fillStyle = part.color;
      ctx.globalAlpha = Math.max(0, part.alpha);
      ctx.fill();
    }
    ctx.globalAlpha = 1.0;

    // 6. AGULHA CENTRAL DO DJ RUNNER (PLAYHEAD PRO DJ)
    // Glow vermelho suave
    const glowGradient = ctx.createLinearGradient(playheadX - 10, 0, playheadX + 10, 0);
    glowGradient.addColorStop(0, "rgba(255, 42, 77, 0)");
    glowGradient.addColorStop(0.5, "rgba(255, 42, 77, 0.35)");
    glowGradient.addColorStop(1, "rgba(255, 42, 77, 0)");
    ctx.fillStyle = glowGradient;
    ctx.fillRect(playheadX - 10, 0, 20, h);

    // Linha vermelha
    ctx.strokeStyle = "#ff2a4d";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, h);
    ctx.stroke();

    // Núcleo branco
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, h);
    ctx.stroke();

    // Triângulos de mira no topo e base
    this.drawCueMarker(ctx, playheadX, 8, true);
    this.drawCueMarker(ctx, playheadX, h - 8, false);

    ctx.restore();
  }

  drawCueMarker(ctx, x, y, pointingDown) {
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    if (pointingDown) {
      ctx.moveTo(x - 6, y - 7);
      ctx.lineTo(x + 6, y - 7);
      ctx.lineTo(x, y + 2);
    } else {
      ctx.moveTo(x - 6, y + 7);
      ctx.lineTo(x + 6, y + 7);
      ctx.lineTo(x, y - 2);
    }
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = "#ff2a4d";
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  // Otimização: Renderiza ondas percussivas em tempo linear sem chamadas caras a Math.exp()
  drawFastPercussionWaveform(ctx, x, y, w, h, timing, color) {
    const centerY = y + h * 0.58;
    const maxAmplitude = h * 0.22;
    const beats = timing.beats;
    const beatW = w / beats;

    ctx.fillStyle = `${color}25`;
    ctx.strokeStyle = `${color}70`;
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(x, centerY);

    // Desenha perfil superior de ataque e decaimento para cada beat
    for (let b = 0; b < beats; b++) {
      const bx = x + b * beatW;
      const isAccent = (b === 0);
      const amp = maxAmplitude * (isAccent ? 1.0 : 0.65);

      const attackX = bx + Math.min(6, beatW * 0.08);
      const decayX = bx + Math.min(24, beatW * 0.45);
      const endX = bx + beatW;

      ctx.lineTo(attackX, centerY - amp);
      ctx.lineTo(decayX, centerY - (amp * 0.25));
      ctx.lineTo(endX, centerY - 2);
    }

    // Desenha perfil inferior espelhado
    for (let b = beats - 1; b >= 0; b--) {
      const bx = x + b * beatW;
      const isAccent = (b === 0);
      const amp = maxAmplitude * (isAccent ? 0.8 : 0.5);

      const endX = bx + beatW;
      const decayX = bx + Math.min(24, beatW * 0.45);
      const attackX = bx + Math.min(6, beatW * 0.08);

      ctx.lineTo(endX, centerY + 2);
      ctx.lineTo(decayX, centerY + (amp * 0.25));
      ctx.lineTo(attackX, centerY + amp);
    }

    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  renderMinimap(currentTime) {
    const ctx = this.minimapCtx;
    const w = this.minimapWidth;
    const h = this.minimapHeight;
    if (w <= 0 || h <= 0) return;

    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    ctx.fillStyle = "#111419";
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

      ctx.fillStyle = `${m.color || "#ff334b"}44`;
      ctx.fillRect(x, 0, blockW, h);

      ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
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
      ctx.fillRect(gx1, 0, gx2 - gx1, 3);
    }

    const curX = Math.max(0, Math.min(w, (currentTime / totalDuration) * w));
    ctx.fillStyle = "#ff2a4d";
    ctx.fillRect(curX - 1.5, 0, 3, h);

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(curX - 0.5, 0, 1, h);

    ctx.restore();
  }
}
