/**
 * Presets de peças de estudo de percussão para o Sérgio Simulator.
 * Demonstram modulações métricas (ex: 3/2, 4/3), compassos alternados e agrupamentos.
 */

export const PRESETS = [
  {
    id: "metronomo-padrao-4-4",
    name: "Metrônomo Padrão 4/4 (Sem Modulações)",
    description: "Compassos regulares em 4/4 constantes para treino contínuo, calibração com metrônomo físico ou cronômetro.",
    baseBpm: 120,
    groups: [
      {
        id: "grp-padrao-1",
        name: "Pulso 4/4 Regular",
        color: "#ff334b",
        startMeasure: 0,
        endMeasure: 3
      }
    ],
    measures: [
      { id: "p-1", nickname: "Compasso 1", beats: 4, beatUnit: 4, tempoMode: "ratio", ratioNum: 1, ratioDen: 1, customBpm: 120, color: "#ff334b", repeat: 8 },
      { id: "p-2", nickname: "Compasso 2", beats: 4, beatUnit: 4, tempoMode: "ratio", ratioNum: 1, ratioDen: 1, customBpm: 120, color: "#ff334b", repeat: 8 },
      { id: "p-3", nickname: "Compasso 3", beats: 4, beatUnit: 4, tempoMode: "ratio", ratioNum: 1, ratioDen: 1, customBpm: 120, color: "#ff334b", repeat: 8 },
      { id: "p-4", nickname: "Compasso 4", beats: 4, beatUnit: 4, tempoMode: "ratio", ratioNum: 1, ratioDen: 1, customBpm: 120, color: "#ff334b", repeat: 8 }
    ]
  },
  {
    id: "sergio-master-study",
    name: "Estudo de Modulações Rítmicas (3/2 & 4/3)",
    description: "Peça didática de percussão explorando transições métricas clássicas e compassos mistos.",
    baseBpm: 120,
    groups: [
      {
        id: "grp-1",
        name: "Introdução & Pulso Base",
        color: "#ff334b",
        startMeasure: 0,
        endMeasure: 3
      },
      {
        id: "grp-2",
        name: "Modulação 3/2 (Sesquialtera)",
        color: "#3b82f6",
        startMeasure: 4,
        endMeasure: 7
      },
      {
        id: "grp-3",
        name: "Métrica Mista (7/8 & 5/8)",
        color: "#10b981",
        startMeasure: 8,
        endMeasure: 11
      },
      {
        id: "grp-4",
        name: "Coda Triunfal (4/3)",
        color: "#ec4899",
        startMeasure: 12,
        endMeasure: 15
      }
    ],
    measures: [
      // Grp 1: Base 120 bpm (4/4)
      { id: "m-1", nickname: "Chamada de Caixa", beats: 4, beatUnit: 4, tempoMode: "ratio", ratioNum: 1, ratioDen: 1, customBpm: 120, color: "#ff334b" },
      { id: "m-2", nickname: "Ostinato Inicial", beats: 4, beatUnit: 4, tempoMode: "ratio", ratioNum: 1, ratioDen: 1, customBpm: 120, color: "#ff334b" },
      { id: "m-3", nickname: "Variação Dinâmica", beats: 4, beatUnit: 4, tempoMode: "ratio", ratioNum: 1, ratioDen: 1, customBpm: 120, color: "#ff334b" },
      { id: "m-4", nickname: "Preparação p/ 3/2", beats: 3, beatUnit: 4, tempoMode: "ratio", ratioNum: 1, ratioDen: 1, customBpm: 120, color: "#ff334b" },

      // Grp 2: Modulação 3/2 (1.5x = 180 bpm)
      { id: "m-5", nickname: "Aceleração 3/2", beats: 4, beatUnit: 4, tempoMode: "ratio", ratioNum: 3, ratioDen: 2, customBpm: 180, color: "#3b82f6" },
      { id: "m-6", nickname: "Rolo Sincopado", beats: 4, beatUnit: 4, tempoMode: "ratio", ratioNum: 3, ratioDen: 2, customBpm: 180, color: "#3b82f6" },
      { id: "m-7", nickname: "Acentos Cruzados", beats: 6, beatUnit: 8, tempoMode: "ratio", ratioNum: 3, ratioDen: 2, customBpm: 180, color: "#3b82f6" },
      { id: "m-8", nickname: "Frenesi em 3/2", beats: 4, beatUnit: 4, tempoMode: "ratio", ratioNum: 3, ratioDen: 2, customBpm: 180, color: "#3b82f6" },

      // Grp 3: Métrica Mista (7/8 e 5/8)
      { id: "m-9", nickname: "Compasso 7/8 (3+2+2)", beats: 7, beatUnit: 8, tempoMode: "ratio", ratioNum: 1, ratioDen: 1, customBpm: 120, color: "#10b981" },
      { id: "m-10", nickname: "Resposta 7/8", beats: 7, beatUnit: 8, tempoMode: "ratio", ratioNum: 1, ratioDen: 1, customBpm: 120, color: "#10b981" },
      { id: "m-11", nickname: "Transição 5/8 (3+2)", beats: 5, beatUnit: 8, tempoMode: "ratio", ratioNum: 1, ratioDen: 1, customBpm: 120, color: "#10b981" },
      { id: "m-12", nickname: "Pausa & Climax 5/8", beats: 5, beatUnit: 8, tempoMode: "ratio", ratioNum: 1, ratioDen: 1, customBpm: 120, color: "#10b981" },

      // Grp 4: Coda 4/3 (1.33x = 160 bpm)
      { id: "m-13", nickname: "Entrada da Coda (4/3)", beats: 4, beatUnit: 4, tempoMode: "ratio", ratioNum: 4, ratioDen: 3, customBpm: 160, color: "#ec4899" },
      { id: "m-14", nickname: "Galope Rítmico", beats: 4, beatUnit: 4, tempoMode: "ratio", ratioNum: 4, ratioDen: 3, customBpm: 160, color: "#ec4899" },
      { id: "m-15", nickname: "Redemoinho", beats: 5, beatUnit: 4, tempoMode: "ratio", ratioNum: 4, ratioDen: 3, customBpm: 160, color: "#ec4899" },
      { id: "m-16", nickname: "Golpe Final Uníssono", beats: 4, beatUnit: 4, tempoMode: "ratio", ratioNum: 1, ratioDen: 1, customBpm: 120, color: "#ff334b" }
    ]
  },
  {
    id: "dança-percussao-7-8",
    name: "Dança Balcânica em 7/8 e 9/8",
    description: "Estudo de assimétricas e acentuações irregulares típicas de percussão orquestral e folclórica.",
    baseBpm: 140,
    groups: [
      {
        id: "grp-balk-1",
        name: "Ciclo 7/8",
        color: "#ff334b",
        startMeasure: 0,
        endMeasure: 3
      },
      {
        id: "grp-balk-2",
        name: "Expansão 9/8",
        color: "#8b5cf6",
        startMeasure: 4,
        endMeasure: 7
      }
    ],
    measures: [
      { id: "b-1", nickname: "Batida Básica 7/8", beats: 7, beatUnit: 8, tempoMode: "ratio", ratioNum: 1, ratioDen: 1, customBpm: 140, color: "#ff334b" },
      { id: "b-2", nickname: "Acento no 4º tempo", beats: 7, beatUnit: 8, tempoMode: "ratio", ratioNum: 1, ratioDen: 1, customBpm: 140, color: "#ff334b" },
      { id: "b-3", nickname: "Contra-ritmo 7/8", beats: 7, beatUnit: 8, tempoMode: "ratio", ratioNum: 1, ratioDen: 1, customBpm: 140, color: "#ff334b" },
      { id: "b-4", nickname: "Preparação de Giro", beats: 7, beatUnit: 8, tempoMode: "ratio", ratioNum: 1, ratioDen: 1, customBpm: 140, color: "#ff334b" },
      { id: "b-5", nickname: "Salto para 9/8", beats: 9, beatUnit: 8, tempoMode: "ratio", ratioNum: 1, ratioDen: 1, customBpm: 140, color: "#8b5cf6" },
      { id: "b-6", nickname: "Galope 9/8 (2+2+2+3)", beats: 9, beatUnit: 8, tempoMode: "ratio", ratioNum: 1, ratioDen: 1, customBpm: 140, color: "#8b5cf6" },
      { id: "b-7", nickname: "Interrogação", beats: 5, beatUnit: 8, tempoMode: "ratio", ratioNum: 1, ratioDen: 1, customBpm: 140, color: "#8b5cf6" },
      { id: "b-8", nickname: "Final em Tutti", beats: 7, beatUnit: 8, tempoMode: "ratio", ratioNum: 1, ratioDen: 1, customBpm: 140, color: "#ff334b" }
    ]
  },
  {
    id: "elliott-carter-pulse",
    name: "Estudo Carter - Modulação Métrica Estrita",
    description: "Modulação métrica onde a colcheia pontuada passa a ser a nova semínima (relação 4:3 e 3:2).",
    baseBpm: 96,
    groups: [
      {
        id: "grp-carter-1",
        name: "Andamento Lento Original",
        color: "#64748b",
        startMeasure: 0,
        endMeasure: 2
      },
      {
        id: "grp-carter-2",
        name: "Modulação 5/4 (Aceleração Racional)",
        color: "#ff334b",
        startMeasure: 3,
        endMeasure: 5
      }
    ],
    measures: [
      { id: "c-1", nickname: "Pulso Solene", beats: 4, beatUnit: 4, tempoMode: "ratio", ratioNum: 1, ratioDen: 1, customBpm: 96, color: "#64748b" },
      { id: "c-2", nickname: "Quintuplet Oculto", beats: 4, beatUnit: 4, tempoMode: "ratio", ratioNum: 1, ratioDen: 1, customBpm: 96, color: "#64748b" },
      { id: "c-3", nickname: "Ponto de Pivô", beats: 3, beatUnit: 4, tempoMode: "ratio", ratioNum: 1, ratioDen: 1, customBpm: 96, color: "#64748b" },
      { id: "c-4", nickname: "Nova Pulsação (5/4)", beats: 4, beatUnit: 4, tempoMode: "ratio", ratioNum: 5, ratioDen: 4, customBpm: 120, color: "#ff334b" },
      { id: "c-5", nickname: "Estabilidade Rápida", beats: 4, beatUnit: 4, tempoMode: "ratio", ratioNum: 5, ratioDen: 4, customBpm: 120, color: "#ff334b" },
      { id: "c-6", nickname: "Resolução", beats: 2, beatUnit: 4, tempoMode: "ratio", ratioNum: 5, ratioDen: 4, customBpm: 120, color: "#ff334b" }
    ]
  }
];
