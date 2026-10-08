// src/scripts/seedDev.js
const bcrypt = require('bcryptjs');
const { dbPromise } = require('../config/database');

async function seed() {
  console.log('🌱 Iniciando criação de usuários e dados para Desenvolvimento...');

  try {
    const senhaHash = await bcrypt.hash('123456', 12);

    // 1. Criar ou atualizar Gestor
    const [gestores] = await dbPromise.query('SELECT id FROM usuarios WHERE email = ?', ['gestor@escola.com']);
    let gestorId;
    if (gestores.length === 0) {
      const [res] = await dbPromise.query(
        'INSERT INTO usuarios (nome, email, senha, tipo) VALUES (?, ?, ?, ?)',
        ['Gestor Principal', 'gestor@escola.com', senhaHash, 'gestor']
      );
      gestorId = res.insertId;
      console.log('✅ Gestor criado: gestor@escola.com (senha: 123456)');
    } else {
      gestorId = gestores[0].id;
      await dbPromise.query('UPDATE usuarios SET senha = ?, tipo = ? WHERE id = ?', [senhaHash, 'gestor', gestorId]);
      console.log('ℹ️ Gestor existente atualizado: gestor@escola.com (senha: 123456)');
    }

    // 2. Criar ou garantir uma Turma de exemplo
    const [turmas] = await dbPromise.query('SELECT id FROM turmas WHERE nome = ?', ['1º Ano A']);
    let turmaId;
    if (turmas.length === 0) {
      const [res] = await dbPromise.query(
        'INSERT INTO turmas (nome, ano, turno, ativa) VALUES (?, ?, ?, ?)',
        ['1º Ano A', 2026, 'matutino', 1]
      );
      turmaId = res.insertId;
      console.log('✅ Turma de exemplo criada: 1º Ano A');
    } else {
      turmaId = turmas[0].id;
      console.log('ℹ️ Turma existente encontrada: 1º Ano A (ID: ' + turmaId + ')');
    }

    // 3. Criar ou atualizar Professor
    const [professores] = await dbPromise.query('SELECT id FROM usuarios WHERE email = ?', ['professor@escola.com']);
    let profUsuarioId;
    let profTabelaId;
    if (professores.length === 0) {
      const [res] = await dbPromise.query(
        'INSERT INTO usuarios (nome, email, senha, tipo) VALUES (?, ?, ?, ?)',
        ['Prof. Carlos Silva', 'professor@escola.com', senhaHash, 'professor']
      );
      profUsuarioId = res.insertId;
      const [resProf] = await dbPromise.query(
        'INSERT INTO professores (usuario_id, disciplina) VALUES (?, ?)',
        [profUsuarioId, 'Matemática']
      );
      profTabelaId = resProf.insertId;
      console.log('✅ Professor criado: professor@escola.com (senha: 123456)');
    } else {
      profUsuarioId = professores[0].id;
      await dbPromise.query('UPDATE usuarios SET senha = ?, tipo = ? WHERE id = ?', [senhaHash, 'professor', profUsuarioId]);
      const [p] = await dbPromise.query('SELECT id FROM professores WHERE usuario_id = ?', [profUsuarioId]);
      if (p.length === 0) {
        const [resProf] = await dbPromise.query(
          'INSERT INTO professores (usuario_id, disciplina) VALUES (?, ?)',
          [profUsuarioId, 'Matemática']
        );
        profTabelaId = resProf.insertId;
      } else {
        profTabelaId = p[0].id;
      }
      console.log('ℹ️ Professor existente atualizado: professor@escola.com (senha: 123456)');
    }

    // Associar Professor à Turma
    await dbPromise.query(
      'INSERT IGNORE INTO professor_turma (professor_id, turma_id) VALUES (?, ?)',
      [profTabelaId, turmaId]
    );

    // 4. Criar ou atualizar Pai/Responsável
    const [pais] = await dbPromise.query('SELECT id FROM usuarios WHERE email = ?', ['pai@escola.com']);
    let paiUsuarioId;
    let paiTabelaId;
    if (pais.length === 0) {
      const [res] = await dbPromise.query(
        'INSERT INTO usuarios (nome, email, senha, tipo) VALUES (?, ?, ?, ?)',
        ['João Responsável', 'pai@escola.com', senhaHash, 'pai']
      );
      paiUsuarioId = res.insertId;
      const [resPai] = await dbPromise.query(
        'INSERT INTO pais (usuario_id, telefone) VALUES (?, ?)',
        [paiUsuarioId, '11988887777']
      );
      paiTabelaId = resPai.insertId;
      console.log('✅ Pai/Responsável criado: pai@escola.com (senha: 123456)');
    } else {
      paiUsuarioId = pais[0].id;
      await dbPromise.query('UPDATE usuarios SET senha = ?, tipo = ? WHERE id = ?', [senhaHash, 'pai', paiUsuarioId]);
      const [p] = await dbPromise.query('SELECT id FROM pais WHERE usuario_id = ?', [paiUsuarioId]);
      if (p.length === 0) {
        const [resPai] = await dbPromise.query(
          'INSERT INTO pais (usuario_id, telefone) VALUES (?, ?)',
          [paiUsuarioId, '11988887777']
        );
        paiTabelaId = p[0] ? p[0].id : resPai.insertId;
      } else {
        paiTabelaId = p[0].id;
      }
      console.log('ℹ️ Pai existente atualizado: pai@escola.com (senha: 123456)');
    }

    // 5. Criar ou atualizar Aluno
    const [alunos] = await dbPromise.query('SELECT id FROM usuarios WHERE email = ?', ['aluno@escola.com']);
    if (alunos.length === 0) {
      const [res] = await dbPromise.query(
        'INSERT INTO usuarios (nome, email, senha, tipo) VALUES (?, ?, ?, ?)',
        ['Lucas Estudante', 'aluno@escola.com', senhaHash, 'aluno']
      );
      const alunoUsuarioId = res.insertId;
      await dbPromise.query(
        'INSERT INTO alunos (usuario_id, pai_id, turma_id) VALUES (?, ?, ?)',
        [alunoUsuarioId, paiTabelaId, turmaId]
      );
      console.log('✅ Aluno criado: aluno@escola.com (senha: 123456)');
    } else {
      const alunoUsuarioId = alunos[0].id;
      await dbPromise.query('UPDATE usuarios SET senha = ?, tipo = ? WHERE id = ?', [senhaHash, 'aluno', alunoUsuarioId]);
      console.log('ℹ️ Aluno existente atualizado: aluno@escola.com (senha: 123456)');
    }

    console.log('\n✨ Todos os usuários de teste foram gerados com sucesso!');
    console.log('----------------------------------------------------');
    console.log('🔑 Credenciais para login (senha padrão: 123456):');
    console.log('  1. GESTOR:    gestor@escola.com');
    console.log('  2. PROFESSOR: professor@escola.com');
    console.log('  3. PAI:       pai@escola.com');
    console.log('  4. ALUNO:     aluno@escola.com');
    console.log('----------------------------------------------------');
  } catch (err) {
    console.error('❌ Erro ao criar dados de teste:', err);
  } finally {
    process.exit(0);
  }
}

seed();
