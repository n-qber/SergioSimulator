# 🥁 Sérgio Simulator

> **Simulador Rítmico de Modulação Métrica com Visão Corrida estilo DJ para Estudo de Peças de Percussão**

O **Sérgio Simulator** foi desenvolvido para auxílio no estudo de peças de percussão contemporânea e erudita que integram métricas variáveis (ex: 4/4, 7/8, 5/8, 9/8) e modulações métricas matemáticas baseadas em proporções (ex: 3/2, 4/3, 5/4, etc.).

---

## 🚀 Principais Funcionalidades

1. **Visão Corrida Estilo DJ (Centralizada na Tela)**:
   - Timeline contínua a 60 FPS com agulha centralizada em vermelho e branco (estilo Serato / Rekordbox).
   - Exibe a progressão de cada compasso, pulsos, ondas rítmicas e marcadores de tempo em tempo real.
   - Minimapa interativo para navegação e salto imediato para qualquer ponto da peça.

2. **Apelido do Compasso como Elemento Principal**:
   - Conforme solicitado, o **nome/apelido do compasso** é o elemento em destaque principal (tamanho maior e destaque visual), enquanto a fórmula de compasso é discreta.

3. **Agrupamento de Compassos Próximos**:
   - Permite agrupar blocos de compassos contíguos com **Nome de Seção** e **Cor Customizada** (ex: *Introdução*, *Desenvolvimento 3/2*, *Solo de Caixa*).
   - O grupo é renderizado com uma faixa delimitadora superior tanto na tela de DJ quanto no minimapa.

4. **Seletor de BPM Base Estável (Sem bugs de digitação)**:
   - Localizado no topo esquerdo.
   - Tratamento anti-bug: validações e commit seguro (apenas em `Enter`, `blur` ou botões de passo `-5`, `-1`, `+1`, `+5`).
   - Botão **TAP Tempo** para encontrar o andamento batendo o ritmo.

5. **Modulações Métricas Matemáticas**:
   - Configuração de cada compasso com proporções matemáticas relativas ao andamento original (ex: `1:1`, `3:2`, `4:3`, `2:3`, `5:4`, `3/4` ou frações personalizadas).
   - Cálculo em tempo real do BPM efetivo.

6. **Painel HUD Digital**:
   - Mostrador em tempo real de **Tempo Atual** e **Tempo Total**.
   - Compasso atual, tempo atual dentro do compasso e andamento efetivo.

7. **Síntese de Percussão em Áudio (Web Audio API)**:
   - Motor de áudio nativo de alta precisão (*Lookahead Scheduler*) sem drift de tempo.
   - Timbres de estudo: Bloco de Madeira (Woodblock), Clave / Rimshot, Click Digital e Bip.

8. **Importação e Exportação**:
   - Salve suas peças no formato `.json` ou importe arquivos existentes.
   - Presets didáticos inclusos (*Elliott Carter*, *Steve Reich / Polirritmias*, *Dança Balcânica 7/8*).

9. **Paleta Vermelho & Branco Pro DJ**:
   - Design moderno sem amarelo primário: tons de vermelho vibrante (`#FF2A4D`, `#DC2626`) e branco puro (`#FFFFFF`) com fundo escuro de alto contraste.

---

## 🛠️ Como Executar com Nix Shell

O projeto inclui um `shell.nix` configurado apenas com **Node.js**:

```bash
# 1. Entre no ambiente isolado do Nix
nix-shell

# 2. Inicie o servidor de desenvolvimento
npm run dev
```

Abra no navegador em: `http://localhost:3000`

---

## 🌐 Como Fazer Deploy na Vercel

O projeto está 100% pronto para a Vercel (`package.json`, `vercel.json` e build Vite configurados):

### Opção 1: Via Vercel CLI
```bash
nix-shell --run "npx vercel"
```

### Opção 2: Via GitHub / GitLab / Bitbucket
1. Envie este repositório para o seu GitHub:
   ```bash
   git remote add origin https://github.com/SEU_USUARIO/SergioSimulator.git
   git branch -M main
   git push -u origin main
   ```
2. Na [Vercel](https://vercel.com), clique em **"Add New Project"** e selecione o repositório.
3. A Vercel detectará automaticamente o **Vite** e executará `npm run build` com pasta de saída `dist`.
4. Clique em **Deploy**!
