// tests/requisitosIntegracao.test.js — Testes de integração para requisitos RF-001 a RF-006 e RBAC/IDOR
const request = require('supertest');
const { app } = require('../server');
const { dbPromise, validarBancoDeTeste } = require('../src/config/database');
const { garantirSchemaPortfolio } = require('../src/config/portfolioSchema');
const bcrypt = require('bcryptjs');

// Mock do nodemailer para não disparar e-mails reais durante os testes de integração
jest.mock('nodemailer', () => {
  const sendMailMock = jest.fn().mockResolvedValue({ messageId: 'mock-123' });
  return {
    createTransport: jest.fn().mockReturnValue({ sendMail: sendMailMock, close: jest.fn() }),
    _sendMailMock: sendMailMock,
  };
});

describe('ETAPA 3 & 6 — Testes de Integração e Rastreabilidade de Requisitos', () => {
  let tokenGestor, tokenProfessor1, tokenProfessor2, tokenPai1, tokenPai2, tokenAluno1, tokenAluno2;
  let idUserGestor, idUserProf1, idUserProf2, idUserPai1, idUserPai2, idUserAluno1, idUserAluno2;
  let recordProf1, recordProf2, recordPai1, recordPai2, recordAluno1, recordAluno2;
  let idTurma1, idTurma2;
  let refreshTokenGestor;

  beforeAll(async () => {
    // 0. Trava programática obrigatória: garante execução exclusiva em banco de teste (gpe_test)
    await validarBancoDeTeste(dbPromise);
    await garantirSchemaPortfolio(dbPromise);

    // Limpeza completa do banco de teste isolado
    await dbPromise.query('SET FOREIGN_KEY_CHECKS = 0');
    await dbPromise.query('TRUNCATE TABLE justificativas');
    await dbPromise.query('TRUNCATE TABLE email_jobs');
    await dbPromise.query('TRUNCATE TABLE notificacoes');
    await dbPromise.query('TRUNCATE TABLE presencas');
    await dbPromise.query('TRUNCATE TABLE professor_turma');
    await dbPromise.query('TRUNCATE TABLE alunos');
    await dbPromise.query('TRUNCATE TABLE professores');
    await dbPromise.query('TRUNCATE TABLE pais');
    await dbPromise.query('TRUNCATE TABLE turmas');
    await dbPromise.query('TRUNCATE TABLE usuarios');
    await dbPromise.query('SET FOREIGN_KEY_CHECKS = 1');

    const hash = await bcrypt.hash('123456', 1);

    // 1. Criar Gestor Inicial
    const [resG] = await dbPromise.query(
      'INSERT INTO usuarios (nome, email, senha, tipo) VALUES ("Gestor Teste", "gestor.qa@teste.com", ?, "gestor")',
      [hash]
    );
    idUserGestor = resG.insertId;

    // Login Gestor
    const resLoginG = await request(app).post('/api/login').send({ email: 'gestor.qa@teste.com', senha: '123456' });
    tokenGestor = resLoginG.body.dados?.accessToken;
    refreshTokenGestor = resLoginG.body.dados?.refreshToken;
  });

  afterAll(async () => {
    await dbPromise.end();
  });

  // ============================================================
  // RF-001 — Cadastro de Usuários, Pais, Professores e Alunos
  // ============================================================
  describe('RF-001 — Cadastro e Gerenciamento de Alunos e Usuários', () => {
    it('deve permitir ao gestor criar turmas base', async () => {
      const resT1 = await request(app)
        .post('/api/turmas')
        .set('Authorization', `Bearer ${tokenGestor}`)
        .send({ nome: '7º Ano A', ano: 2026, turno: 'matutino' });
      expect(resT1.status).toBe(201);
      idTurma1 = resT1.body.dados.id;

      const resT2 = await request(app)
        .post('/api/turmas')
        .set('Authorization', `Bearer ${tokenGestor}`)
        .send({ nome: '8º Ano B', ano: 2026, turno: 'vespertino' });
      expect(resT2.status).toBe(201);
      idTurma2 = resT2.body.dados.id;
    });

    it('deve permitir ao gestor cadastrar responsáveis (pais)', async () => {
      const resP1 = await request(app)
        .post('/api/cadastro')
        .set('Authorization', `Bearer ${tokenGestor}`)
        .send({
          nome: 'Pai Silva',
          email: 'pai.silva@teste.com',
          senha: 'senhaSegura123',
          tipo: 'pai',
          telefone: '11999990001'
        });
      expect(resP1.status).toBe(201);

      const [pRows1] = await dbPromise.query('SELECT p.id, u.id AS user_id FROM pais p JOIN usuarios u ON u.id = p.usuario_id WHERE u.email = "pai.silva@teste.com"');
      recordPai1 = pRows1[0].id;
      idUserPai1 = pRows1[0].user_id;

      const resP2 = await request(app)
        .post('/api/cadastro')
        .set('Authorization', `Bearer ${tokenGestor}`)
        .send({
          nome: 'Mãe Souza',
          email: 'mae.souza@teste.com',
          senha: 'senhaSegura123',
          tipo: 'pai',
          telefone: '11999990002'
        });
      expect(resP2.status).toBe(201);

      const [pRows2] = await dbPromise.query('SELECT p.id, u.id AS user_id FROM pais p JOIN usuarios u ON u.id = p.usuario_id WHERE u.email = "mae.souza@teste.com"');
      recordPai2 = pRows2[0].id;
      idUserPai2 = pRows2[0].user_id;
    });

    it('deve permitir ao gestor cadastrar professores com disciplina', async () => {
      const resProf1 = await request(app)
        .post('/api/cadastro')
        .set('Authorization', `Bearer ${tokenGestor}`)
        .send({
          nome: 'Prof Matemática',
          email: 'prof.mat@teste.com',
          senha: 'senhaSegura123',
          tipo: 'professor',
          disciplina: 'Matemática'
        });
      expect(resProf1.status).toBe(201);

      const [profRows1] = await dbPromise.query('SELECT p.id, u.id AS user_id FROM professores p JOIN usuarios u ON u.id = p.usuario_id WHERE u.email = "prof.mat@teste.com"');
      recordProf1 = profRows1[0].id;
      idUserProf1 = profRows1[0].user_id;

      const resProf2 = await request(app)
        .post('/api/cadastro')
        .set('Authorization', `Bearer ${tokenGestor}`)
        .send({
          nome: 'Prof História',
          email: 'prof.hist@teste.com',
          senha: 'senhaSegura123',
          tipo: 'professor',
          disciplina: 'História'
        });
      expect(resProf2.status).toBe(201);

      const [profRows2] = await dbPromise.query('SELECT p.id, u.id AS user_id FROM professores p JOIN usuarios u ON u.id = p.usuario_id WHERE u.email = "prof.hist@teste.com"');
      recordProf2 = profRows2[0].id;
      idUserProf2 = profRows2[0].user_id;

      // Vincular Prof 1 à Turma 1
      await dbPromise.query('INSERT INTO professor_turma (professor_id, turma_id) VALUES (?, ?)', [recordProf1, idTurma1]);
      // Vincular Prof 2 à Turma 2
      await dbPromise.query('INSERT INTO professor_turma (professor_id, turma_id) VALUES (?, ?)', [recordProf2, idTurma2]);
    });

    it('deve permitir ao gestor cadastrar alunos vinculados a pais e turmas', async () => {
      const resA1 = await request(app)
        .post('/api/cadastro')
        .set('Authorization', `Bearer ${tokenGestor}`)
        .send({
          nome: 'Aluno Lucas Silva',
          email: 'aluno.lucas@teste.com',
          senha: 'senhaSegura123',
          tipo: 'aluno',
          pai_id: recordPai1,
          turma_id: idTurma1
        });
      expect(resA1.status).toBe(201);

      const [aRows1] = await dbPromise.query('SELECT a.id, u.id AS user_id FROM alunos a JOIN usuarios u ON u.id = a.usuario_id WHERE u.email = "aluno.lucas@teste.com"');
      recordAluno1 = aRows1[0].id;
      idUserAluno1 = aRows1[0].user_id;

      const resA2 = await request(app)
        .post('/api/cadastro')
        .set('Authorization', `Bearer ${tokenGestor}`)
        .send({
          nome: 'Aluna Beatriz Souza',
          email: 'aluna.beatriz@teste.com',
          senha: 'senhaSegura123',
          tipo: 'aluno',
          pai_id: recordPai2,
          turma_id: idTurma2
        });
      expect(resA2.status).toBe(201);

      const [aRows2] = await dbPromise.query('SELECT a.id, u.id AS user_id FROM alunos a JOIN usuarios u ON u.id = a.usuario_id WHERE u.email = "aluna.beatriz@teste.com"');
      recordAluno2 = aRows2[0].id;
      idUserAluno2 = aRows2[0].user_id;
    });

    it('deve obter tokens para todos os atores criados', async () => {
      const login = async (email) => {
        const res = await request(app).post('/api/login').send({ email, senha: 'senhaSegura123' });
        return res.body.dados?.accessToken;
      };

      tokenProfessor1 = await login('prof.mat@teste.com');
      tokenProfessor2 = await login('prof.hist@teste.com');
      tokenPai1 = await login('pai.silva@teste.com');
      tokenPai2 = await login('mae.souza@teste.com');
      tokenAluno1 = await login('aluno.lucas@teste.com');
      tokenAluno2 = await login('aluna.beatriz@teste.com');

      expect(tokenProfessor1).toBeTruthy();
      expect(tokenPai1).toBeTruthy();
      expect(tokenAluno1).toBeTruthy();
    });

    // Testes negativos de cadastro
    it('negativo: não deve permitir cadastro com e-mail duplicado', async () => {
      const res = await request(app)
        .post('/api/cadastro')
        .set('Authorization', `Bearer ${tokenGestor}`)
        .send({
          nome: 'Duplicado',
          email: 'aluno.lucas@teste.com',
          senha: 'senhaSegura123',
          tipo: 'pai'
        });
      expect(res.status).toBe(400);
      expect(res.body.erro).toMatch(/já está cadastrado/);
    });

    it('negativo: não deve permitir cadastro de aluno sem pai_id ou turma_id', async () => {
      const resSemPai = await request(app)
        .post('/api/cadastro')
        .set('Authorization', `Bearer ${tokenGestor}`)
        .send({
          nome: 'Aluno Sem Pai',
          email: 'aluno.sempai@teste.com',
          senha: 'senhaSegura123',
          tipo: 'aluno',
          turma_id: idTurma1
        });
      expect(resSemPai.status).toBe(400);

      const resSemTurma = await request(app)
        .post('/api/cadastro')
        .set('Authorization', `Bearer ${tokenGestor}`)
        .send({
          nome: 'Aluno Sem Turma',
          email: 'aluno.semturma@teste.com',
          senha: 'senhaSegura123',
          tipo: 'aluno',
          pai_id: recordPai1
        });
      expect(resSemTurma.status).toBe(400);
    });

    it('negativo: usuários sem perfil gestor não podem cadastrar outros usuários (RBAC)', async () => {
      const resProf = await request(app)
        .post('/api/cadastro')
        .set('Authorization', `Bearer ${tokenProfessor1}`)
        .send({ nome: 'Hacker', email: 'hacker@teste.com', senha: '123456', tipo: 'gestor' });
      expect(resProf.status).toBe(403);

      const resAluno = await request(app)
        .post('/api/cadastro')
        .set('Authorization', `Bearer ${tokenAluno1}`)
        .send({ nome: 'Hacker', email: 'hacker@teste.com', senha: '123456', tipo: 'gestor' });
      expect(resAluno.status).toBe(403);
    });
  });

  // ============================================================
  // RF-002 — Gestão de Turmas (CRUD)
  // ============================================================
  describe('RF-002 — Gerenciamento de Turmas (CRUD)', () => {
    it('gestor deve listar turmas cadastradas', async () => {
      const res = await request(app).get('/api/turmas').set('Authorization', `Bearer ${tokenGestor}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.dados)).toBe(true);
      expect(res.body.dados.length).toBeGreaterThanOrEqual(2);
    });

    it('gestor deve buscar turma por id', async () => {
      const res = await request(app).get(`/api/turmas/${idTurma1}`).set('Authorization', `Bearer ${tokenGestor}`);
      expect(res.status).toBe(200);
      expect(res.body.dados.nome).toBe('7º Ano A');
    });

    it('gestor deve atualizar informações da turma', async () => {
      const res = await request(app)
        .put(`/api/turmas/${idTurma1}`)
        .set('Authorization', `Bearer ${tokenGestor}`)
        .send({ nome: '7º Ano A - Atualizado', ano: 2026, turno: 'matutino', ativa: 1 });
      expect(res.status).toBe(200);
      expect(res.body.sucesso).toBe(true);
    });

    it('professor só deve ver as turmas às quais está vinculado', async () => {
      const resProf1 = await request(app).get('/api/turmas').set('Authorization', `Bearer ${tokenProfessor1}`);
      expect(resProf1.status).toBe(200);
      expect(resProf1.body.dados.length).toBe(1);
      expect(resProf1.body.dados[0].id).toBe(idTurma1);
    });

    it('negativo: aluno e pai não têm autorização para acessar /api/turmas (RBAC)', async () => {
      const resA = await request(app).get('/api/turmas').set('Authorization', `Bearer ${tokenAluno1}`);
      expect(resA.status).toBe(403);

      const resP = await request(app).get('/api/turmas').set('Authorization', `Bearer ${tokenPai1}`);
      expect(resP.status).toBe(403);
    });
  });

  // ============================================================
  // RF-002 & RF-004 — Registro de Presença em Lote & Notificação
  // ============================================================
  describe('RF-002 & RF-004 — Registro de Presença e Agendamento de Notificação', () => {
    it('professor deve registrar chamada em lote para sua turma', async () => {
      const payload = {
        turma_id: idTurma1,
        data: '2026-10-15',
        presencas: [
          { aluno_id: recordAluno1, status: 'falta' }
        ]
      };
      const res = await request(app)
        .post('/api/registrar-presenca-turma')
        .set('Authorization', `Bearer ${tokenProfessor1}`)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.sucesso).toBe(true);

      // Checa notificação in-app na tabela notificacoes
      const [notifs] = await dbPromise.query('SELECT * FROM notificacoes WHERE usuario_id = ?', [idUserPai1]);
      expect(notifs.length).toBeGreaterThanOrEqual(1);
      expect(notifs[0].mensagem).toMatch(/FALTA/);

      // Checa agendamento assíncrono na tabela email_jobs (Outbox)
      const [jobs] = await dbPromise.query('SELECT * FROM email_jobs WHERE aluno_id = ? AND data_referencia = ?', [recordAluno1, '2026-10-15']);
      expect(jobs.length).toBe(1);
      expect(jobs[0].status).toBe('PENDING');
      expect(jobs[0].destinatario).toBe('pai.silva@teste.com');
    });
  });

  // ============================================================
  // RF-003, RF-005 & Proteção IDOR / BOLA
  // ============================================================
  describe('RF-003, RF-005 & Blindagem contra IDOR / BOLA', () => {
    it('limita a lista e o total de alunos às turmas do professor', async () => {
      const listar = token => request(app).get('/api/alunos?limit=1')
        .set('Authorization', `Bearer ${token}`).expect(200);
      for (const [token, aluno] of [[tokenProfessor1, recordAluno1], [tokenProfessor2, recordAluno2]]) {
        const { body } = await listar(token);
        expect(body.dados.meta.total).toBe(1);
        expect(body.dados.dados.map(r => r.id)).toEqual([aluno]);
      }
      expect((await listar(tokenGestor)).body.dados.meta.total).toBe(2);
    });
    it('aluno 1 deve consultar com sucesso seu próprio histórico', async () => {
      const res = await request(app)
        .get(`/api/presencas/${idUserAluno1}`)
        .set('Authorization', `Bearer ${tokenAluno1}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.dados)).toBe(true);
      expect(res.body.dados.length).toBe(1);
      expect(res.body.dados[0].status).toBe('falta');
    });

    it('IDOR TEST: aluno 1 NÃO DEVE acessar histórico do aluno 2 (deve retornar 403 Forbidden)', async () => {
      const res = await request(app)
        .get(`/api/presencas/${idUserAluno2}`)
        .set('Authorization', `Bearer ${tokenAluno1}`);
      expect(res.status).toBe(403);
      expect(res.body.erro).toMatch(/Você só pode consultar seu próprio histórico/);
    });

    it('pai 1 deve consultar com sucesso a frequência de seus próprios filhos', async () => {
      const res = await request(app)
        .get(`/api/presencas-filho/${idUserPai1}`)
        .set('Authorization', `Bearer ${tokenPai1}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.dados)).toBe(true);
      expect(res.body.dados.length).toBe(1);
      expect(res.body.dados[0].aluno).toBe('Aluno Lucas Silva');
    });

    it('IDOR TEST: pai 1 NÃO DEVE acessar histórico de filhos do pai 2 (deve retornar 403 Forbidden)', async () => {
      const res = await request(app)
        .get(`/api/presencas-filho/${idUserPai2}`)
        .set('Authorization', `Bearer ${tokenPai1}`);
      expect(res.status).toBe(403);
      expect(res.body.erro).toMatch(/Você só pode consultar os próprios filhos/);
    });

    it('professor 1 só pode consultar histórico de alunos de suas turmas (403 para outras turmas)', async () => {
      // Aluno 1 está na Turma 1 (Prof 1) -> deve conseguir
      const resPermitido = await request(app)
        .get(`/api/presencas/${idUserAluno1}`)
        .set('Authorization', `Bearer ${tokenProfessor1}`);
      expect(resPermitido.status).toBe(200);

      // Aluno 2 está na Turma 2 (Prof 2) -> Prof 1 não pode ver
      const resBloqueado = await request(app)
        .get(`/api/presencas/${idUserAluno2}`)
        .set('Authorization', `Bearer ${tokenProfessor1}`);
      expect(resBloqueado.status).toBe(403);
      expect(resBloqueado.body.erro).toMatch(/Este aluno não pertence às suas turmas/);
    });

    it('gestor tem permissão irrestrita para auditar qualquer aluno', async () => {
      const res = await request(app)
        .get(`/api/presencas/${idUserAluno1}`)
        .set('Authorization', `Bearer ${tokenGestor}`);
      expect(res.status).toBe(200);
    });
  });

  // ============================================================
  // RF-006 — Relatórios de Frequência
  // ============================================================
  describe('RF-006 — Emissão e Consulta de Relatórios de Frequência', () => {
    it('gestor deve visualizar relatório geral consolidado', async () => {
      const res = await request(app)
        .get('/api/relatorio-frequencia')
        .set('Authorization', `Bearer ${tokenGestor}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.dados)).toBe(true);
      const relAluno1 = res.body.dados.find(r => r.aluno === 'Aluno Lucas Silva');
      expect(relAluno1).toBeDefined();
      expect(relAluno1.faltas).toBe(1);
    });

    it('professor deve visualizar relatório filtrado para seus alunos', async () => {
      const res = await request(app)
        .get('/api/relatorio-frequencia')
        .set('Authorization', `Bearer ${tokenProfessor1}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.dados)).toBe(true);
      expect(res.body.dados.length).toBe(1);
      expect(res.body.dados[0].aluno).toBe('Aluno Lucas Silva');
    });

    it('negativo: aluno não pode acessar relatório geral de frequência (RBAC)', async () => {
      const res = await request(app)
        .get('/api/relatorio-frequencia')
        .set('Authorization', `Bearer ${tokenAluno1}`);
      expect(res.status).toBe(403);
    });
  });

  // ============================================================
  // Sessão: Renovação e Encerramento
  // ============================================================
  describe('Sessão: Renovação via Refresh Token e Logout', () => {
    it('deve renovar Access Token com sucesso a partir de Refresh Token válido', async () => {
      const res = await request(app)
        .post('/api/refresh-token')
        .send({ refreshToken: refreshTokenGestor });
      expect(res.status).toBe(200);
      expect(res.body.sucesso).toBe(true);
      expect(res.body.dados.accessToken).toBeTruthy();
    });

    it('deve rejeitar renovação com refresh token inválido', async () => {
      const res = await request(app)
        .post('/api/refresh-token')
        .send({ refreshToken: 'token.invalido.123' });
      expect(res.status).toBe(401);
    });

    it('deve encerrar sessão via logout e invalidar o refresh token no banco', async () => {
      const resLogout = await request(app)
        .post('/api/logout')
        .send({ refreshToken: refreshTokenGestor });
      expect(resLogout.status).toBe(200);

      // Verificar imediatamente (revogação síncrona via await) que o refresh_token foi setado como NULL
      const [uRows] = await dbPromise.query('SELECT refresh_token FROM usuarios WHERE id = ?', [idUserGestor]);
      expect(uRows[0].refresh_token).toBeNull();

      // Tentativa subsequente de renovar com o token antigo deve falhar
      const resRetry = await request(app)
        .post('/api/refresh-token')
        .send({ refreshToken: refreshTokenGestor });
      expect(resRetry.status).toBe(401);
    });
  });
});
