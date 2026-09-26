/**
 * Renderizador de Visão Corrida estilo DJ (Canvas 60 FPS) para o Sérgio Simulator
 * Exibe timeline com agulha centralizada, compassos, apelidos em destaque, grupos,
 * pulsos rítmicos e minimapa de navegação instantânea.
 */

export class DJRunnerRenderer {
  constructor(canvas, minimapCanvas, state, onSeek) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.minimapCanvas = minimapCanvas;
    this.minimapCtx = minimapCanvas.getContext('2d');
    this.state = state;
    this.onSeek = onSeek;

    // Configurações visuais (pixels por segundo)
    this.pixelsPerSecond = 220; // Zoom horizontal do DJ runner
    this.playheadRatio = 0.5; // Agulha no centro exato da tela (estilo DJ Serato/Rekordbox)

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
    this.dpr = window.devicePixelRatio || 1;

    // Partículas de impacto na agulha
    this.hitParticles = [];

    this.initEvents();
    this.resize();
  }

  resize() {
    this.dpr = window.devicePixelRatio || 1;

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

    // Zoom com roda do mouse (Shift ou Ctrl)
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
    // Cria fagulhas/pulso visual vermelho e branco na agulha
    const count = isAccent ? 12 : 6;
    for (let i = 0; i < count; i++) {
      this.hitParticles.push({
        x: this.width * this.playheadRatio + (Math.random() * 8 - 4),
        y: this.height * 0.5 + (Math.random() * 40 - 20),
        vx: (Math.random() - 0.5) * 120,
        vy: (Math.random() - 0.5) * 80,
        color: isAccent ? "#ffffff" : "#ff334b",
        radius: isAccent ? Math.random() * 3 + 2 : Math.random() * 2 + 1,
        alpha: 1.0,
        decay: Math.random() * 3 + 2.5
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

    // Fundo escuro com sutil gradiente radial
    ctx.fillStyle = "#0c0e12";
    ctx.fillRect(0, 0, w, h);

    // Linha central horizontal sutil (estilo track de DJ)
    ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h * 0.5);
    ctx.lineTo(w, h * 0.5);
    ctx.stroke();

    // Posição x da agulha na tela
    const playheadX = w * this.playheadRatio;

    // Calcular limites visíveis em tempo
    const visibleTimeStart = currentTime - (playheadX / this.pixelsPerSecond);
    const visibleTimeEnd = currentTime + ((w - playheadX) / this.pixelsPerSecond);

    const timings = this.state.measureTimings;
    if (!timings || timings.length === 0) {
      ctx.restore();
      return;
    }

    // 1. Renderiza blocos de GRUPO no topo do DJ runner
    const groups = this.state.groups || [];
    groups.forEach(grp => {
      const startTiming = timings[grp.startMeasure];
      const endTiming = timings[grp.endMeasure];
      if (!startTiming || !endTiming) return;

      const grpStartTime = startTiming.startTime;
      const grpEndTime = endTiming.endTime;

      if (grpEndTime < visibleTimeStart || grpStartTime > visibleTimeEnd) return;

      const grpX1 = playheadX + (grpStartTime - currentTime) * this.pixelsPerSecond;
      const grpX2 = playheadX + (grpEndTime - currentTime) * this.pixelsPerSecond;
      const grpW = grpX2 - grpX1;

      // Barra do grupo no topo
      const bannerHeight = 26;
      ctx.fillStyle = `${grp.color}22`;
      ctx.fillRect(grpX1, 4, grpW, bannerHeight);

      // Borda superior colorida
      ctx.fillStyle = grp.color;
      ctx.fillRect(grpX1, 4, grpW, 3);

      // Linhas delimitadoras do grupo
      ctx.strokeStyle = `${grp.color}88`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(grpX1, 4);
      ctx.lineTo(grpX1, 4 + bannerHeight + 6);
      ctx.moveTo(grpX2, 4);
      ctx.lineTo(grpX2, 4 + bannerHeight + 6);
      ctx.stroke();

      // Nome do grupo
      ctx.fillStyle = "#ffffff";
      ctx.font = "600 11px 'Outfit', sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";

      const titleText = grp.name.toUpperCase();
      const textX = Math.max(grpX1 + 10, 16);
      // Só desenha se estiver visível
      if (textX < grpX2 - 20) {
        ctx.fillText(`⯈ ${titleText}`, textX, 4 + bannerHeight / 2);
      }
    });

    // 2. Renderiza COMPASSOS visíveis
    timings.forEach((t, idx) => {
      if (t.endTime < visibleTimeStart || t.startTime > visibleTimeEnd) return;

      const m = this.state.measures[idx];
      const mX = playheadX + (t.startTime - currentTime) * this.pixelsPerSecond;
      const mW = t.duration * this.pixelsPerSecond;

      const topY = 36;
      const bottomY = h - 16;
      const blockH = bottomY - topY;

      // Fundo suave do compasso com cor customizada
      const mColor = m.color || "#ff334b";
      ctx.fillStyle = `${mColor}0e`;
      ctx.fillRect(mX, topY, mW, blockH);

      // Barra delimitadora esquerda do compasso (Grossa e nítida)
      ctx.fillStyle = mColor;
      ctx.fillRect(mX, topY, 2.5, blockH);

      // Borda sutil inferior e superior
      ctx.strokeStyle = "rgba(255, 255, 255, 0.07)";
      ctx.lineWidth = 1;
      ctx.strokeRect(mX, topY, mW, blockH);

      // Onda gráfica estilizada de percussão (Traktor/Serato visual beatwave)
      this.drawMeasureWaveform(ctx, mX, topY, mW, blockH, t, mColor);

      // Renderiza os TEMPOS / BEATS internos do compasso
      for (let b = 0; b < t.beats; b++) {
        const beatTime = t.startTime + b * t.beatDuration;
        const beatX = playheadX + (beatTime - currentTime) * this.pixelsPerSecond;

        if (b > 0) {
          // Linha divisória de beat
          ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(beatX, topY + 38);
          ctx.lineTo(beatX, bottomY - 32);
          ctx.stroke();
        }

        // Ponto / Marcador de pulso do beat
        const isFirstBeat = (b === 0);
        const beatDotY = topY + 44;

        ctx.beginPath();
        ctx.arc(beatX + (isFirstBeat ? 4 : 0), beatDotY, isFirstBeat ? 3.5 : 2, 0, Math.PI * 2);
        ctx.fillStyle = isFirstBeat ? "#ffffff" : "rgba(255, 255, 255, 0.4)";
        ctx.fill();

        // Número do tempo discreto
        ctx.fillStyle = isFirstBeat ? "#ffffff" : "rgba(255, 255, 255, 0.35)";
        ctx.font = "600 10px 'JetBrains Mono', monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`${b + 1}`, beatX + (isFirstBeat ? 4 : 0), beatDotY + 14);
      }

      // 3. APELIDO DO COMPASSO (EM DESTAQUE - HERO TITLE conforme pedido!)
      const nicknameX = mX + 14;
      const nicknameY = topY + 22;

      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 15px 'Outfit', sans-serif";

      // Trunca se não couber no bloco
      const maxTextWidth = mW - 24;
      let displayName = m.nickname || `Compasso ${idx + 1}`;
      ctx.fillText(displayName, nicknameX, nicknameY, Math.max(10, maxTextWidth));

      // Número do compasso (Tag c. X)
      ctx.fillStyle = `${mColor}ee`;
      ctx.font = "bold 10px 'JetBrains Mono', monospace";
      ctx.fillText(`c. ${idx + 1}`, nicknameX, nicknameY - 14);

      // 4. MODO / MÉTRICA E MODULAÇÃO MATEMÁTICA (Secundário e elegante)
      const badgeY = bottomY - 16;

      // Badge de Fórmula de Compasso (ex: 7/8, 4/4)
      const meterText = `${m.beats}/${m.beatUnit}`;
      ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
      ctx.font = "600 11px 'JetBrains Mono', monospace";
      ctx.fillText(meterText, nicknameX, badgeY);

      // Badge de Modulação Matemática / Andamento (ex: 3/2 -> 180 BPM)
      let tempoText = "";
      if (m.tempoMode === "ratio") {
        if (m.ratioNum === 1 && m.ratioDen === 1) {
          tempoText = `${Math.round(t.effectiveBpm)} BPM (Base)`;
        } else {
          tempoText = `${Math.round(t.effectiveBpm)} BPM (${m.ratioNum}/${m.ratioDen})`;
        }
      } else {
        tempoText = `${Math.round(t.effectiveBpm)} BPM (Fixo)`;
      }

      ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
      ctx.font = "500 10px 'JetBrains Mono', monospace";
      ctx.fillText(`• ${tempoText}`, nicknameX + 38, badgeY);
    });

    // 5. Partículas de impacto
    this.hitParticles.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = Math.max(0, p.alpha);
      ctx.fill();
    });
    ctx.globalAlpha = 1.0;

    // 6. AGULHA CENTRAL DO DJ RUNNER (PLAYHEAD - Vermelho & Branco Pro DJ)
    // Feixe de luz vertical vermelho
    const glowGradient = ctx.createLinearGradient(playheadX - 12, 0, playheadX + 12, 0);
    glowGradient.addColorStop(0, "rgba(255, 42, 77, 0)");
    glowGradient.addColorStop(0.5, "rgba(255, 42, 77, 0.35)");
    glowGradient.addColorStop(1, "rgba(255, 42, 77, 0)");
    ctx.fillStyle = glowGradient;
    ctx.fillRect(playheadX - 12, 0, 24, h);

    // Linha vermelha principal
    ctx.strokeStyle = "#ff2a4d";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, h);
    ctx.stroke();

    // Núcleo branco no centro da linha para contraste extremo
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, h);
    ctx.stroke();

    // Triângulos de mira no topo e na base (Estilo Pioneer DJ / Rekordbox)
    this.drawCueMarker(ctx, playheadX, 10, true);
    this.drawCueMarker(ctx, playheadX, h - 10, false);

    ctx.restore();
  }

  drawCueMarker(ctx, x, y, pointingDown) {
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    if (pointingDown) {
      ctx.moveTo(x - 7, y - 8);
      ctx.lineTo(x + 7, y - 8);
      ctx.lineTo(x, y + 2);
    } else {
      ctx.moveTo(x - 7, y + 8);
      ctx.lineTo(x + 7, y + 8);
      ctx.lineTo(x, y - 2);
    }
    ctx.closePath();
    ctx.fill();

    // Borda vermelha
    ctx.strokeStyle = "#ff2a4d";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Gera gráfico ondulatório visual de percussão simulando picos rítmicos
  drawMeasureWaveform(ctx, x, y, w, h, timing, color) {
    const centerY = y + h * 0.58;
    const maxAmplitude = h * 0.22;

    ctx.fillStyle = `${color}28`;
    ctx.strokeStyle = `${color}77`;
    ctx.lineWidth = 1;

    const beats = timing.beats;
    const samples = Math.max(16, Math.floor(w / 4));
    
    ctx.beginPath();
    ctx.moveTo(x, centerY);

    for (let i = 0; i <= samples; i++) {
      const progress = i / samples;
      const curBeat = progress * beats;
      const beatFraction = curBeat % 1.0;
      
      // Decaimento exponencial rápido simulando ataque de tambor/caixa
      const attack = Math.exp(-beatFraction * 4.5);
      const isFirst = Math.floor(curBeat) === 0;
      const amp = maxAmplitude * attack * (isFirst ? 1.0 : 0.65);

      const px = x + progress * w;
      const py = centerY - amp;
      ctx.lineTo(px, py);
    }

    for (let i = samples; i >= 0; i--) {
      const progress = i / samples;
      const curBeat = progress * beats;
      const beatFraction = curBeat % 1.0;
      const attack = Math.exp(-beatFraction * 4.5);
      const isFirst = Math.floor(curBeat) === 0;
      const amp = maxAmplitude * attack * (isFirst ? 0.8 : 0.5);

      const px = x + progress * w;
      const py = centerY + amp;
      ctx.lineTo(px, py);
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

    // Fundo
    ctx.fillStyle = "#111419";
    ctx.fillRect(0, 0, w, h);

    const totalDuration = this.state.totalDuration || 1;
    const timings = this.state.measureTimings;
    if (!timings || timings.length === 0) {
      ctx.restore();
      return;
    }

    // Desenha blocos dos compassos no minimapa
    timings.forEach((t, idx) => {
      const x = (t.startTime / totalDuration) * w;
      const blockW = Math.max(1.5, (t.duration / totalDuration) * w);
      const m = this.state.measures[idx];

      // Cor do compasso
      ctx.fillStyle = `${m.color || "#ff334b"}44`;
      ctx.fillRect(x, 0, blockW, h);

      // Divisor
      ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x, 0, blockW, h);
    });

    // Grupos no minimapa (barra colorida no topo de 3px)
    const groups = this.state.groups || [];
    groups.forEach(grp => {
      const st = timings[grp.startMeasure];
      const et = timings[grp.endMeasure];
      if (!st || !et) return;

      const gx1 = (st.startTime / totalDuration) * w;
      const gx2 = (et.endTime / totalDuration) * w;
      ctx.fillStyle = grp.color;
      ctx.fillRect(gx1, 0, gx2 - gx1, 3);
    });

    // Cursor de tempo atual no minimapa (Linha branca e vermelha)
    const curX = Math.max(0, Math.min(w, (currentTime / totalDuration) * w));
    ctx.fillStyle = "#ff2a4d";
    ctx.fillRect(curX - 1.5, 0, 3, h);

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(curX - 0.5, 0, 1, h);

    ctx.restore();
  }
}
