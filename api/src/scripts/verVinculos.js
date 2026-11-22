// src/scripts/verVinculos.js
// Script para imprimir no terminal a visão completa de todas as turmas,
// alunos matriculados, seus responsáveis e professores vinculados.
const { dbPromise } = require('../config/database');

async function verVinculos() {
  try {
    console.log('\n============================================================');
    console.log('🏫 MAPA DE VÍNCULOS: TURMAS, ALUNOS, PAIS E PROFESSORES (GPE)');
    console.log('============================================================\n');

    // 1. Resumo por Turma com Contagens
    const [turmas] = await dbPromise.query(`
      SELECT 
        t.id,
        t.nome,
        t.ano,
        t.turno,
        t.ativa,
        COUNT(DISTINCT a.id) AS total_alunos,
        COUNT(DISTINCT pt.professor_id) AS total_professores
      FROM turmas t
      LEFT JOIN alunos a ON a.turma_id = t.id
      LEFT JOIN professor_turma pt ON pt.turma_id = t.id
      GROUP BY t.id
      ORDER BY t.ano DESC, t.nome ASC;
    `);

    console.log('📌 1. RESUMO DE TODAS AS TURMAS:');
    console.table(
      turmas.map(t => ({
        ID: t.id,
        Turma: t.nome,
        Ano: t.ano,
        Turno: t.turno,
        Status: t.ativa ? 'Ativa' : 'Inativa',
        'Total Alunos': t.total_alunos,
        'Total Professores': t.total_professores,
      }))
    );

    // 2. Detalhamento de Alunos e seus Responsáveis por Turma
    const [alunos] = await dbPromise.query(`
      SELECT 
        t.nome AS turma,
        u_aluno.nome AS aluno,
        u_aluno.email AS email_aluno,
        COALESCE(u_pai.nome, 'SEM RESPONSÁVEL') AS responsavel,
        COALESCE(p.telefone, '-') AS telefone_contato
      FROM alunos a
      JOIN usuarios u_aluno ON u_aluno.id = a.usuario_id
      LEFT JOIN turmas t ON t.id = a.turma_id
      LEFT JOIN pais p ON p.id = a.pai_id
      LEFT JOIN usuarios u_pai ON u_pai.id = p.usuario_id
      ORDER BY t.nome ASC, u_aluno.nome ASC;
    `);

    console.log('\n📌 2. ALUNOS E SEUS RESPONSÁVEIS (POR TURMA):');
    console.table(
      alunos.map(a => ({
        Turma: a.turma || '⚠️ SEM TURMA VINCULADA',
        Aluno: a.aluno,
        'Email do Aluno': a.email_aluno,
        'Responsável (Pai/Mãe)': a.responsavel,
        Contato: a.telefone_contato,
      }))
    );

    // 3. Professores Vinculados a cada Turma
    const [professores] = await dbPromise.query(`
      SELECT 
        t.nome AS turma,
        u_prof.nome AS professor,
        pr.disciplina
      FROM professor_turma pt
      JOIN turmas t ON t.id = pt.turma_id
      JOIN professores pr ON pr.id = pt.professor_id
      JOIN usuarios u_prof ON u_prof.id = pr.usuario_id
      ORDER BY t.nome ASC, u_prof.nome ASC;
    `);

    console.log('\n📌 3. PROFESSORES VINCULADOS ÀS TURMAS:');
    console.table(
      professores.map(p => ({
        Turma: p.turma,
        Professor: p.professor,
        Disciplina: p.disciplina || '-',
      }))
    );

    console.log('\n✅ Consulta finalizada com sucesso.\n');
  } catch (err) {
    console.error('❌ Erro ao consultar vínculos:', err.message);
  } finally {
    process.exit(0);
  }
}

verVinculos();

