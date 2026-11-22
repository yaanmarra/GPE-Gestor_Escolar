// src/services/frequenciaService.js
// Motor único de cálculo de frequência escolar (LDB), alertas de busca ativa,
// condicionalidades de programas sociais (Bolsa Família / Pé-de-Meia) e
// Score de Risco Explicável ABC (Attendance, Behavior, Course performance).

const LIMITES_LEGAIS = Object.freeze({
  MINIMO_LDB_PCT: 75,
  MAXIMO_FALTAS_LDB_RATIO: 0.25,
  // Lei 13.803/2019 (LDB art. 12, VIII): notificar Conselho Tutelar quando as faltas
  // ultrapassarem 30% do percentual permitido pela legislação (30% de 25% = 7,5% da carga).
  GATILHO_CONSELHO_SOBRE_LIMITE_RATIO: 0.30,
  MINIMO_BOLSA_FAMILIA_PCT: 75,
  MINIMO_PE_DE_MEIA_PCT: 80,
  GATILHO_FALTAS_CONSECUTIVAS_DIAS: 3,
  AULAS_PREVISTAS_PADRAO: 200,
});

function normalizarDataISO(data) {
  if (!data) return '';
  if (data instanceof Date) {
    const y = data.getFullYear();
    const m = String(data.getMonth() + 1).padStart(2, '0');
    const d = String(data.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(data);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return match ? match[1] : s;
}

/**
 * Calcula quantos dias letivos consecutivos de falta injustificada o aluno acumula
 * no momento (final da série histórica) e o pico histórico no período.
 * Consolida múltiplos tempos de aula do mesmo dia: se o aluno teve pelo menos
 * uma presença ou justificativa no dia, não conta como dia de ausência injustificada pura.
 */
function calcularFaltasConsecutivas(registros = []) {
  if (!Array.isArray(registros) || registros.length === 0) {
    return {
      diasConsecutivosAtuais: 0,
      maxDiasConsecutivos: 0,
      ultimaDataFalta: null,
    };
  }

  // Agrupa por data (YYYY-MM-DD)
  const porDia = new Map();
  for (const r of registros) {
    const dia = normalizarDataISO(r.data);
    if (!dia) continue;
    if (!porDia.has(dia)) {
      porDia.set(dia, { presentes: 0, faltas: 0, justificadas: 0 });
    }
    const g = porDia.get(dia);
    if (r.status === 'presente') g.presentes++;
    else if (r.status === 'justificado') g.justificadas++;
    else if (r.status === 'falta') g.faltas++;
  }

  const diasOrdenados = [...porDia.keys()].sort();
  let atual = 0;
  let maximo = 0;
  let ultimaDataFalta = null;

  for (const dia of diasOrdenados) {
    const g = porDia.get(dia);
    const faltaInjustificadaNoDia = g.faltas > 0 && g.presentes === 0 && g.justificadas === 0;
    if (faltaInjustificadaNoDia) {
      atual++;
      ultimaDataFalta = dia;
      if (atual > maximo) maximo = atual;
    } else if (g.presentes > 0 || g.justificadas > 0) {
      atual = 0;
    }
  }

  return {
    diasConsecutivosAtuais: atual,
    maxDiasConsecutivos: maximo,
    ultimaDataFalta,
  };
}

/**
 * Calcula métricas consolidadas de frequência de um aluno a partir da lista de chamadas
 * (ou de contagens agregadas `{ presencas, faltas, justificadas, abonadas }`).
 *
 * Nuance legal implementada:
 *  - Para os 75% da LDB (art. 24, VI), falta comum justificada (`justificado` sem abono legal)
 *    continua contando como ausência na carga horária realizada, mas NÃO conta como abandono
 *    para Busca Ativa / Conselho Tutelar.
 *  - Faltas com `abonada = 1` (ex.: regime domiciliar Decreto-Lei 1.044/69) contam como presença efetiva.
 */
function calcularMetricasFrequencia(entrada = [], opcoes = {}) {
  const aulasPrevistasAno = Math.max(
    1,
    Number(opcoes.aulasPrevistasAno) || LIMITES_LEGAIS.AULAS_PREVISTAS_PADRAO
  );
  const ensinoMedio = Boolean(opcoes.ensinoMedio);

  let presencas = 0;
  let faltasInjustificadas = 0;
  let faltasJustificadas = 0;
  let faltasAbonadas = 0;
  let registrosLista = [];

  if (Array.isArray(entrada)) {
    registrosLista = entrada;
    for (const r of entrada) {
      if (r.status === 'presente') {
        presencas++;
      } else if (r.status === 'justificado') {
        if (r.abonada) faltasAbonadas++;
        else faltasJustificadas++;
      } else if (r.status === 'falta') {
        faltasInjustificadas++;
      }
    }
  } else if (entrada && typeof entrada === 'object') {
    presencas = Number(entrada.presencas) || 0;
    faltasInjustificadas = Number(entrada.faltas ?? entrada.faltasInjustificadas) || 0;
    faltasJustificadas = Number(entrada.justificadas ?? entrada.faltasJustificadas) || 0;
    faltasAbonadas = Number(entrada.abonadas ?? entrada.faltasAbonadas) || 0;
    if (Array.isArray(entrada.registros)) registrosLista = entrada.registros;
  }

  const totalAulasRegistradas = presencas + faltasInjustificadas + faltasJustificadas + faltasAbonadas;
  const presencasEfetivasLDB = presencas + faltasAbonadas;
  const faltasComputaveisLDB = faltasInjustificadas + faltasJustificadas;

  const percentualLDB = totalAulasRegistradas > 0
    ? Number(((presencasEfetivasLDB / totalAulasRegistradas) * 100).toFixed(1))
    : 100;
  const percentualInteiro = totalAulasRegistradas > 0
    ? Math.round((presencasEfetivasLDB / totalAulasRegistradas) * 100)
    : 100;

  // Percentual considerando apenas faltas sem justificativa como perda
  const percentualSemInjustificadas = totalAulasRegistradas > 0
    ? Number((((presencasEfetivasLDB + faltasJustificadas) / totalAulasRegistradas) * 100).toFixed(1))
    : 100;

  // Orçamento anual de faltas (25% das aulas previstas)
  const cargaReferencia = Math.max(aulasPrevistasAno, totalAulasRegistradas);
  const limiteFaltasAno = Math.floor(cargaReferencia * LIMITES_LEGAIS.MAXIMO_FALTAS_LDB_RATIO);
  const faltasRestantesLDB = Math.max(0, limiteFaltasAno - faltasComputaveisLDB);

  // Gatilho do Conselho Tutelar (LDB art. 12, VIII): > 30% do limite permitido de faltas
  const limiteGatilhoConselho = Math.max(1, Math.ceil(limiteFaltasAno * LIMITES_LEGAIS.GATILHO_CONSELHO_SOBRE_LIMITE_RATIO));
  const atingiuGatilhoConselho =
    faltasInjustificadas > limiteGatilhoConselho ||
    (totalAulasRegistradas >= 8 && percentualLDB < LIMITES_LEGAIS.MINIMO_LDB_PCT && faltasInjustificadas >= 3);

  // Quantas aulas seguidas presentes o aluno precisa a partir de hoje para atingir >= 75% nas aulas dadas
  // (presencasEfetivas + X) / (total + X) >= 0.75  =>  X >= 3 * faltasComputaveis - presencasEfetivas
  const aulasParaRecuperarLDB = Math.max(0, 3 * faltasComputaveisLDB - presencasEfetivasLDB);

  const consecutivas = calcularFaltasConsecutivas(registrosLista);

  const programas = {
    ldb: {
      regular: percentualLDB >= LIMITES_LEGAIS.MINIMO_LDB_PCT,
      minimoPct: LIMITES_LEGAIS.MINIMO_LDB_PCT,
      atualPct: percentualLDB,
      limiteFaltasAno,
      faltasRestantes: faltasRestantesLDB,
      aulasParaRecuperar: aulasParaRecuperarLDB,
    },
    bolsaFamilia: {
      regular: percentualLDB >= LIMITES_LEGAIS.MINIMO_BOLSA_FAMILIA_PCT,
      emAlerta: percentualLDB >= LIMITES_LEGAIS.MINIMO_BOLSA_FAMILIA_PCT && percentualLDB < 80,
      minimoPct: LIMITES_LEGAIS.MINIMO_BOLSA_FAMILIA_PCT,
      atualPct: percentualLDB,
    },
    peDeMeia: {
      aplicavel: ensinoMedio,
      regular: percentualLDB >= LIMITES_LEGAIS.MINIMO_PE_DE_MEIA_PCT,
      emAlerta: percentualLDB >= LIMITES_LEGAIS.MINIMO_PE_DE_MEIA_PCT && percentualLDB < 84,
      minimoPct: LIMITES_LEGAIS.MINIMO_PE_DE_MEIA_PCT,
      atualPct: percentualLDB,
    },
    conselhoTutelar: {
      notificar: atingiuGatilhoConselho,
      faltasInjustificadas,
      limiteGatilhoFaltas: limiteGatilhoConselho,
    },
  };

  return {
    presencas,
    faltas: faltasInjustificadas,
    faltasInjustificadas,
    justificadas: faltasJustificadas,
    faltasJustificadas,
    abonadas: faltasAbonadas,
    faltasComputaveisLDB,
    totalAulasRegistradas,
    aulasPrevistasAno: cargaReferencia,
    percentualLDB,
    percentualInteiro,
    percentualSemInjustificadas,
    limiteFaltasAno,
    faltasRestantesLDB,
    aulasParaRecuperarLDB,
    diasFaltasConsecutivas: consecutivas.diasConsecutivosAtuais,
    maxDiasFaltasConsecutivas: consecutivas.maxDiasConsecutivos,
    ultimaDataFalta: consecutivas.ultimaDataFalta,
    alertaFaltasConsecutivas: consecutivas.diasConsecutivosAtuais >= LIMITES_LEGAIS.GATILHO_FALTAS_CONSECUTIVAS_DIAS,
    programas,
  };
}

/**
 * Calcula o Score de Risco ABC Explicável (0 a 100) combinando:
 *  - A (Attendance / Frequência e faltas consecutivas): até 60 pts
 *  - B (Behavior / Ocorrências disciplinares): até 20 pts
 *  - C (Course performance / Média de avaliações): até 20 pts
 *
 * Retorna `{ score, nivel: 'BAIXO'|'MODERADO'|'ALTO'|'CRITICO', dimensoes, motivos }`.
 */
function calcularRiscoABC({
  metricasFrequencia,
  ocorrencias = [],
  notas = [],
  ensinoMedio = false,
} = {}) {
  const m = metricasFrequencia || calcularMetricasFrequencia([], { ensinoMedio });
  const motivos = [];

  // ── Dimensão A: Assiduidade (0..60) ──
  let pontosA = 0;
  if (m.totalAulasRegistradas > 0) {
    if (m.percentualLDB < 70) {
      pontosA += 45;
      motivos.push(`Frequência crítica em ${m.percentualLDB}% (abaixo do mínimo LDB de 75%)`);
    } else if (m.percentualLDB < LIMITES_LEGAIS.MINIMO_LDB_PCT) {
      pontosA += 35;
      motivos.push(`Frequência em ${m.percentualLDB}% (abaixo do mínimo LDB de 75%)`);
    } else if (m.percentualLDB < LIMITES_LEGAIS.MINIMO_PE_DE_MEIA_PCT) {
      pontosA += 20;
      if (ensinoMedio) {
        motivos.push(`Frequência em ${m.percentualLDB}% (abaixo dos 80% exigidos pelo Pé-de-Meia)`);
      } else {
        motivos.push(`Frequência em zona de atenção (${m.percentualLDB}%, próxima ao limite de 75%)`);
      }
    } else if (m.percentualLDB < 85) {
      pontosA += 10;
    }

    if (m.diasFaltasConsecutivas >= 5) {
      pontosA += 20;
      motivos.push(`${m.diasFaltasConsecutivas} dias letivos consecutivos de falta sem justificativa`);
    } else if (m.diasFaltasConsecutivas >= LIMITES_LEGAIS.GATILHO_FALTAS_CONSECUTIVAS_DIAS) {
      pontosA += 15;
      motivos.push(`${m.diasFaltasConsecutivas} faltas consecutivas recentes (gatilho de Busca Ativa)`);
    } else if (m.diasFaltasConsecutivas === 2) {
      pontosA += 5;
    }

    if (m.programas?.conselhoTutelar?.notificar) {
      pontosA += 10;
      motivos.push(
        `Ultrapassou gatilho do Conselho Tutelar (${m.faltasInjustificadas} faltas injustificadas; limite de alerta: ${m.programas.conselhoTutelar.limiteGatilhoFaltas})`
      );
    }

    // Se todas as ausências são justificadas por atestado, atenua o risco de evasão
    if (m.faltasInjustificadas === 0 && m.faltasJustificadas > 0 && pontosA > 0) {
      pontosA = Math.min(pontosA, 25);
      motivos.push(`Ausências cobertas por justificativa/atestado (${m.faltasJustificadas} justificada(s))`);
    }
  }
  pontosA = Math.min(60, pontosA);

  // ── Dimensão B: Comportamento / Ocorrências (0..20) ──
  let pontosB = 0;
  let totalOcorrenciasNegativas = 0;
  let totalElogios = 0;

  for (const oc of ocorrencias) {
    if (oc.tipo === 'elogio' || oc.gravidade === 'positiva') {
      totalElogios++;
      continue;
    }
    totalOcorrenciasNegativas++;
    if (oc.gravidade === 'grave') pontosB += 12;
    else if (oc.gravidade === 'media' || oc.tipo === 'indisciplina') pontosB += 7;
    else pontosB += 3;
  }
  pontosB = Math.min(20, pontosB);
  if (totalOcorrenciasNegativas > 0) {
    motivos.push(`${totalOcorrenciasNegativas} ocorrência(s) pedagógica(s)/disciplinar(es) registrada(s)`);
  }

  // ── Dimensão C: Desempenho Acadêmico / Notas (0..20) ──
  let pontosC = 0;
  let mediaNotas = null;
  if (Array.isArray(notas) && notas.length > 0) {
    let soma = 0;
    let cont = 0;
    for (const n of notas) {
      const valor = Number(n.nota);
      const max = Number(n.valor_maximo) || 10;
      if (Number.isFinite(valor) && max > 0) {
        soma += (valor / max) * 10;
        cont++;
      }
    }
    if (cont > 0) {
      mediaNotas = Number((soma / cont).toFixed(1));
      if (mediaNotas < 5.0) {
        pontosC = 20;
        motivos.push(`Média acadêmica baixa (${mediaNotas}/10 em ${cont} avaliação(ões))`);
      } else if (mediaNotas < 6.0) {
        pontosC = 12;
        motivos.push(`Média acadêmica em atenção (${mediaNotas}/10)`);
      } else if (mediaNotas < 7.0) {
        pontosC = 5;
      }
    }
  }

  const score = Math.min(100, pontosA + pontosB + pontosC);

  let nivel = 'BAIXO';
  if (
    score >= 60 ||
    m.programas?.conselhoTutelar?.notificar ||
    (m.totalAulasRegistradas >= 5 && m.percentualLDB < 70 && m.faltasInjustificadas >= 3)
  ) {
    nivel = 'CRITICO';
  } else if (
    score >= 40 ||
    (m.totalAulasRegistradas >= 4 && m.percentualLDB < LIMITES_LEGAIS.MINIMO_LDB_PCT) ||
    m.diasFaltasConsecutivas >= LIMITES_LEGAIS.GATILHO_FALTAS_CONSECUTIVAS_DIAS
  ) {
    nivel = 'ALTO';
  } else if (score >= 20 || (m.totalAulasRegistradas >= 4 && m.percentualLDB < 80)) {
    nivel = 'MODERADO';
  }

  if (motivos.length === 0) {
    motivos.push('Frequência e acompanhamento pedagógico regulares');
  }

  return {
    score,
    nivel,
    dimensoes: {
      frequencia: pontosA,
      comportamento: pontosB,
      desempenho: pontosC,
      mediaNotas,
      ocorrenciasNegativas: totalOcorrenciasNegativas,
      elogios: totalElogios,
    },
    motivos,
  };
}

/** Detecta se o nome da turma corresponde ao Ensino Médio (para regra do Pé-de-Meia). */
function ehTurmaEnsinoMedio(nomeTurma = '') {
  const s = String(nomeTurma).toLowerCase();
  return /ensino\s*m[eé]dio|\b[123][º°o]?\s*(ano\s*)?(em|m[eé]dio)\b/i.test(s);
}

/**
 * Consulta no banco todas as informações de frequência, ocorrências, notas e caso de busca ativa
 * de um aluno específico e devolve o diagnóstico completo.
 */
async function obterDiagnosticoAluno(db, alunoId, opcoes = {}) {
  const [[aluno]] = await db.query(
    `SELECT a.id AS aluno_id, a.usuario_id, a.turma_id, a.pai_id,
            u.nome AS nome_aluno, u.email AS email_aluno,
            t.nome AS turma_nome, t.ano AS turma_ano, t.turno AS turma_turno,
            up.nome AS nome_responsavel, p.telefone, p.telefone_e164
       FROM alunos a
       JOIN usuarios u ON u.id = a.usuario_id
       LEFT JOIN turmas t ON t.id = a.turma_id
       LEFT JOIN pais p ON p.id = a.pai_id
       LEFT JOIN usuarios up ON up.id = p.usuario_id
      WHERE a.id = ? LIMIT 1`,
    [alunoId]
  );
  if (!aluno) return null;

  const [presencas] = await db.query(
    `SELECT id, data, status, abonada, grade_horaria_id, professor_id
       FROM presencas
      WHERE aluno_id = ?
      ORDER BY data ASC, id ASC`,
    [alunoId]
  );

  let ocorrencias = [];
  let notas = [];
  let casoAtivo = null;
  try {
    [ocorrencias] = await db.query(
      'SELECT id, data, tipo, gravidade, descricao FROM ocorrencias WHERE aluno_id = ? ORDER BY data DESC',
      [alunoId]
    );
    [notas] = await db.query(
      `SELECT n.atividade_id, n.nota, a.titulo, a.disciplina, a.valor_maximo
         FROM notas n
         JOIN atividades a ON a.id = n.atividade_id
        WHERE n.aluno_id = ?`,
      [alunoId]
    );
    const [casos] = await db.query(
      `SELECT id, status, nivel_risco, motivo_abertura, aberto_em
         FROM acompanhamento_casos
        WHERE aluno_id = ? AND status != 'resolvido'
        ORDER BY id DESC LIMIT 1`,
      [alunoId]
    );
    casoAtivo = casos[0] || null;
  } catch (_) {
    // Tabelas do portfólio podem ainda não existir em bancos legados
  }

  const ensinoMedio = opcoes.ensinoMedio ?? ehTurmaEnsinoMedio(aluno.turma_nome);
  const metricas = calcularMetricasFrequencia(presencas, {
    aulasPrevistasAno: opcoes.aulasPrevistasAno,
    ensinoMedio,
  });
  const risco = calcularRiscoABC({
    metricasFrequencia: metricas,
    ocorrencias,
    notas,
    ensinoMedio,
  });

  return {
    aluno,
    metricas,
    risco,
    casoAtivo,
  };
}

/**
 * Gera o Radar de Permanência Escolar para todas as turmas (ou uma turma específica),
 * ordenado do maior risco para o menor.
 */
async function gerarRadarPermanencia(db, { turmaId = null, aulasPrevistasAno } = {}) {
  const params = [];
  let where = '';
  if (turmaId) {
    where = 'WHERE a.turma_id = ?';
    params.push(Number(turmaId));
  }

  const [alunos] = await db.query(
    `SELECT a.id AS aluno_id
       FROM alunos a
       ${where}
      ORDER BY a.id ASC`,
    params
  );

  const itens = [];
  for (const row of alunos) {
    const diag = await obterDiagnosticoAluno(db, row.aluno_id, { aulasPrevistasAno });
    if (diag) itens.push(diag);
  }

  const pesoNivel = { CRITICO: 4, ALTO: 3, MODERADO: 2, BAIXO: 1 };
  itens.sort((a, b) => {
    const diffNivel = (pesoNivel[b.risco.nivel] || 0) - (pesoNivel[a.risco.nivel] || 0);
    if (diffNivel !== 0) return diffNivel;
    if (b.risco.score !== a.risco.score) return b.risco.score - a.risco.score;
    return a.metricas.percentualLDB - b.metricas.percentualLDB;
  });

  return itens;
}

module.exports = {
  LIMITES_LEGAIS,
  calcularFaltasConsecutivas,
  calcularMetricasFrequencia,
  calcularRiscoABC,
  ehTurmaEnsinoMedio,
  obterDiagnosticoAluno,
  gerarRadarPermanencia,
};

