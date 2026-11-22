// tests/segurancaAppSec.test.js — Testes de Segurança de Aplicação (AppSec) e Regressão VULN-01
// Executados de forma controlada exclusivamente contra o banco isolado `gpe_test`
const request = require('supertest');
const { app } = require('../server');
const { dbPromise, validarBancoDeTeste } = require('../src/config/database');
const { garantirSchemaPortfolio } = require('../src/config/portfolioSchema');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../src/config/jwt');

// Mock do transporte nodemailer para isolar testes da rede externa
jest.mock('nodemailer', () => {
  const sendMailMock = jest.fn().mockResolvedValue({ messageId: 'sec-mock-123' });
  return {
    createTransport: jest.fn().mockReturnValue({ sendMail: sendMailMock, close: jest.fn() }),
    _sendMailMock: sendMailMock,
  };
});

describe('AUDITORIA TÉCNICA DE SEGURANÇA (AppSec) — PROJETO GPE', () => {
  let tokenGestor, tokenProf1, tokenProf2, tokenProfSemVinculo, tokenProfSemCadastro, tokenPai1, tokenPai2, tokenAluno1, tokenAluno2;
  let idUserProf1, idUserProf2, idUserProfSemVinculo, idUserProfSemCadastro, idUserAluno1, idUserAluno2, idUserPai1, idUserPai2;
  let recProf1, recProf2, recProfSemVinculo, recAluno1, recAluno2, recPai1, recPai2;
  let idTurma1, idTurma2;
  let refreshGestor, refreshProf1;

  beforeAll(async () => {
    // 0. Trava programática obrigatória: garante execução exclusiva em banco de teste (gpe_test)
    await validarBancoDeTeste(dbPromise);
    await garantirSchemaPortfolio(dbPromise);

    // Garante que a tabela whatsapp_jobs exista no banco de teste para verificação de efeitos colaterais
    await dbPromise.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_jobs (
        id INT NOT NULL AUTO_INCREMENT,
        usuario_id INT NOT NULL,
        aluno_id   INT NOT NULL,
        destinatario VARCHAR(16) NOT NULL,
        template  VARCHAR(60) NOT NULL,
        variaveis JSON NOT NULL,
        mensagem  TEXT NOT NULL,
        tipo_notificacao VARCHAR(50) NOT NULL DEFAULT 'falta',
        data_referencia  DATE NOT NULL,
        status ENUM('PENDING','PROCESSING','RETRY','SENT','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING',
        tentativas     INT NOT NULL DEFAULT 0,
        max_tentativas INT NOT NULL DEFAULT 5,
        ultimo_erro TEXT DEFAULT NULL,
        criado_em     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processado_em DATETIME DEFAULT NULL,
        proxima_tentativa_em DATETIME DEFAULT NULL,
        enviar_apos   DATETIME DEFAULT NULL,
        provider        VARCHAR(20)  DEFAULT NULL,
        provider_msg_id VARCHAR(128) DEFAULT NULL,
        status_entrega ENUM('sent','delivered','read','failed') DEFAULT NULL,
        entregue_em DATETIME DEFAULT NULL,
        lido_em     DATETIME DEFAULT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_wa_jobs_idempotencia (aluno_id, tipo_notificacao, data_referencia)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // 1. Limpeza do banco de teste
    await dbPromise.query('SET FOREIGN_KEY_CHECKS = 0');
    await dbPromise.query('TRUNCATE TABLE justificativas');
    await dbPromise.query('TRUNCATE TABLE whatsapp_jobs');
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

    // 2. Setup de Usuários Sintéticos
    // Gestor
    await dbPromise.query('INSERT INTO usuarios (nome, email, senha, tipo) VALUES ("Gestor Sec", "gestor.sec@teste.com", ?, "gestor")', [hash]);
    
    // Pais
    const [uP1] = await dbPromise.query('INSERT INTO usuarios (nome, email, senha, tipo) VALUES ("Pai 1", "pai1.sec@teste.com", ?, "pai")', [hash]);
    idUserPai1 = uP1.insertId;
    const [rPai1] = await dbPromise.query('INSERT INTO pais (usuario_id, telefone) VALUES (?, "11988880001")', [idUserPai1]);
    recPai1 = rPai1.insertId;

    const [uP2] = await dbPromise.query('INSERT INTO usuarios (nome, email, senha, tipo) VALUES ("Pai 2", "pai2.sec@teste.com", ?, "pai")', [hash]);
    idUserPai2 = uP2.insertId;
    const [rPai2] = await dbPromise.query('INSERT INTO pais (usuario_id, telefone) VALUES (?, "11988880002")', [idUserPai2]);
    recPai2 = rPai2.insertId;

    // Turmas
    const [t1] = await dbPromise.query('INSERT INTO turmas (nome, ano, turno) VALUES ("Turma Alpha", 2026, "matutino")');
    idTurma1 = t1.insertId;
    const [t2] = await dbPromise.query('INSERT INTO turmas (nome, ano, turno) VALUES ("Turma Beta", 2026, "vespertino")');
    idTurma2 = t2.insertId;

    // Professores
    // Prof 1 -> vinculado APENAS à Turma Alpha
    const [uPr1] = await dbPromise.query('INSERT INTO usuarios (nome, email, senha, tipo) VALUES ("Prof Alpha", "prof.alpha@teste.com", ?, "professor")', [hash]);
    idUserProf1 = uPr1.insertId;
    const [rPr1] = await dbPromise.query('INSERT INTO professores (usuario_id, disciplina) VALUES (?, "Física")', [idUserProf1]);
    recProf1 = rPr1.insertId;
    await dbPromise.query('INSERT INTO professor_turma (professor_id, turma_id) VALUES (?, ?)', [recProf1, idTurma1]);

    // Prof 2 -> vinculado APENAS à Turma Beta
    const [uPr2] = await dbPromise.query('INSERT INTO usuarios (nome, email, senha, tipo) VALUES ("Prof Beta", "prof.beta@teste.com", ?, "professor")', [hash]);
    idUserProf2 = uPr2.insertId;
    const [rPr2] = await dbPromise.query('INSERT INTO professores (usuario_id, disciplina) VALUES (?, "Química")', [idUserProf2]);
    recProf2 = rPr2.insertId;
    await dbPromise.query('INSERT INTO professor_turma (professor_id, turma_id) VALUES (?, ?)', [recProf2, idTurma2]);

    // Prof Sem Vínculo -> possui registro em `professores`, mas NÃO possui vínculo em `professor_turma`
    const [uPrSV] = await dbPromise.query('INSERT INTO usuarios (nome, email, senha, tipo) VALUES ("Prof Sem Vinculo", "prof.semvinculo@teste.com", ?, "professor")', [hash]);
    idUserProfSemVinculo = uPrSV.insertId;
    const [rPrSV] = await dbPromise.query('INSERT INTO professores (usuario_id, disciplina) VALUES (?, "Biologia")', [idUserProfSemVinculo]);
    recProfSemVinculo = rPrSV.insertId;

    // Prof Sem Cadastro -> usuário com tipo='professor' em `usuarios`, mas SEM linha em `professores`
    const [uPrSC] = await dbPromise.query('INSERT INTO usuarios (nome, email, senha, tipo) VALUES ("Prof Sem Cadastro", "prof.semcadastro@teste.com", ?, "professor")', [hash]);
    idUserProfSemCadastro = uPrSC.insertId;

    // Alunos
    // Aluno 1 -> pertence à Turma Alpha (Filho do Pai 1)
    const [uA1] = await dbPromise.query('INSERT INTO usuarios (nome, email, senha, tipo) VALUES ("Aluno Alpha 1", "aluno.alpha@teste.com", ?, "aluno")', [hash]);
    idUserAluno1 = uA1.insertId;
    const [rA1] = await dbPromise.query('INSERT INTO alunos (usuario_id, pai_id, turma_id) VALUES (?, ?, ?)', [idUserAluno1, recPai1, idTurma1]);
    recAluno1 = rA1.insertId;

    // Aluno 2 -> pertence à Turma Beta (Filho do Pai 2)
    const [uA2] = await dbPromise.query('INSERT INTO usuarios (nome, email, senha, tipo) VALUES ("Aluno Beta 2", "aluno.beta@teste.com", ?, "aluno")', [hash]);
    idUserAluno2 = uA2.insertId;
    const [rA2] = await dbPromise.query('INSERT INTO alunos (usuario_id, pai_id, turma_id) VALUES (?, ?, ?)', [idUserAluno2, recPai2, idTurma2]);
    recAluno2 = rA2.insertId;

    // Login e obtenção de tokens
    const login = async (email) => {
      const res = await request(app).post('/api/login').send({ email, senha: '123456' });
      return res.body.dados;
    };

    const dGestor = await login('gestor.sec@teste.com');
    tokenGestor = dGestor.accessToken;
    refreshGestor = dGestor.refreshToken;

    const dP1 = await login('prof.alpha@teste.com');
    tokenProf1 = dP1.accessToken;
    refreshProf1 = dP1.refreshToken;

    const dP2 = await login('prof.beta@teste.com');
    tokenProf2 = dP2.accessToken;

    const dPSV = await login('prof.semvinculo@teste.com');
    tokenProfSemVinculo = dPSV.accessToken;

    const dPSC = await login('prof.semcadastro@teste.com');
    tokenProfSemCadastro = dPSC.accessToken;

    const dPai1 = await login('pai1.sec@teste.com');
    tokenPai1 = dPai1.accessToken;

    const dPai2 = await login('pai2.sec@teste.com');
    tokenPai2 = dPai2.accessToken;

    const dAl1 = await login('aluno.alpha@teste.com');
    tokenAluno1 = dAl1.accessToken;

    const dAl2 = await login('aluno.beta@teste.com');
    tokenAluno2 = dAl2.accessToken;
  });

  afterAll(async () => {
    await dbPromise.end();
  });

  // ============================================================
  // ETAPA 0 — PROTEÇÃO DO AMBIENTE DE TESTE (gpe_test)
  // ============================================================
  describe('ETAPA 0 — Isolamento e Proteção do Banco de Dados de Teste', () => {
    it('SEC-DB-GUARD-01: validarBancoDeTeste deve abortar se DB_NAME for o banco principal "gpe" ou não contiver "test"', async () => {
      const fakePoolGpe = {
        query: jest.fn().mockResolvedValue([[{ db_atual: 'gpe' }]]),
      };
      await expect(validarBancoDeTeste(fakePoolGpe, { DB_NAME: 'gpe' })).rejects.toThrow(/\[SEGURANÇA DE TESTES\]/);
      await expect(validarBancoDeTeste(fakePoolGpe, { DB_NAME: 'gpe_producao' })).rejects.toThrow(/\[SEGURANÇA DE TESTES\]/);
      await expect(validarBancoDeTeste(fakePoolGpe, { DB_NAME: 'gpe_test' })).rejects.toThrow(/aponta para "gpe"/);
    });
  });

  // ============================================================
  // ETAPA 1 — AUTENTICAÇÃO E SESSÕES
  // ============================================================
  describe('ETAPA 1 — Autenticação, Tokens JWT e Sessão', () => {
    it('SEC-AUTH-01: Rejeição de requisição sem header Authorization (401)', async () => {
      const res = await request(app).get('/api/usuarios');
      expect(res.status).toBe(401);
      expect(res.body.sucesso).toBe(false);
      expect(res.body.erro).toMatch(/Token de autenticação não fornecido/);
    });

    it('SEC-AUTH-02: Rejeição de requisição com esquema de autorização inválido (ex: Basic) (401)', async () => {
      const res = await request(app).get('/api/usuarios').set('Authorization', 'Basic dXNlcjpwYXNz');
      expect(res.status).toBe(401);
      expect(res.body.erro).toMatch(/Token de autenticação não fornecido/);
    });

    it('SEC-AUTH-03: Rejeição de Access Token com assinatura corrompida / adulterada (401)', async () => {
      const tokenCorrompido = tokenProf1.slice(0, -6) + 'ABCDEF';
      const res = await request(app).get('/api/usuarios').set('Authorization', `Bearer ${tokenCorrompido}`);
      expect(res.status).toBe(401);
      expect(res.body.erro).toMatch(/Token inválido/);
    });

    it('SEC-AUTH-04: Rejeição de Access Token expirado com código TOKEN_EXPIRADO (401)', async () => {
      const tokenExpirado = jwt.sign(
        { id: idUserProf1, nome: 'Prof Alpha', tipo: 'professor' },
        JWT_SECRET,
        { expiresIn: '0s' }
      );
      const res = await request(app).get('/api/usuarios').set('Authorization', `Bearer ${tokenExpirado}`);
      expect(res.status).toBe(401);
      expect(res.body.codigo).toBe('TOKEN_EXPIRADO');
      expect(res.body.erro).toMatch(/Token expirado/);
    });

    it('SEC-AUTH-05: Avaliação de Renovação de Access Token via Refresh Token', async () => {
      const res = await request(app).post('/api/refresh-token').send({ refreshToken: refreshProf1 });
      expect(res.status).toBe(200);
      expect(res.body.dados.accessToken).toBeTruthy();

      const [u] = await dbPromise.query('SELECT refresh_token FROM usuarios WHERE id = ?', [idUserProf1]);
      expect(u[0].refresh_token).toBe(refreshProf1);
    });

    it('SEC-AUTH-06: Revogação síncrona no Logout impede renovação imediata posterior (mitigação VULN-02)', async () => {
      const hash = await bcrypt.hash('123456', 1);
      const [resUser] = await dbPromise.query(
        'INSERT INTO usuarios (nome, email, senha, tipo) VALUES ("User Race", "user.race@teste.com", ?, "gestor")',
        [hash]
      );
      const idRaceUser = resUser.insertId;
      const l = await request(app).post('/api/login').send({ email: 'user.race@teste.com', senha: '123456' });
      const rToken = l.body.dados.refreshToken;

      const resLogout = await request(app).post('/api/logout').send({ refreshToken: rToken });
      expect(resLogout.status).toBe(200);

      // Imediatamente após o 200 do logout (sem sleep), o refresh token já deve estar revogado no banco
      const [rows] = await dbPromise.query('SELECT refresh_token FROM usuarios WHERE id = ?', [idRaceUser]);
      expect(rows[0].refresh_token).toBeNull();

      const resRefreshAfter = await request(app).post('/api/refresh-token').send({ refreshToken: rToken });
      expect(resRefreshAfter.status).toBe(401);
    });
  });

  // ============================================================
  // ETAPA 2 — REGRESSÃO DE SEGURANÇA VULN-01 (SEC-REG-01 A SEC-REG-10)
  // ============================================================
  describe('ETAPA 2 — Autorização e Regressão VULN-01 (BOLA / IDOR em Escrita de Presença)', () => {
    /**
     * Helper para validar que nenhuma presença ou notificação indevida foi gravada
     * para um aluno e data específicos após bloqueio HTTP 403/401.
     */
    const verificarAusenciaDeEfeitosColaterais = async (alunoId, dataRef) => {
      const [pres] = await dbPromise.query('SELECT * FROM presencas WHERE aluno_id = ? AND data = ?', [alunoId, dataRef]);
      expect(pres.length).toBe(0);

      const [eJobs] = await dbPromise.query('SELECT * FROM email_jobs WHERE aluno_id = ? AND data_referencia = ?', [alunoId, dataRef]);
      expect(eJobs.length).toBe(0);

      const [wJobs] = await dbPromise.query('SELECT * FROM whatsapp_jobs WHERE aluno_id = ? AND data_referencia = ?', [alunoId, dataRef]);
      expect(wJobs.length).toBe(0);

      const [notifs] = await dbPromise.query('SELECT * FROM notificacoes WHERE mensagem LIKE ?', [`%${dataRef}%`]);
      expect(notifs.length).toBe(0);
    };

    it('SEC-REG-01: Professor vinculado à Turma A registra presença individual de aluno da Turma A -> HTTP 200', async () => {
      const dataRef = '2026-10-10';
      const res = await request(app)
        .post('/api/registrar-presenca')
        .set('Authorization', `Bearer ${tokenProf1}`)
        .send({ aluno_id: recAluno1, data: dataRef, status: 'presente' });

      expect(res.status).toBe(200);
      expect(res.body.sucesso).toBe(true);

      const [reg] = await dbPromise.query('SELECT * FROM presencas WHERE aluno_id = ? AND data = ?', [recAluno1, dataRef]);
      expect(reg.length).toBe(1);
      expect(reg[0].status).toBe('presente');
      expect(reg[0].professor_id).toBe(recProf1);
      expect(reg[0].turma_id).toBe(idTurma1);
    });

    it('SEC-REG-02: Professor vinculado à Turma A tenta registrar presença individual de aluno da Turma B -> HTTP 403', async () => {
      const dataRef = '2026-10-20';
      const res = await request(app)
        .post('/api/registrar-presenca')
        .set('Authorization', `Bearer ${tokenProf1}`)
        .send({ aluno_id: recAluno2, data: dataRef, status: 'falta' });

      expect(res.status).toBe(403);
      expect(res.body.sucesso).toBe(false);
      expect(res.body.erro).toMatch(/Acesso negado/i);

      await verificarAusenciaDeEfeitosColaterais(recAluno2, dataRef);
    });

    it('SEC-REG-03: Professor vinculado à Turma A registra presença em lote da Turma A -> HTTP 200', async () => {
      const dataRef = '2026-10-11';
      const res = await request(app)
        .post('/api/registrar-presenca-turma')
        .set('Authorization', `Bearer ${tokenProf1}`)
        .send({
          turma_id: idTurma1,
          data: dataRef,
          presencas: [{ aluno_id: recAluno1, status: 'presente' }]
        });

      expect(res.status).toBe(200);
      expect(res.body.sucesso).toBe(true);

      const [reg] = await dbPromise.query('SELECT * FROM presencas WHERE aluno_id = ? AND data = ?', [recAluno1, dataRef]);
      expect(reg.length).toBe(1);
      expect(reg[0].status).toBe('presente');
      expect(reg[0].professor_id).toBe(recProf1);
      expect(reg[0].turma_id).toBe(idTurma1);
    });

    it('SEC-REG-04: Professor vinculado à Turma A tenta registrar presença em lote da Turma B -> HTTP 403', async () => {
      const dataRef = '2026-10-21';
      const res = await request(app)
        .post('/api/registrar-presenca-turma')
        .set('Authorization', `Bearer ${tokenProf1}`)
        .send({
          turma_id: idTurma2,
          data: dataRef,
          presencas: [{ aluno_id: recAluno2, status: 'falta' }]
        });

      expect(res.status).toBe(403);
      expect(res.body.sucesso).toBe(false);
      expect(res.body.erro).toMatch(/Acesso negado/i);

      await verificarAusenciaDeEfeitosColaterais(recAluno2, dataRef);
    });

    it('SEC-REG-05: Professor sem vínculo em professor_turma tenta registrar presença -> HTTP 403', async () => {
      const dataRef = '2026-10-22';
      const resInd = await request(app)
        .post('/api/registrar-presenca')
        .set('Authorization', `Bearer ${tokenProfSemVinculo}`)
        .send({ aluno_id: recAluno1, data: dataRef, status: 'falta' });

      expect(resInd.status).toBe(403);
      expect(resInd.body.sucesso).toBe(false);

      const resLote = await request(app)
        .post('/api/registrar-presenca-turma')
        .set('Authorization', `Bearer ${tokenProfSemVinculo}`)
        .send({
          turma_id: idTurma1,
          data: dataRef,
          presencas: [{ aluno_id: recAluno1, status: 'falta' }]
        });

      expect(resLote.status).toBe(403);
      expect(resLote.body.sucesso).toBe(false);

      await verificarAusenciaDeEfeitosColaterais(recAluno1, dataRef);

      // Também valida professor sem linha correspondente na tabela `professores` (sem fallback inseguro!)
      const resSemCad = await request(app)
        .post('/api/registrar-presenca')
        .set('Authorization', `Bearer ${tokenProfSemCadastro}`)
        .send({ aluno_id: recAluno1, data: dataRef, status: 'falta' });

      expect(resSemCad.status).toBe(403);
      expect(resSemCad.body.erro).toMatch(/cadastro de professor não encontrado/i);
      await verificarAusenciaDeEfeitosColaterais(recAluno1, dataRef);
    });

    it('SEC-REG-06: Gestor registra presença em qualquer turma válida -> HTTP 200', async () => {
      const dataRefInd = '2026-10-23';
      const resInd = await request(app)
        .post('/api/registrar-presenca')
        .set('Authorization', `Bearer ${tokenGestor}`)
        .send({ aluno_id: recAluno2, data: dataRefInd, status: 'presente' });

      expect(resInd.status).toBe(200);
      expect(resInd.body.sucesso).toBe(true);

      const dataRefLote = '2026-10-24';
      const resLote = await request(app)
        .post('/api/registrar-presenca-turma')
        .set('Authorization', `Bearer ${tokenGestor}`)
        .send({
          turma_id: idTurma2,
          data: dataRefLote,
          presencas: [{ aluno_id: recAluno2, status: 'justificado' }]
        });

      expect(resLote.status).toBe(200);
      expect(resLote.body.sucesso).toBe(true);
    });

    it('SEC-REG-07: Aluno ou Pai tenta registrar presença -> HTTP 403', async () => {
      const dataRef = '2026-10-25';
      const resAluno = await request(app)
        .post('/api/registrar-presenca')
        .set('Authorization', `Bearer ${tokenAluno1}`)
        .send({ aluno_id: recAluno1, data: dataRef, status: 'presente' });
      expect(resAluno.status).toBe(403);

      const resPai = await request(app)
        .post('/api/registrar-presenca-turma')
        .set('Authorization', `Bearer ${tokenPai1}`)
        .send({
          turma_id: idTurma1,
          data: dataRef,
          presencas: [{ aluno_id: recAluno1, status: 'presente' }]
        });
      expect(resPai.status).toBe(403);

      await verificarAusenciaDeEfeitosColaterais(recAluno1, dataRef);
    });

    it('SEC-REG-08: Requisição sem token tenta registrar presença -> HTTP 401', async () => {
      const dataRef = '2026-10-26';
      const res1 = await request(app)
        .post('/api/registrar-presenca')
        .send({ aluno_id: recAluno1, data: dataRef, status: 'falta' });
      expect(res1.status).toBe(401);

      const res2 = await request(app)
        .post('/api/registrar-presenca-turma')
        .send({
          turma_id: idTurma1,
          data: dataRef,
          presencas: [{ aluno_id: recAluno1, status: 'falta' }]
        });
      expect(res2.status).toBe(401);

      await verificarAusenciaDeEfeitosColaterais(recAluno1, dataRef);
    });

    it('SEC-REG-09: Professor vinculado à Turma A envia lote da Turma A contendo aluno da Turma B -> HTTP 403 (Transação revertida)', async () => {
      const dataRef = '2026-10-27';
      const res = await request(app)
        .post('/api/registrar-presenca-turma')
        .set('Authorization', `Bearer ${tokenProf1}`)
        .send({
          turma_id: idTurma1,
          data: dataRef,
          presencas: [
            { aluno_id: recAluno1, status: 'falta' }, // Aluno legítimo da Turma Alpha
            { aluno_id: recAluno2, status: 'falta' }  // Aluno intruso da Turma Beta
          ]
        });

      expect(res.status).toBe(403);
      expect(res.body.sucesso).toBe(false);

      // Nenhum dos dois alunos pode ter presença ou notificação gravada (atomicidade da transação)
      await verificarAusenciaDeEfeitosColaterais(recAluno1, dataRef);
      await verificarAusenciaDeEfeitosColaterais(recAluno2, dataRef);
    });

    it('SEC-REG-10: Professor tenta falsificar professor_id no body para se passar por outro professor -> HTTP 403', async () => {
      const dataRef = '2026-10-28';
      // Prof 1 tenta passar professor_id = recProf2 para registrar no Aluno 2 (ou até no próprio Aluno 1)
      const resSpoof1 = await request(app)
        .post('/api/registrar-presenca')
        .set('Authorization', `Bearer ${tokenProf1}`)
        .send({
          aluno_id: recAluno1,
          professor_id: recProf2, // falsificando identidade
          data: dataRef,
          status: 'falta'
        });

      expect(resSpoof1.status).toBe(403);
      expect(resSpoof1.body.erro).toMatch(/não é permitido registrar presença em nome de outro professor/i);
      await verificarAusenciaDeEfeitosColaterais(recAluno1, dataRef);

      const resSpoofLote = await request(app)
        .post('/api/registrar-presenca-turma')
        .set('Authorization', `Bearer ${tokenProf1}`)
        .send({
          turma_id: idTurma1,
          professor_id: recProf2, // falsificando identidade no lote
          data: dataRef,
          presencas: [{ aluno_id: recAluno1, status: 'falta' }]
        });

      expect(resSpoofLote.status).toBe(403);
      expect(resSpoofLote.body.erro).toMatch(/não é permitido registrar (presença|chamada) em nome de outro professor/i);
      await verificarAusenciaDeEfeitosColaterais(recAluno1, dataRef);
    });

    it('SEC-REG-11: Gestor não recorre a fallback arbitrário de "primeiro professor" em turma sem docente vinculado -> HTTP 400', async () => {
      const hash = await bcrypt.hash('123456', 1);
      const [tSemProf] = await dbPromise.query('INSERT INTO turmas (nome, ano, turno) VALUES ("Turma Sem Prof", 2026, "noturno")');
      const idTurmaSemProf = tSemProf.insertId;
      const [uAlSemProf] = await dbPromise.query(
        'INSERT INTO usuarios (nome, email, senha, tipo) VALUES ("Aluno Sem Prof", "aluno.semprof@teste.com", ?, "aluno")',
        [hash]
      );
      const [rAlSemProf] = await dbPromise.query(
        'INSERT INTO alunos (usuario_id, pai_id, turma_id) VALUES (?, ?, ?)',
        [uAlSemProf.insertId, recPai1, idTurmaSemProf]
      );
      const recAlunoSemProf = rAlSemProf.insertId;
      const dataRef = '2026-10-29';

      const resInd = await request(app)
        .post('/api/registrar-presenca')
        .set('Authorization', `Bearer ${tokenGestor}`)
        .send({ aluno_id: recAlunoSemProf, data: dataRef, status: 'presente' });
      expect(resInd.status).toBe(400);
      expect(resInd.body.erro).toMatch(/Nenhum professor vinculado/i);

      const resLote = await request(app)
        .post('/api/registrar-presenca-turma')
        .set('Authorization', `Bearer ${tokenGestor}`)
        .send({ turma_id: idTurmaSemProf, data: dataRef, presencas: [{ aluno_id: recAlunoSemProf, status: 'falta' }] });
      expect(resLote.status).toBe(400);
      expect(resLote.body.erro).toMatch(/Nenhum professor vinculado/i);

      await verificarAusenciaDeEfeitosColaterais(recAlunoSemProf, dataRef);
    });

    it('SEC-AUTHZ-04: Pai tentando criar turma (Bloqueio RBAC 403)', async () => {
      const res = await request(app)
        .post('/api/turmas')
        .set('Authorization', `Bearer ${tokenPai1}`)
        .send({ nome: 'Turma Invasora', ano: 2026, turno: 'matutino' });
      expect(res.status).toBe(403);
    });
  });

  // ============================================================
  // ETAPA 4 — BANCO DE DADOS E SQL INJECTION (TESTES CONTROLADOS)
  // ============================================================
  describe('ETAPA 4 — Banco de Dados e SQL Injection', () => {
    it('SEC-SQLI-01: Tentativa de SQL Injection no parâmetro de login', async () => {
      const res = await request(app)
        .post('/api/login')
        .send({ email: "' OR '1'='1", senha: "' OR '1'='1" });

      expect(res.status).toBe(400);
      expect(res.body.erro).toMatch(/Formato de e-mail inválido/);
    });

    it('SEC-SQLI-02: Tentativa de SQL Injection em parâmetros de consulta de presença', async () => {
      const res = await request(app)
        .get(`/api/presencas-turma?turma_id=${idTurma1}' OR '1'='1&data=2026-10-20`)
        .set('Authorization', `Bearer ${tokenProf1}`);

      expect([200, 400, 403]).toContain(res.status);
    });
  });
});

