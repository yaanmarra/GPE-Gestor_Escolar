// src/scripts/seedDemo.js
// Popula o banco com uma massa realista e completa para demonstração do Portfólio GPE:
//  - 3 Turmas (9º Ano A Fundamental, 1º Ano EM A, 2º Ano EM B)
//  - 6 Disciplinas e 4 Professores
//  - Grade Horária Semanal completa (segunda a sexta)
//  - Calendário Letivo de 2026
//  - 4 Responsáveis (incluindo pai@escola.com com 2 filhos para o Seletor de Filhos)
//  - 6 Alunos cobrindo todos os cenários do Radar ABC:
//      1. Mariana Silva (aluno@escola.com) — Risco ALTO (3 faltas consecutivas + atestado pendente)
//      2. Pedro Silva (irmão da Mariana, mesmo pai) — Risco BAIXO / Exemplar (96% de presença)
//      3. Lucas Oliveira — Risco CRÍTICO (65% LDB, 5 faltas seguidas, Caso de Busca Ativa aberto)
//      4. Beatriz Santos (1º EM) — Risco MODERADO / Alerta Pé-de-Meia (78%, abaixo dos 80% do benefício)
//      5. Gabriel Costa — Frequência 76% com atestado médico homologado
//      6. Sofia Almeida — 100% de assiduidade e destaque acadêmico
//  - Atividades avaliativas, Notas, Ocorrências, Justificativas e Comunicados com confirmações de leitura.

const bcrypt = require('bcryptjs');
const { dbPromise } = require('../config/database');
const { garantirSchemaPortfolio } = require('../config/portfolioSchema');
const { prepararSchemaWhatsapp } = require('../workers/whatsappWorker');
const { normalizarTelefoneBR } = require('../utils/telefone');

async function upsertUsuario({ nome, email, senhaHash, tipo }) {
  const [rows] = await dbPromise.query('SELECT id FROM usuarios WHERE email = ? LIMIT 1', [email]);
  if (rows.length > 0) {
    await dbPromise.query('UPDATE usuarios SET nome = ?, senha = ?, tipo = ? WHERE id = ?', [
      nome,
      senhaHash,
      tipo,
      rows[0].id,
    ]);
    return rows[0].id;
  }
  const [res] = await dbPromise.query(
    'INSERT INTO usuarios (nome, email, senha, tipo) VALUES (?, ?, ?, ?)',
    [nome, email, senhaHash, tipo]
  );
  return res.insertId;
}

async function upsertTurma({ nome, ano, turno }) {
  const [rows] = await dbPromise.query('SELECT id FROM turmas WHERE nome = ? LIMIT 1', [nome]);
  if (rows.length > 0) {
    await dbPromise.query('UPDATE turmas SET ano = ?, turno = ?, ativa = 1 WHERE id = ?', [ano, turno, rows[0].id]);
    return rows[0].id;
  }
  const [res] = await dbPromise.query(
    'INSERT INTO turmas (nome, ano, turno, ativa) VALUES (?, ?, ?, 1)',
    [nome, ano, turno]
  );
  return res.insertId;
}

async function upsertProfessor({ nome, email, disciplina, senhaHash }) {
  const usuarioId = await upsertUsuario({ nome, email, senhaHash, tipo: 'professor' });
  const [rows] = await dbPromise.query('SELECT id FROM professores WHERE usuario_id = ? LIMIT 1', [usuarioId]);
  if (rows.length > 0) {
    await dbPromise.query('UPDATE professores SET disciplina = ? WHERE id = ?', [disciplina, rows[0].id]);
    return { usuarioId, professorId: rows[0].id };
  }
  const [res] = await dbPromise.query(
    'INSERT INTO professores (usuario_id, disciplina) VALUES (?, ?)',
    [usuarioId, disciplina]
  );
  return { usuarioId, professorId: res.insertId };
}

async function upsertPai({ nome, email, telefone, optin = 1, senhaHash }) {
  const usuarioId = await upsertUsuario({ nome, email, senhaHash, tipo: 'pai' });
  const e164 = normalizarTelefoneBR(telefone);
  const [rows] = await dbPromise.query('SELECT id FROM pais WHERE usuario_id = ? LIMIT 1', [usuarioId]);
  if (rows.length > 0) {
    await dbPromise.query(
      `UPDATE pais
          SET telefone = ?,
              telefone_e164 = ?,
              whatsapp_optin = ?,
              whatsapp_optin_em = IF(? = 1, COALESCE(whatsapp_optin_em, NOW()), NULL),
              whatsapp_optin_origem = IF(? = 1, COALESCE(whatsapp_optin_origem, 'seed_demo'), NULL)
        WHERE id = ?`,
      [telefone, e164, optin, optin, optin, rows[0].id]
    );
    return { usuarioId, paiId: rows[0].id };
  }
  const [res] = await dbPromise.query(
    `INSERT INTO pais (usuario_id, telefone, telefone_e164, whatsapp_optin, whatsapp_optin_em, whatsapp_optin_origem)
     VALUES (?, ?, ?, ?, IF(? = 1, NOW(), NULL), IF(? = 1, 'seed_demo', NULL))`,
    [usuarioId, telefone, e164, optin, optin, optin]
  );
  return { usuarioId, paiId: res.insertId };
}

async function upsertAluno({ nome, email, paiId, turmaId, parentesco = 'responsavel', senhaHash }) {
  const usuarioId = await upsertUsuario({ nome, email, senhaHash, tipo: 'aluno' });
  const [rows] = await dbPromise.query('SELECT id FROM alunos WHERE usuario_id = ? LIMIT 1', [usuarioId]);
  let alunoId;
  if (rows.length > 0) {
    alunoId = rows[0].id;
    await dbPromise.query('UPDATE alunos SET pai_id = ?, turma_id = ? WHERE id = ?', [paiId, turmaId, alunoId]);
  } else {
    const [res] = await dbPromise.query(
      'INSERT INTO alunos (usuario_id, pai_id, turma_id) VALUES (?, ?, ?)',
      [usuarioId, paiId, turmaId]
    );
    alunoId = res.insertId;
  }

  await dbPromise.query(
    `INSERT INTO aluno_responsavel (aluno_id, pai_id, parentesco, principal, recebe_notificacoes)
     VALUES (?, ?, ?, 1, 1)
     ON DUPLICATE KEY UPDATE parentesco = VALUES(parentesco), recebe_notificacoes = 1`,
    [alunoId, paiId, parentesco]
  );

  return { usuarioId, alunoId };
}

/** Gera lista de datas úteis (seg-sex) recentes até hoje para chamadas consistentes. */
function gerarDiasLetivosRecentes(quantidade = 20, dataBase = new Date()) {
  const datas = [];
  const cursor = new Date(dataBase.getFullYear(), dataBase.getMonth(), dataBase.getDate());
  while (datas.length < quantidade) {
    const dow = cursor.getDay();
    if (dow !== 0 && dow !== 6) {
      const y = cursor.getFullYear();
      const m = String(cursor.getMonth() + 1).padStart(2, '0');
      const d = String(cursor.getDate()).padStart(2, '0');
      datas.unshift(`${y}-${m}-${d}`);
    }
    cursor.setDate(cursor.getDate() - 1);
  }
  return datas;
}

async function seedDemo() {
  console.log('🚀 Iniciando seed:demo — Fundação de Dados do Portfólio GPE...');

  try {
    await prepararSchemaWhatsapp();
    await garantirSchemaPortfolio(dbPromise);

    const senhaHash = await bcrypt.hash('123456', 10);

    // 1. Gestor
    const gestorUsuarioId = await upsertUsuario({
      nome: 'Diretora Helena Martins',
      email: 'gestor@escola.com',
      senhaHash,
      tipo: 'gestor',
    });

    // 2. Disciplinas
    const listaDisciplinas = [
      ['Matemática', 160],
      ['Língua Portuguesa', 160],
      ['História', 80],
      ['Ciências / Biologia', 120],
      ['Geografia', 80],
      ['Física', 80],
    ];
    const discMap = {};
    for (const [nome, carga] of listaDisciplinas) {
      await dbPromise.query(
        `INSERT INTO disciplinas (nome, carga_horaria_anual) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE carga_horaria_anual = VALUES(carga_horaria_anual)`,
        [nome, carga]
      );
      const [[d]] = await dbPromise.query('SELECT id FROM disciplinas WHERE nome = ?', [nome]);
      discMap[nome] = d.id;
    }

    // 3. Turmas (Fundamental II + Ensino Médio para demonstrar Pé-de-Meia)
    const turma9A = await upsertTurma({ nome: '9º Ano A - Fundamental', ano: 2026, turno: 'matutino' });
    const turma1EM = await upsertTurma({ nome: '1º Ano EM - Ensino Médio', ano: 2026, turno: 'matutino' });
    const turma2EM = await upsertTurma({ nome: '2º Ano EM - Ensino Médio', ano: 2026, turno: 'vespertino' });

    // 4. Professores
    const profMat = await upsertProfessor({
      nome: 'Prof. Carlos Silva',
      email: 'professor@escola.com',
      disciplina: 'Matemática',
      senhaHash,
    });
    const profPort = await upsertProfessor({
      nome: 'Profa. Fernanda Lima',
      email: 'fernanda.port@escola.com',
      disciplina: 'Língua Portuguesa',
      senhaHash,
    });
    const profHist = await upsertProfessor({
      nome: 'Prof. Ricardo Gomes',
      email: 'ricardo.hist@escola.com',
      disciplina: 'História',
      senhaHash,
    });
    const profBio = await upsertProfessor({
      nome: 'Profa. Juliana Rocha',
      email: 'juliana.bio@escola.com',
      disciplina: 'Ciências / Biologia',
      senhaHash,
    });

    for (const p of [profMat, profPort, profHist, profBio]) {
      for (const tId of [turma9A, turma1EM, turma2EM]) {
        await dbPromise.query(
          'INSERT IGNORE INTO professor_turma (professor_id, turma_id) VALUES (?, ?)',
          [p.professorId, tId]
        );
      }
    }

    // 5. Grade Horária Semanal (limpa e recria a grade das 3 turmas demo)
    await dbPromise.query('DELETE FROM grade_horaria WHERE turma_id IN (?, ?, ?)', [turma9A, turma1EM, turma2EM]);
    const dias = ['segunda', 'terca', 'quarta', 'quinta', 'sexta'];
    const slotsManha = [
      ['07:30:00', '08:20:00'],
      ['08:20:00', '09:10:00'],
      ['09:30:00', '10:20:00'],
      ['10:20:00', '11:10:00'],
    ];
    const profsRotacao = [
      { id: profMat.professorId, disc: 'Matemática' },
      { id: profPort.professorId, disc: 'Língua Portuguesa' },
      { id: profHist.professorId, disc: 'História' },
      { id: profBio.professorId, disc: 'Ciências / Biologia' },
    ];

    for (const [idxDia, dia] of dias.entries()) {
      for (let s = 0; s < slotsManha.length; s++) {
        const p9 = profsRotacao[(idxDia + s) % profsRotacao.length];
        const p1 = profsRotacao[(idxDia + s + 1) % profsRotacao.length];
        await dbPromise.query(
          `INSERT INTO grade_horaria (turma_id, professor_id, disciplina_id, disciplina, dia_semana, horario_inicio, horario_fim, ano_letivo)
           VALUES (?, ?, ?, ?, ?, ?, ?, 2026)`,
          [turma9A, p9.id, discMap[p9.disc], p9.disc, dia, slotsManha[s][0], slotsManha[s][1]]
        );
        await dbPromise.query(
          `INSERT INTO grade_horaria (turma_id, professor_id, disciplina_id, disciplina, dia_semana, horario_inicio, horario_fim, ano_letivo)
           VALUES (?, ?, ?, ?, ?, ?, ?, 2026)`,
          [turma1EM, p1.id, discMap[p1.disc], p1.disc, dia, slotsManha[s][0], slotsManha[s][1]]
        );
      }
    }

    // 6. Pais e Alunos (6 alunos em cenários distintos)
    const paiJoao = await upsertPai({
      nome: 'João Silva (Responsável)',
      email: 'pai@escola.com',
      telefone: '11988887777',
      optin: 1,
      senhaHash,
    });
    const maeMaria = await upsertPai({
      nome: 'Maria Oliveira',
      email: 'maria.oliveira@escola.com',
      telefone: '11988886666',
      optin: 1,
      senhaHash,
    });
    const paiCarlos = await upsertPai({
      nome: 'Roberto Santos',
      email: 'roberto.santos@escola.com',
      telefone: '11988885555',
      optin: 1,
      senhaHash,
    });
    const maeAna = await upsertPai({
      nome: 'Ana Paula Costa',
      email: 'ana.costa@escola.com',
      telefone: '11988884444',
      optin: 1,
      senhaHash,
    });

    // Filho 1 de João: Mariana (login principal aluno@escola.com) -> Risco ALTO (3 faltas seguidas)
    const alunaMariana = await upsertAluno({
      nome: 'Mariana Silva',
      email: 'aluno@escola.com',
      paiId: paiJoao.paiId,
      turmaId: turma1EM,
      parentesco: 'pai',
      senhaHash,
    });
    // Filho 2 de João: Pedro (para testar o seletor de filhos no portal da família) -> Exemplar
    const alunoPedro = await upsertAluno({
      nome: 'Pedro Silva',
      email: 'pedro.silva@escola.com',
      paiId: paiJoao.paiId,
      turmaId: turma9A,
      parentesco: 'pai',
      senhaHash,
    });
    // Aluno 3: Lucas -> Risco CRÍTICO (evasão / Conselho Tutelar / Caso Busca Ativa)
    const alunoLucas = await upsertAluno({
      nome: 'Lucas Oliveira',
      email: 'lucas.oliveira@escola.com',
      paiId: maeMaria.paiId,
      turmaId: turma9A,
      parentesco: 'mae',
      senhaHash,
    });
    // Aluna 4: Beatriz (1º EM) -> Alerta Pé-de-Meia (75% <= freq < 80%)
    const alunaBeatriz = await upsertAluno({
      nome: 'Beatriz Santos',
      email: 'beatriz.santos@escola.com',
      paiId: paiCarlos.paiId,
      turmaId: turma1EM,
      parentesco: 'pai',
      senhaHash,
    });
    // Aluno 5: Gabriel -> Faltas justificadas por atestado médico homologado
    const alunoGabriel = await upsertAluno({
      nome: 'Gabriel Costa',
      email: 'gabriel.costa@escola.com',
      paiId: maeAna.paiId,
      turmaId: turma9A,
      parentesco: 'mae',
      senhaHash,
    });
    // Aluna 6: Sofia -> 100% de presença
    const alunaSofia = await upsertAluno({
      nome: 'Sofia Almeida',
      email: 'sofia.almeida@escola.com',
      paiId: paiCarlos.paiId,
      turmaId: turma2EM,
      parentesco: 'pai',
      senhaHash,
    });

    // 7. Calendário Letivo e Histórico de Presenças (20 dias letivos recentes)
    const diasLetivos = gerarDiasLetivosRecentes(20);
    for (const d of diasLetivos) {
      await dbPromise.query(
        `INSERT INTO calendario_letivo (data, ano_letivo, tipo, descricao)
         VALUES (?, 2026, 'letivo', 'Dia letivo regular')
         ON DUPLICATE KEY UPDATE tipo = 'letivo'`,
        [d]
      );
    }

    const todosAlunosIds = [
      alunaMariana.alunoId,
      alunoPedro.alunoId,
      alunoLucas.alunoId,
      alunaBeatriz.alunoId,
      alunoGabriel.alunoId,
      alunaSofia.alunoId,
    ];
    await dbPromise.query('DELETE FROM presencas WHERE aluno_id IN (?)', [todosAlunosIds]);

    const inserirSeriePresencas = async (alunoId, turmaId, padraoStatus) => {
      for (let i = 0; i < diasLetivos.length; i++) {
        const status = padraoStatus(i);
        await dbPromise.query(
          `INSERT INTO presencas (aluno_id, professor_id, turma_id, data, status)
           VALUES (?, ?, ?, ?, ?)`,
          [alunoId, profMat.professorId, turmaId, diasLetivos[i], status]
        );
      }
    };

    // Mariana (1º EM): 15 presenças + 2 faltas antigas + 3 faltas consecutivas nos últimos 3 dias (75%, alerta consecutivo)
    await inserirSeriePresencas(alunaMariana.alunoId, turma1EM, (i) =>
      i >= 17 || i === 4 || i === 9 ? 'falta' : 'presente'
    );
    // Pedro (9º A): 19 presenças + 1 falta justificada (95% LDB)
    await inserirSeriePresencas(alunoPedro.alunoId, turma9A, (i) =>
      i === 10 ? 'justificado' : 'presente'
    );
    // Lucas (9º A): 12 presenças + 8 faltas (sendo 5 consecutivas no final) -> 60% LDB (CRÍTICO)
    await inserirSeriePresencas(alunoLucas.alunoId, turma9A, (i) =>
      i >= 15 || i === 3 || i === 7 || i === 11 ? 'falta' : 'presente'
    );
    // Beatriz (1º EM): 15 presenças + 4 faltas + 1 justificada = 75% (regular LDB, mas alerta Pé-de-Meia < 80%)
    await inserirSeriePresencas(alunaBeatriz.alunoId, turma1EM, (i) =>
      i === 2 ? 'justificado' : [5, 8, 12, 16].includes(i) ? 'falta' : 'presente'
    );
    // Gabriel (9º A): 16 presenças + 4 justificadas por atestado = 80% LDB (0 faltas injustificadas)
    await inserirSeriePresencas(alunoGabriel.alunoId, turma9A, (i) =>
      i >= 12 && i <= 15 ? 'justificado' : 'presente'
    );
    // Sofia (2º EM): 20 presenças = 100%
    await inserirSeriePresencas(alunaSofia.alunoId, turma2EM, () => 'presente');

    // 8. Justificativas / Atestados (1 pendente para Mariana, 1 aprovado para Gabriel, 1 recusado para Lucas)
    await dbPromise.query('DELETE FROM justificativas WHERE aluno_id IN (?)', [todosAlunosIds]);
    const [[presMariana]] = await dbPromise.query(
      'SELECT id, data FROM presencas WHERE aluno_id = ? AND status = "falta" ORDER BY data DESC LIMIT 1',
      [alunaMariana.alunoId]
    );
    if (presMariana) {
      await dbPromise.query(
        `INSERT INTO justificativas
          (aluno_id, presenca_id, tipo, data_inicio, data_fim, texto, arquivo_url, status)
         VALUES (?, ?, 'atestado_medico', ?, ?, 'Consulta médica de urgência (virose respiratória). Atestado de 3 dias anexo.', '/uploads/atestados/demo_atestado_mariana.pdf', 'pendente')`,
        [alunaMariana.alunoId, presMariana.id, diasLetivos[17], diasLetivos[19]]
      );
    }

    const [[presGabriel]] = await dbPromise.query(
      'SELECT id, data FROM presencas WHERE aluno_id = ? AND status = "justificado" ORDER BY data DESC LIMIT 1',
      [alunoGabriel.alunoId]
    );
    if (presGabriel) {
      await dbPromise.query(
        `INSERT INTO justificativas
          (aluno_id, presenca_id, tipo, data_inicio, data_fim, texto, arquivo_url, status, homologado_por, homologado_em)
         VALUES (?, ?, 'atestado_medico', ?, ?, 'Atestado odontológico / cirurgia de siso.', '/uploads/atestados/demo_atestado_gabriel.pdf', 'aprovado', ?, NOW())`,
        [alunoGabriel.alunoId, presGabriel.id, diasLetivos[12], diasLetivos[15], gestorUsuarioId]
      );
    }

    // 9. Atividades e Notas
    await dbPromise.query('DELETE FROM atividades WHERE turma_id IN (?, ?, ?)', [turma9A, turma1EM, turma2EM]);
    const [resAtiv1] = await dbPromise.query(
      `INSERT INTO atividades (turma_id, professor_id, disciplina, titulo, descricao, tipo, data_entrega, valor_maximo)
       VALUES (?, ?, 'Matemática', 'Avaliação Bimestral de Álgebra', 'Equações do 2º grau e funções.', 'prova', DATE_ADD(CURDATE(), INTERVAL 5 DAY), 10.00)`,
      [turma9A, profMat.professorId]
    );
    const [resAtiv2] = await dbPromise.query(
      `INSERT INTO atividades (turma_id, professor_id, disciplina, titulo, descricao, tipo, data_entrega, valor_maximo)
       VALUES (?, ?, 'Matemática', 'Simulado ENEM / Funções', 'Modelagem matemática e gráficos.', 'prova', DATE_ADD(CURDATE(), INTERVAL 7 DAY), 10.00)`,
      [turma1EM, profMat.professorId]
    );

    const notasSeed = [
      [resAtiv1.insertId, alunoPedro.alunoId, 9.2, 'Excelente domínio'],
      [resAtiv1.insertId, alunoLucas.alunoId, 4.2, 'Perdeu aulas de revisão por faltas'],
      [resAtiv1.insertId, alunoGabriel.alunoId, 7.8, 'Bom desempenho'],
      [resAtiv2.insertId, alunaMariana.alunoId, 6.5, 'Atenção às últimas listas'],
      [resAtiv2.insertId, alunaBeatriz.alunoId, 5.5, 'Recuperação paralela recomendada'],
    ];
    for (const [ativId, alId, nota, obs] of notasSeed) {
      await dbPromise.query(
        'INSERT INTO notas (atividade_id, aluno_id, nota, observacao) VALUES (?, ?, ?, ?)',
        [ativId, alId, nota, obs]
      );
    }

    // 10. Ocorrências Pedagógicas
    await dbPromise.query('DELETE FROM ocorrencias WHERE aluno_id IN (?)', [todosAlunosIds]);
    await dbPromise.query(
      `INSERT INTO ocorrencias (aluno_id, professor_id, autor_usuario_id, data, tipo, gravidade, descricao, notificar_pais, notificado_em)
       VALUES
         (?, ?, ?, ?, 'indisciplina', 'media', 'Uso recorrente de celular durante a explicação e recusa em realizar a atividade.', 1, NOW()),
         (?, ?, ?, ?, 'sem_material', 'leve', 'Compareceu sem o livro didático de Matemática.', 0, NULL),
         (?, ?, ?, ?, 'elogio', 'positiva', 'Auxiliou os colegas na resolução de exercícios em grupo.', 1, NOW())`,
      [
        alunoLucas.alunoId, profMat.professorId, profMat.usuarioId, diasLetivos[14],
        alunaMariana.alunoId, profPort.professorId, profPort.usuarioId, diasLetivos[16],
        alunoPedro.alunoId, profMat.professorId, profMat.usuarioId, diasLetivos[18],
      ]
    );

    // 11. Caso de Busca Ativa Escolar (para Lucas Oliveira)
    await dbPromise.query('DELETE FROM acompanhamento_casos WHERE aluno_id IN (?)', [todosAlunosIds]);
    const [resCaso] = await dbPromise.query(
      `INSERT INTO acompanhamento_casos
        (aluno_id, status, nivel_risco, motivo_abertura, resumo_acao, responsavel_usuario_id)
       VALUES (?, 'em_contato', 'CRITICO', 'Frequência em 60% (abaixo dos 75% LDB) e 5 faltas injustificadas consecutivas.', 'Contato iniciado via WhatsApp e ligação para a responsável Maria Oliveira.', ?)`,
      [alunoLucas.alunoId, gestorUsuarioId]
    );
    await dbPromise.query(
      `INSERT INTO acompanhamento_interacoes (caso_id, autor_usuario_id, canal, resultado, descricao)
       VALUES
         (?, ?, 'whatsapp', 'sucesso', 'Disparo automático de alerta de faltas consecutivas enviado ao WhatsApp da responsável.'),
         (?, ?, 'telefone', 'sem_resposta', 'Tentativa de ligação às 14h30 — caixa postal. Agendada nova tentativa e convocação presencial.')`,
      [resCaso.insertId, gestorUsuarioId, resCaso.insertId, gestorUsuarioId]
    );

    // 12. Comunicados da Escola e Confirmação de Leitura
    await dbPromise.query('DELETE FROM comunicados WHERE autor_usuario_id = ?', [gestorUsuarioId]);
    const [resCom1] = await dbPromise.query(
      `INSERT INTO comunicados (autor_usuario_id, turma_id, publico, titulo, conteudo, enviar_whatsapp)
       VALUES (?, NULL, 'todos', 'Reunião Bimestral de Pais e Mestres', 'Convidamos todas as famílias para o plantão pedagógico neste sábado às 09h00, com foco em acompanhamento de frequência e desempenho.', 1)`,
      [gestorUsuarioId]
    );
    await dbPromise.query(
      'INSERT IGNORE INTO comunicado_leituras (comunicado_id, usuario_id) VALUES (?, ?)',
      [resCom1.insertId, paiJoao.usuarioId]
    );

    console.log('\n🎉 Seed de Demonstração (Etapa 1) concluído com sucesso!');
    console.log('------------------------------------------------------------');
    console.log('👔 Gestor:    gestor@escola.com     (senha: 123456)');
    console.log('👨‍🏫 Professor: professor@escola.com  (senha: 123456)');
    console.log('👨‍👩‍👧 Família:   pai@escola.com        (senha: 123456) -> 2 filhos: Mariana e Pedro');
    console.log('🎓 Aluno:     aluno@escola.com      (senha: 123456) -> Mariana Silva (1º EM)');
    console.log('------------------------------------------------------------');
    process.exit(0);
  } catch (err) {
    console.error('❌ Erro ao executar seed:demo:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  seedDemo();
}

module.exports = { seedDemo };

