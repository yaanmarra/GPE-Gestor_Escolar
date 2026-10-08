const request = require('supertest');
const { app } = require('../server');
const { dbPromise } = require('../src/config/database');
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

describe('FASE 6 - Testes Automatizados (Supertest)', () => {
  let tokenGestor, tokenProfessor, tokenPai, tokenAluno;
  let idAluno, idPai, idProfessor, idGestor, idTurma;

  beforeAll(async () => {
    // 1. Limpar banco para testes limpos
    await dbPromise.query('SET FOREIGN_KEY_CHECKS = 0');
    await dbPromise.query('TRUNCATE TABLE presencas');
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
    await dbPromise.query('INSERT INTO pais (usuario_id) VALUES (?)', [idPai]);
    const [resPaiDB] = await dbPromise.query('SELECT id FROM pais WHERE usuario_id = ?', [idPai]);
    const paiRecordId = resPaiDB[0].id;

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
      // Cria uma turma isolada B e tenta listar alunos dela com o Professor A (que só está na A)
      const [resTB] = await dbPromise.query('INSERT INTO turmas (nome, ano, turno) VALUES ("Turma B", 2026, "matutino")');
      const turmaBId = resTB.insertId;

      const res = await request(app).get(`/api/turmas/${turmaBId}/alunos`).set('Authorization', `Bearer ${tokenProfessor}`);
      expect(res.status).toBe(403);
      expect(res.body.erro).toMatch(/Esta turma não está vinculada a você/);
    });
  });

  describe('PRESENÇA E OUTBOX E IDEMPOTÊNCIA', () => {
    it('individual (gera outbox)', async () => {
      const payload = { aluno_id: idAluno, professor_id: idProfessor, data: '2026-10-01', status: 'falta' };
      const res = await request(app).post('/api/registrar-presenca').set('Authorization', `Bearer ${tokenProfessor}`).send(payload);
      
      expect(res.status).toBe(200);
      expect(res.body.sucesso).toBe(true);

      // Checa se o outbox foi criado como PENDING
      const [jobs] = await dbPromise.query('SELECT status FROM email_jobs WHERE aluno_id = ? AND data_referencia = ?', [idAluno, '2026-10-01']);
      expect(jobs.length).toBe(1);
      expect(jobs[0].status).toBe('PENDING');
    });

    it('idempotência: repetir mesma chamada não duplica e não gera 2 emails', async () => {
      const payload = { aluno_id: idAluno, professor_id: idProfessor, data: '2026-10-01', status: 'falta' };
      const res = await request(app).post('/api/registrar-presenca').set('Authorization', `Bearer ${tokenProfessor}`).send(payload);
      
      expect(res.status).toBe(200); // Lida silenciosamente e não duplica.
      // O importante é o Outbox
      const [jobs] = await dbPromise.query('SELECT id FROM email_jobs WHERE aluno_id = ? AND data_referencia = ?', [idAluno, '2026-10-01']);
      expect(jobs.length).toBe(1); // Não gerou 2 e-mails
    });

    it('lote: atualiza presença com ON DUPLICATE KEY e não gera duplicidade no outbox', async () => {
      const payloadLote = {
        data: '2026-10-02',
        presencas: [{ aluno_id: idAluno, status: 'falta' }]
      };
      const res1 = await request(app).post('/api/registrar-presenca-turma').set('Authorization', `Bearer ${tokenProfessor}`).send(payloadLote);
      expect(res1.status).toBe(200);

      // Repete
      const res2 = await request(app).post('/api/registrar-presenca-turma').set('Authorization', `Bearer ${tokenProfessor}`).send(payloadLote);
      expect(res2.status).toBe(200); // Lote atualiza e responde sucesso

      const [jobs] = await dbPromise.query('SELECT id FROM email_jobs WHERE aluno_id = ? AND data_referencia = ?', [idAluno, '2026-10-02']);
      expect(jobs.length).toBe(1); // Idempotente no Outbox!
    });
  });

  describe('WORKER E SMTP MOCK', () => {
    it('worker processamento (PENDING -> SENT) com mock smtp', async () => {
      // Inicia worker que processará
      await iniciarWorker();
      
      // Espera um pouco para o loop do worker ler
      await new Promise(r => setTimeout(r, 1000));
      
      // Checa se ficaram como SENT
      const [jobs] = await dbPromise.query('SELECT status, tentativas FROM email_jobs WHERE data_referencia = ?', ['2026-10-02']);
      if (jobs.length > 0) {
        expect(jobs[0].status).toBe('SENT');
        expect(nodemailer._sendMailMock).toHaveBeenCalled();
      }
      
      await pararWorker();
    });
  });
});
