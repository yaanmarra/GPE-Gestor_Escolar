// tests/frequenciaUnit.test.js — Testes unitários do motor de frequência e risco ABC
const assert = require('node:assert/strict');
const {
  LIMITES_LEGAIS,
  calcularFaltasConsecutivas,
  calcularMetricasFrequencia,
  calcularRiscoABC,
  ehTurmaEnsinoMedio,
} = require('../src/services/frequenciaService');

describe('Motor de Frequência Escolar (LDB, Programas Sociais e Risco ABC)', () => {
  test('sem registros retorna 100% de frequência e risco BAIXO', () => {
    const m = calcularMetricasFrequencia([], { aulasPrevistasAno: 200 });
    assert.equal(m.totalAulasRegistradas, 0);
    assert.equal(m.percentualLDB, 100);
    assert.equal(m.limiteFaltasAno, 50); // 25% de 200
    assert.equal(m.faltasRestantesLDB, 50);
    assert.equal(m.aulasParaRecuperarLDB, 0);
    assert.equal(m.programas.ldb.regular, true);

    const risco = calcularRiscoABC({ metricasFrequencia: m });
    assert.equal(risco.nivel, 'BAIXO');
    assert.equal(risco.score, 0);
  });

  test('cálculo LDB 75%: falta justificada comum NÃO abona para os 75%, mas falta abonada por lei conta como presença', () => {
    // 14 presenças, 4 faltas injustificadas, 2 justificadas comuns = 20 aulas -> 14/20 = 70% (< 75%)
    const registros = [
      ...Array.from({ length: 14 }, (_, i) => ({ data: `2026-08-${String(i + 1).padStart(2, '0')}`, status: 'presente' })),
      { data: '2026-08-15', status: 'falta' },
      { data: '2026-08-16', status: 'falta' },
      { data: '2026-08-17', status: 'falta' },
      { data: '2026-08-18', status: 'falta' },
      { data: '2026-08-19', status: 'justificado', abonada: 0 },
      { data: '2026-08-20', status: 'justificado', abonada: 0 },
    ];
    const m = calcularMetricasFrequencia(registros, { aulasPrevistasAno: 100 });
    assert.equal(m.presencas, 14);
    assert.equal(m.faltasInjustificadas, 4);
    assert.equal(m.faltasJustificadas, 2);
    assert.equal(m.percentualLDB, 70);
    assert.equal(m.percentualSemInjustificadas, 80); // considerando só injustificadas: 16/20 = 80%
    assert.equal(m.programas.ldb.regular, false);
    // Para recuperar 75%: X >= 3 * 6 - 14 = 4 aulas seguidas presentes (18 / 24 = 75%)
    assert.equal(m.aulasParaRecuperarLDB, 4);

    // Se as 2 justificadas fossem abonadas por lei (Decreto-Lei 1.044/69), passa a 16/20 = 80%
    const comAbono = registros.map(r => (r.status === 'justificado' ? { ...r, abonada: 1 } : r));
    const mAbono = calcularMetricasFrequencia(comAbono, { aulasPrevistasAno: 100 });
    assert.equal(mAbono.percentualLDB, 80);
    assert.equal(mAbono.programas.ldb.regular, true);
    assert.equal(mAbono.aulasParaRecuperarLDB, 0);
  });

  test('faltas consecutivas consolida múltiplas aulas no mesmo dia e detecta gatilho >= 3 dias', () => {
    const registros = [
      { data: '2026-10-01', status: 'presente', grade_horaria_id: 1 },
      { data: '2026-10-02', status: 'falta', grade_horaria_id: 1 },
      { data: '2026-10-02', status: 'falta', grade_horaria_id: 2 }, // 2 aulas no mesmo dia = 1 dia consecutivo
      { data: '2026-10-03', status: 'presente', grade_horaria_id: 1 },
      { data: '2026-10-06', status: 'falta', grade_horaria_id: 1 },
      { data: '2026-10-07', status: 'falta', grade_horaria_id: 1 },
      { data: '2026-10-08', status: 'falta', grade_horaria_id: 1 },
    ];
    const c = calcularFaltasConsecutivas(registros);
    assert.equal(c.diasConsecutivosAtuais, 3);
    assert.equal(c.maxDiasConsecutivos, 3);
    assert.equal(c.ultimaDataFalta, '2026-10-08');

    const m = calcularMetricasFrequencia(registros);
    assert.equal(m.alertaFaltasConsecutivas, true);
  });

  test('faixas de programas sociais: Bolsa Família (75%), Pé-de-Meia (80%) e Conselho Tutelar', () => {
    // 78% de frequência no Ensino Médio: regular na LDB e no Bolsa Família, mas em risco no Pé-de-Meia (< 80%)
    const m = calcularMetricasFrequencia(
      { presencas: 78, faltas: 22, justificadas: 0 },
      { aulasPrevistasAno: 100, ensinoMedio: true }
    );
    assert.equal(m.percentualLDB, 78);
    assert.equal(m.programas.ldb.regular, true);
    assert.equal(m.programas.bolsaFamilia.regular, true);
    assert.equal(m.programas.bolsaFamilia.emAlerta, true); // 75%..79.9%
    assert.equal(m.programas.peDeMeia.aplicavel, true);
    assert.equal(m.programas.peDeMeia.regular, false); // < 80%

    // Como 22 faltas injustificadas > 30% do limite de 25 faltas (8), aciona gatilho do Conselho Tutelar
    assert.equal(m.programas.conselhoTutelar.limiteGatilhoFaltas, 8);
    assert.equal(m.programas.conselhoTutelar.notificar, true);
  });

  test('Score ABC combina Frequência (A) + Comportamento (B) + Notas (C) com motivos explicáveis', () => {
    const metricas = calcularMetricasFrequencia(
      [
        { data: '2026-10-01', status: 'presente' },
        { data: '2026-10-02', status: 'presente' },
        { data: '2026-10-03', status: 'presente' },
        { data: '2026-10-04', status: 'presente' },
        { data: '2026-10-05', status: 'presente' },
        { data: '2026-10-06', status: 'presente' },
        { data: '2026-10-07', status: 'falta' },
        { data: '2026-10-08', status: 'falta' },
        { data: '2026-10-09', status: 'falta' },
      ],
      { aulasPrevistasAno: 100, ensinoMedio: true }
    );

    const ocorrencias = [
      { tipo: 'indisciplina', gravidade: 'media', descricao: 'Conflito em sala' },
      { tipo: 'sem_material', gravidade: 'leve', descricao: 'Sem caderno' },
      { tipo: 'elogio', gravidade: 'positiva', descricao: 'Ajudou colega' },
    ];
    const notas = [
      { nota: 4.0, valor_maximo: 10 },
      { nota: 5.0, valor_maximo: 10 },
    ];

    const risco = calcularRiscoABC({ metricasFrequencia: metricas, ocorrencias, notas, ensinoMedio: true });
    assert.equal(risco.nivel, 'CRITICO');
    assert.ok(risco.score >= 60);
    assert.equal(risco.dimensoes.ocorrenciasNegativas, 2);
    assert.equal(risco.dimensoes.elogios, 1);
    assert.equal(risco.dimensoes.mediaNotas, 4.5);
    assert.ok(risco.motivos.some(t => /abaixo do mínimo LDB/i.test(t)));
    assert.ok(risco.motivos.some(t => /consecutivas/i.test(t)));
    assert.ok(risco.motivos.some(t => /ocorrência/i.test(t)));
    assert.ok(risco.motivos.some(t => /Média acadêmica baixa/i.test(t)));
  });

  test('ehTurmaEnsinoMedio identifica nomenclaturas de Ensino Médio', () => {
    assert.equal(ehTurmaEnsinoMedio('1º Ano EM - Matutino'), true);
    assert.equal(ehTurmaEnsinoMedio('3º Ensino Médio B'), true);
    assert.equal(ehTurmaEnsinoMedio('9º Ano A - Fundamental'), false);
    assert.equal(ehTurmaEnsinoMedio('7º Ano B'), false);
  });
});

