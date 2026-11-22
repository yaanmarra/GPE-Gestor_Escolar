const request = require('supertest');
const { app } = require('../server');
const { dbPromise, validarBancoDeTeste } = require('../src/config/database');
const { garantirSchemaPortfolio } = require('../src/config/portfolioSchema');
const nodemailer = require('nodemailer');
const { iniciarWorker, pararWorker } = require('../src/workers/emailWorker');

// Mock do nodemailer
jest.mock('nodemailer', () => {
  const sendMailMock = jest.fn().mockResolvedValue({ messageId: '123' });
  return {
    createTransport: jest.fn().mockReturnValue({ sendMail: sendMailMock, close: jest.fn() }),
    _sendMailMock: sendMailMock, // Exportando mock para verificação
  };
});

describe('FASE 6 - Testes Automatizados (Supertest) e Regressão TC-39', () => {
  let tokenGestor, tokenProfessor, tokenPai, tokenAluno;
  let idAluno, idPai, idProfessor, idGestor, idTurma, idPaiRecord;

  beforeAll(async () => {
    // 0. Trava programática obrigatória: garante execução exclusiva em banco de teste (gpe_test)
    await validarBancoDeTeste(dbPromise);
    await garantirSchemaPortfolio(dbPromise);

    // Garante colunas e tabelas da Entrega 4 para testar integração de retificação com whatsapp_jobs
    const [cols] = await dbPromise.query("SHOW COLUMNS FROM pais LIKE 'telefone_e164'");
    if (cols.length === 0) {
      await dbPromise.query(`
        ALTER TABLE pais
          ADD COLUMN telefone_e164         VARCHAR(16) NULL,
          ADD COLUMN whatsapp_optin        TINYINT(1)  NOT NULL DEFAULT 0,
          ADD COLUMN whatsapp_optin_em     DATETIME    NULL,
          ADD COLUMN whatsapp_optin_origem VARCHAR(30) NULL,
          ADD COLUMN whatsapp_optout_em    DATETIME    NULL,
          ADD KEY idx_pais_telefone_e164 (telefone_e164)
      `);
    }
    await dbPromise.query(`
      CREATE TABLE IF NOT EXISTS notificacao_preferencias (
        pai_id INT NOT NULL,
        tipo   VARCHAR(40) NOT NULL,
        canal  ENUM('email','whatsapp') NOT NULL,
        ativo  TINYINT(1) NOT NULL DEFAULT 1,
        atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (pai_id, tipo, canal)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
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

    // 1. Limpar banco para testes limpos
    await dbPromise.query('SET FOREIGN_KEY_CHECKS = 0');
    await dbPromise.query('TRUNCATE TABLE presencas');
    await dbPromise.query('TRUNCATE TABLE whatsapp_jobs');
    await dbPromise.query('TRUNCATE TABLE email_jobs');
    await dbPromise.query('TRUNCATE TABLE notificacoes');
    await dbPromise.query('TRUNCATE TABLE professor_turma');
    await dbPromise.query('TRUNCATE TABLE turmas');
    await dbPromise.query('TRUNCATE TABLE alunos');
    await dbPromise.query('TRUNCATE TABLE pais');
    await dbPromise.query('TRUNCATE TABLE professores');
    await dbPromise.query('TRUNCATE TABLE usuarios');
    await dbPromise.query('SET FOREIGN_KEY_CHECKS = 1');

    // 2. Criar massa de dados mínima e pegar tokens
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('123456', 1); // Rápido para testes

    // Gestor
    const [resG] = await dbPromise.query('INSERT INTO usuarios (nome, email, senha, tipo) VALUES ("Gestor", "gestor@test.com", ?, "gestor")', [hash]);
    idGestor = resG.insertId;

    // Pai
    const [resP] = await dbPromise.query('INSERT INTO usuarios (nome, email, senha, tipo) VALUES ("Pai", "pai@test.com", ?, "pai")', [hash]);
    idPai = resP.insertId;
    await dbPromise.query(
      'INSERT INTO pais (usuario_id, telefone, telefone_e164, whatsapp_optin, whatsapp_optin_em, whatsapp_optin_origem) VALUES (?, "11999990000", "+5511999990000", 1, NOW(), "painel_pais")',
      [idPai]
    );
    const [resPaiDB] = await dbPromise.query('SELECT id FROM pais WHERE usuario_id = ?', [idPai]);
    const paiRecordId = resPaiDB[0].id;
    idPaiRecord = paiRecordId;

    // Professor
    const [resProf] = await dbPromise.query('INSERT INTO usuarios (nome, email, senha, tipo) VALUES ("Prof", "prof@test.com", ?, "professor")', [hash]);
    idProfessor = resProf.insertId;
    await dbPromise.query('INSERT INTO professores (usuario_id, disciplina) VALUES (?, "Mat")', [idProfessor]);
    const [resProfDB] = await dbPromise.query('SELECT id FROM professores WHERE usuario_id = ?', [idProfessor]);
    const profRecordId = resProfDB[0].id;

    // Turma
    const [resT] = await dbPromise.query('INSERT INTO turmas (nome, ano, turno) VALUES ("Turma A", 2026, "matutino")');
    idTurma = resT.insertId;
    await dbPromise.query('INSERT INTO professor_turma (professor_id, turma_id) VALUES (?, ?)', [profRecordId, idTurma]);

    // Aluno
    const [resA] = await dbPromise.query('INSERT INTO usuarios (nome, email, senha, tipo) VALUES ("Aluno", "aluno@test.com", ?, "aluno")', [hash]);
    idAluno = resA.insertId;
    await dbPromise.query('INSERT INTO alunos (usuario_id, pai_id, turma_id) VALUES (?, ?, ?)', [idAluno, paiRecordId, idTurma]);
    const [resAlunoDB] = await dbPromise.query('SELECT id FROM alunos WHERE usuario_id = ?', [idAluno]);
    const alunoRecordId = resAlunoDB[0].id;

    // Login functions
    const login = async (email) => {
      const res = await request(app).post('/api/login').send({ email, senha: '123456' });
      return res.body.dados?.accessToken;
    };

    tokenGestor = await login('gestor@test.com');
    tokenPai = await login('pai@test.com');
    tokenProfessor = await login('prof@test.com');
    tokenAluno = await login('aluno@test.com');

    // Substituir idAluno com o Record ID para uso na presença
    idAluno = alunoRecordId;
    idProfessor = profRecordId;
  });

  afterAll(async () => {
    await dbPromise.end();
  });

  describe('AUTENTICAÇÃO', () => {
    it('sem token', async () => {
      const res = await request(app).get('/api/usuarios');
      expect(res.status).toBe(401);
      expect(res.body.erro).toMatch(/Token de autenticação não fornecido/);
    });

    it('token inválido', async () => {
      const res = await request(app).get('/api/usuarios').set('Authorization', 'Bearer invalidtoken123');
      expect(res.status).toBe(401);
      expect(res.body.erro).toMatch(/Token inválido/);
    });
  });

  describe('AUTORIZAÇÃO', () => {
    it('papel incorreto (aluno tentando listar usuarios)', async () => {
      const res = await request(app).get('/api/usuarios').set('Authorization', `Bearer ${tokenAluno}`);
      expect(res.status).toBe(403);
      expect(res.body.erro).toMatch(/Acesso negado/);
    });

    it('gestor tem acesso irrestrito', async () => {
      const res = await request(app).get('/api/usuarios').set('Authorization', `Bearer ${tokenGestor}`);
      expect(res.status).toBe(200);
    });
    
    it('professor A x turma B', async () => {
      const [resTB] = await dbPromise.query('INSERT INTO turmas (nome, ano, turno) VALUES ("Turma B", 2026, "matutino")');
      const turmaBId = resTB.insertId;

      const res = await request(app).get(`/api/turmas/${turmaBId}/alunos`).set('Authorization', `Bearer ${tokenProfessor}`);
      expect(res.status).toBe(403);
      expect(res.body.erro).toMatch(/Esta turma não está vinculada a você/);
    });
  });

  describe('PRESENÇA E OUTBOX E IDEMPOTÊNCIA (SUÍTE DE REGRESSÃO TC-39)', () => {
    it('TC-39-01: Primeiro registro individual de presença (presente) -> HTTP 200 e 1 linha em presencas', async () => {
      const dataRef = '2026-10-01';
      const payload = { aluno_id: idAluno, data: dataRef, status: 'presente' };
      const res = await request(app)
        .post('/api/registrar-presenca')
        .set('Authorization', `Bearer ${tokenProfessor}`)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.sucesso).toBe(true);

      const [pres] = await dbPromise.query('SELECT * FROM presencas WHERE aluno_id = ? AND data = ?', [idAluno, dataRef]);
      expect(pres.length).toBe(1);
      expect(pres[0].status).toBe('presente');
      expect(pres[0].professor_id).toBe(idProfessor);
      expect(pres[0].turma_id).toBe(idTurma);

      const [jobs] = await dbPromise.query('SELECT * FROM email_jobs WHERE aluno_id = ? AND data_referencia = ?', [idAluno, dataRef]);
      expect(jobs.length).toBe(0);
    });

    it('TC-39-02: Segundo registro individual idêntico (presente -> presente) -> HTTP 200 sem erro 500 ER_DUP_ENTRY', async () => {
      const dataRef = '2026-10-01';
      const payload = { aluno_id: idAluno, data: dataRef, status: 'presente' };
      const res = await request(app)
        .post('/api/registrar-presenca')
        .set('Authorization', `Bearer ${tokenProfessor}`)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.sucesso).toBe(true);
      expect(res.body.dados.alterado).toBe(false);

      const [pres] = await dbPromise.query('SELECT * FROM presencas WHERE aluno_id = ? AND data = ?', [idAluno, dataRef]);
      expect(pres.length).toBe(1);
      expect(pres[0].status).toBe('presente');
    });

    it('TC-39-04: Alteração individual de presente para falta -> HTTP 200, status atualizado e notificação/job criados', async () => {
      const dataRef = '2026-10-01';
      const payload = { aluno_id: idAluno, data: dataRef, status: 'falta' };
      const res = await request(app)
        .post('/api/registrar-presenca')
        .set('Authorization', `Bearer ${tokenProfessor}`)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.sucesso).toBe(true);
      expect(res.body.dados.alterado).toBe(true);
      expect(res.body.dados.status_anterior).toBe('presente');

      const [pres] = await dbPromise.query('SELECT * FROM presencas WHERE aluno_id = ? AND data = ?', [idAluno, dataRef]);
      expect(pres.length).toBe(1);
      expect(pres[0].status).toBe('falta');

      const [jobs] = await dbPromise.query('SELECT status FROM email_jobs WHERE aluno_id = ? AND data_referencia = ?', [idAluno, dataRef]);
      expect(jobs.length).toBe(1);
      expect(jobs[0].status).toBe('PENDING');

      const [notifs] = await dbPromise.query('SELECT id FROM notificacoes WHERE usuario_id = ? AND mensagem LIKE ?', [idPai, `%${dataRef}%`]);
      expect(notifs.length).toBe(1);
    });

    it('TC-39-05: Registro individual de falta repetido (falta -> falta) -> HTTP 200 sem duplicar presencas, notificacoes ou jobs', async () => {
      const dataRef = '2026-10-01';
      const payload = { aluno_id: idAluno, data: dataRef, status: 'falta' };
      const res = await request(app)
        .post('/api/registrar-presenca')
        .set('Authorization', `Bearer ${tokenProfessor}`)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.sucesso).toBe(true);
      expect(res.body.dados.alterado).toBe(false);

      const [pres] = await dbPromise.query('SELECT id FROM presencas WHERE aluno_id = ? AND data = ?', [idAluno, dataRef]);
      expect(pres.length).toBe(1);

      const [jobs] = await dbPromise.query('SELECT id FROM email_jobs WHERE aluno_id = ? AND data_referencia = ?', [idAluno, dataRef]);
      expect(jobs.length).toBe(1);

      const [notifs] = await dbPromise.query('SELECT id FROM notificacoes WHERE usuario_id = ? AND mensagem LIKE ?', [idPai, `%${dataRef}%`]);
      expect(notifs.length).toBe(1);
    });

    it('TC-39-03 & TC-39-06: Retificação individual de falta para presente/justificado cancela jobs pendentes (email_jobs e whatsapp_jobs) e preserva SENT', async () => {
      const dataRef = '2026-10-01';
      // Simula também um job pendente em whatsapp_jobs para a mesma data
      await dbPromise.query(
        `INSERT INTO whatsapp_jobs (usuario_id, aluno_id, destinatario, template, variaveis, mensagem, tipo_notificacao, data_referencia, status)
         VALUES (?, ?, '+5511999990000', 'aviso_falta', '{}', 'Teste WA', 'falta', ?, 'PENDING')
         ON DUPLICATE KEY UPDATE status = 'PENDING'`,
        [idPai, idAluno, dataRef]
      );

      // Retifica de falta para presente
      const resRetif = await request(app)
        .post('/api/registrar-presenca')
        .set('Authorization', `Bearer ${tokenProfessor}`)
        .send({ aluno_id: idAluno, data: dataRef, status: 'presente' });

      expect(resRetif.status).toBe(200);
      expect(resRetif.body.sucesso).toBe(true);
      expect(resRetif.body.dados.alterado).toBe(true);

      const [pres] = await dbPromise.query('SELECT status FROM presencas WHERE aluno_id = ? AND data = ?', [idAluno, dataRef]);
      expect(pres.length).toBe(1);
      expect(pres[0].status).toBe('presente');

      // Verifica cancelamento em email_jobs e whatsapp_jobs
      const [eJobs] = await dbPromise.query('SELECT status, ultimo_erro FROM email_jobs WHERE aluno_id = ? AND data_referencia = ?', [idAluno, dataRef]);
      expect(eJobs.length).toBe(1);
      expect(eJobs[0].status).toBe('FAILED');
      expect(eJobs[0].ultimo_erro).toBe('Presença corrigida antes do envio');

      const [wJobs] = await dbPromise.query('SELECT status, ultimo_erro FROM whatsapp_jobs WHERE aluno_id = ? AND data_referencia = ?', [idAluno, dataRef]);
      expect(wJobs.length).toBe(1);
      expect(wJobs[0].status).toBe('CANCELLED');
      expect(wJobs[0].ultimo_erro).toBe('Presença corrigida antes do envio');

      // Caso D: Se voltar para falta novamente no mesmo dia, reativa email_jobs para PENDING sem duplicar linha
      const resReverterParaFalta = await request(app)
        .post('/api/registrar-presenca')
        .set('Authorization', `Bearer ${tokenProfessor}`)
        .send({ aluno_id: idAluno, data: dataRef, status: 'falta' });
      expect(resReverterParaFalta.status).toBe(200);

      const [eJobsReativados] = await dbPromise.query('SELECT status, ultimo_erro FROM email_jobs WHERE aluno_id = ? AND data_referencia = ?', [idAluno, dataRef]);
      expect(eJobsReativados.length).toBe(1);
      expect(eJobsReativados[0].status).toBe('PENDING');
      expect(eJobsReativados[0].ultimo_erro).toBeNull();

      // Verifica que um job já enviado (SENT) NUNCA é alterado caso haja retificação posterior
      await dbPromise.query("UPDATE email_jobs SET status = 'SENT', ultimo_erro = NULL WHERE aluno_id = ? AND data_referencia = ?", [idAluno, dataRef]);
      await dbPromise.query("UPDATE whatsapp_jobs SET status = 'SENT', ultimo_erro = NULL WHERE aluno_id = ? AND data_referencia = ?", [idAluno, dataRef]);

      const resJustificado = await request(app)
        .post('/api/registrar-presenca')
        .set('Authorization', `Bearer ${tokenProfessor}`)
        .send({ aluno_id: idAluno, data: dataRef, status: 'justificado' });
      expect(resJustificado.status).toBe(200);

      const [eJobSent] = await dbPromise.query('SELECT status FROM email_jobs WHERE aluno_id = ? AND data_referencia = ?', [idAluno, dataRef]);
      expect(eJobSent[0].status).toBe('SENT');

      const [wJobSent] = await dbPromise.query('SELECT status FROM whatsapp_jobs WHERE aluno_id = ? AND data_referencia = ?', [idAluno, dataRef]);
      expect(wJobSent[0].status).toBe('SENT');
    });

    it('TC-39-07: Duas requisições simultâneas (Promise.all) para o mesmo aluno e data -> ambas HTTP 200 e 1 único registro', async () => {
      const dataRef = '2026-10-03';
      const payload = { aluno_id: idAluno, data: dataRef, status: 'falta' };

      const [res1, res2] = await Promise.all([
        request(app).post('/api/registrar-presenca').set('Authorization', `Bearer ${tokenProfessor}`).send(payload),
        request(app).post('/api/registrar-presenca').set('Authorization', `Bearer ${tokenProfessor}`).send(payload)
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      const [pres] = await dbPromise.query('SELECT * FROM presencas WHERE aluno_id = ? AND data = ?', [idAluno, dataRef]);
      expect(pres.length).toBe(1);
      expect(pres[0].status).toBe('falta');

      const [jobs] = await dbPromise.query('SELECT * FROM email_jobs WHERE aluno_id = ? AND data_referencia = ?', [idAluno, dataRef]);
      expect(jobs.length).toBe(1);
    });

    it('TC-39-08: Consistência entre registro individual e retificação em lote (e retificação por Gestor)', async () => {
      const dataRef = '2026-10-02';
      // 1. Registro inicial em lote como falta
      const payloadLoteFalta = {
        turma_id: idTurma,
        data: dataRef,
        presencas: [{ aluno_id: idAluno, status: 'falta' }]
      };
      const res1 = await request(app)
        .post('/api/registrar-presenca-turma')
        .set('Authorization', `Bearer ${tokenProfessor}`)
        .send(payloadLoteFalta);
      expect(res1.status).toBe(200);

      // 2. Repetição idêntica em lote não duplica outbox
      const res2 = await request(app)
        .post('/api/registrar-presenca-turma')
        .set('Authorization', `Bearer ${tokenProfessor}`)
        .send(payloadLoteFalta);
      expect(res2.status).toBe(200);

      const [jobsBefore] = await dbPromise.query('SELECT id, status FROM email_jobs WHERE aluno_id = ? AND data_referencia = ?', [idAluno, dataRef]);
      expect(jobsBefore.length).toBe(1);
      expect(jobsBefore[0].status).toBe('PENDING');

      // 3. Retificação via endpoint individual pelo Gestor (falta -> presente)
      const resGestorRetif = await request(app)
        .post('/api/registrar-presenca')
        .set('Authorization', `Bearer ${tokenGestor}`)
        .send({ aluno_id: idAluno, data: dataRef, status: 'presente' });
      expect(resGestorRetif.status).toBe(200);

      const [presAfterGestor] = await dbPromise.query('SELECT * FROM presencas WHERE aluno_id = ? AND data = ?', [idAluno, dataRef]);
      expect(presAfterGestor.length).toBe(1);
      expect(presAfterGestor[0].status).toBe('presente');
      expect(presAfterGestor[0].professor_id).toBe(idProfessor); // Preservou o professor original sem duplicar linha!

      const [jobsAfterRetif] = await dbPromise.query('SELECT status FROM email_jobs WHERE aluno_id = ? AND data_referencia = ?', [idAluno, dataRef]);
      expect(jobsAfterRetif[0].status).toBe('FAILED');

      // 4. Retificação de volta para falta via lote para que o teste do Worker SMTP processe 2026-10-02
      const res3 = await request(app)
        .post('/api/registrar-presenca-turma')
        .set('Authorization', `Bearer ${tokenProfessor}`)
        .send(payloadLoteFalta);
      expect(res3.status).toBe(200);

      const [jobsReactivated] = await dbPromise.query('SELECT status FROM email_jobs WHERE aluno_id = ? AND data_referencia = ?', [idAluno, dataRef]);
      expect(jobsReactivated.length).toBe(1);
      expect(jobsReactivated[0].status).toBe('PENDING');
    });

    it('TC-39-09: Falha durante a transação faz rollback completo e não deixa presença órfã sem notificação', async () => {
      const dataRef = '2026-10-04';
      const notificacaoService = require('../src/services/notificacaoService');
      const spy = jest.spyOn(notificacaoService, 'registrarFaltas').mockRejectedValueOnce(new Error('Falha simulada no Outbox'));

      const res = await request(app)
        .post('/api/registrar-presenca')
        .set('Authorization', `Bearer ${tokenProfessor}`)
        .send({ aluno_id: idAluno, data: dataRef, status: 'falta' });

      expect(res.status).toBe(500);
      spy.mockRestore();

      // Verifica que o rollback desfez o INSERT em presencas
      const [pres] = await dbPromise.query('SELECT * FROM presencas WHERE aluno_id = ? AND data = ?', [idAluno, dataRef]);
      expect(pres.length).toBe(0);
    });

    it('TC-39-10: Operação não autorizada não altera presença existente nem gera jobs', async () => {
      const dataRef = '2026-10-02';
      // Aluno tenta alterar sua própria falta de 2026-10-02 para presente
      const res = await request(app)
        .post('/api/registrar-presenca')
        .set('Authorization', `Bearer ${tokenAluno}`)
        .send({ aluno_id: idAluno, data: dataRef, status: 'presente' });

      expect(res.status).toBe(403);

      const [pres] = await dbPromise.query('SELECT status FROM presencas WHERE aluno_id = ? AND data = ?', [idAluno, dataRef]);
      expect(pres.length).toBe(1);
      expect(pres[0].status).toBe('falta');
    });
  });

  describe('Chamada por aula e aviso diario', () => {
    beforeAll(() => { jest.replaceProperty(require('../src/config/whatsappConfig'), 'enabled', true); });
    afterAll(() => { jest.restoreAllMocks(); });
    it('preserva o aviso até a correção da última aula com falta', async () => {
      const data = '2026-11-16';
      const horarios = [];
      for (const inicio of ['08:00', '09:00']) {
        const [r] = await dbPromise.query(
          "INSERT INTO grade_horaria (turma_id, professor_id, disciplina, dia_semana, horario_inicio, horario_fim) VALUES (?, ?, 'Mat', 'segunda', ?, ADDTIME(?, '00:45'))",
          [idTurma, idProfessor, inicio, inicio]);
        horarios.push(r.insertId);
      }
      const post = (rota, body) => request(app).post('/api/' + rota)
        .set('Authorization', `Bearer ${tokenProfessor}`).send({ data, ...body }).expect(200);
      const registrar = (grade_horaria_id, status) => post('registrar-presenca', { aluno_id: idAluno, grade_horaria_id, status });
      const fila = async () => {
        const [rows] = await dbPromise.query('SELECT status FROM email_jobs WHERE aluno_id = ? AND data_referencia = ?', [idAluno, data]);
        const [wa] = await dbPromise.query('SELECT status FROM whatsapp_jobs WHERE aluno_id = ? AND data_referencia = ?', [idAluno, data]);
        return [...rows, ...wa].map(r => r.status);
      };
      await post('registrar-presenca-turma', { turma_id: idTurma, presencas: horarios.map(id => ({
        aluno_id: idAluno, status: 'falta', grade_horaria_id: id
      })) });
      await registrar(null, 'presente');
      await registrar(horarios[0], 'justificado');
      expect(await fila()).toEqual(['PENDING', 'PENDING']);
      await registrar(horarios[1], 'presente');
      expect(await fila()).toEqual(['FAILED', 'CANCELLED']);
      await registrar(horarios[0], 'falta');
      expect(await fila()).toEqual(['PENDING', 'PENDING']);
      const { body } = await request(app).get(`/api/presencas-turma?turma_id=${idTurma}&data=${data}&chamada=diaria`)
        .set('Authorization', `Bearer ${tokenProfessor}`).expect(200);
      expect(body.dados).toEqual([{ aluno_id: idAluno, status: 'presente' }]);
    });
  });

  describe('WORKER E SMTP MOCK', () => {
    it('worker processamento (PENDING -> SENT) com mock smtp', async () => {
      await iniciarWorker();
      try {
        await new Promise(r => setTimeout(r, 1000));

        const [jobs] = await dbPromise.query('SELECT status, tentativas FROM email_jobs WHERE data_referencia = ?', ['2026-10-02']);
        expect(jobs.length).toBe(1);
        expect(jobs[0].status).toBe('SENT');
        expect(nodemailer._sendMailMock).toHaveBeenCalled();
      } finally {
        await pararWorker();
      }
    });
  });
});

