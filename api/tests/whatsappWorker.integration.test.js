// tests/whatsappWorker.integration.test.js — integração com MySQL real (provider fake)
// Rodar: npm run test:whatsapp
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');

const { createWhatsappWorker } = require('../src/workers/whatsappWorker');
const { criarFakeProvider } = require('../src/providers/whatsapp/fakeProvider');
const { processarEventosWebhook } = require('../src/routes/whatsappRoutes');
const { registrarFaltas, cancelarFaltasCorrigidas } = require('../src/services/notificacaoService');
const { validarBancoDeTeste } = require('../src/config/database');
const baseConfig = require('../src/config/whatsappConfig');

const TIPO = 'teste_wa_entrega4';
const silencioso = { log() {}, warn() {}, error() {} };
const dormir = (ms) => new Promise(r => setTimeout(r, ms));

let db, usuarioId, paiId, alunoId, seqData = 0;

const cfgTeste = {
  ...baseConfig,
  enabled: true,
  horarioSilencio: null,
  janelaCorrecaoMin: 0,
  batchSize: 50,
  concurrency: 3,
  intervaloEntreEnviosMs: 0,
  retryBaseDelayMs: 2_000,
  retryMaxDelayMs: 60_000,
  retryJitterRatio: 0,
  processingTimeoutMs: 10_000,
};

async function garantirSchemaEntrega4(conn) {
  const [cols] = await conn.query("SHOW COLUMNS FROM pais LIKE 'telefone_e164'");
  if (cols.length === 0) {
    await conn.query(`
      ALTER TABLE pais
        ADD COLUMN telefone_e164         VARCHAR(16) NULL,
        ADD COLUMN whatsapp_optin        TINYINT(1)  NOT NULL DEFAULT 0,
        ADD COLUMN whatsapp_optin_em     DATETIME    NULL,
        ADD COLUMN whatsapp_optin_origem VARCHAR(30) NULL,
        ADD COLUMN whatsapp_optout_em    DATETIME    NULL,
        ADD KEY idx_pais_telefone_e164 (telefone_e164)
    `);
  }
  await conn.query(`
    CREATE TABLE IF NOT EXISTS notificacao_preferencias (
      pai_id INT NOT NULL,
      tipo   VARCHAR(40) NOT NULL,
      canal  ENUM('email','whatsapp') NOT NULL,
      ativo  TINYINT(1) NOT NULL DEFAULT 1,
      atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (pai_id, tipo, canal),
      CONSTRAINT fk_pref_pai FOREIGN KEY (pai_id) REFERENCES pais(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await conn.query(`
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
      KEY idx_wa_jobs_fila (status, enviar_apos, proxima_tentativa_em),
      KEY idx_wa_jobs_usuario (usuario_id),
      KEY idx_wa_jobs_provider_msg (provider_msg_id),
      UNIQUE KEY uq_wa_jobs_idempotencia (aluno_id, tipo_notificacao, data_referencia),
      CONSTRAINT fk_wa_jobs_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
      CONSTRAINT fk_wa_jobs_aluno   FOREIGN KEY (aluno_id)   REFERENCES alunos(id)   ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
}

async function criarJob({
  destinatario = '+5511999998888',
  max = 5,
  status = 'PENDING',
  tentativas = 0,
  enviarAposSeg = null,
} = {}) {
  seqData++;
  const data = new Date(Date.UTC(2005, 0, 1) + seqData * 86_400_000).toISOString().slice(0, 10);
  const [r] = await db.query(
    `INSERT INTO whatsapp_jobs
      (usuario_id, aluno_id, destinatario, template, variaveis, mensagem, tipo_notificacao,
       data_referencia, status, tentativas, max_tentativas, enviar_apos)
     VALUES (?, ?, ?, 'aviso_falta', '{"nome_responsavel":"Pai"}', 'Mensagem WA', ?, ?, ?, ?, ?,
             IF(? IS NULL, NULL, DATE_ADD(NOW(), INTERVAL ? SECOND)))`,
    [usuarioId, alunoId, destinatario, TIPO, data, status, tentativas, max, enviarAposSeg, enviarAposSeg]
  );
  return r.insertId;
}

async function job(id) {
  const [[row]] = await db.query('SELECT * FROM whatsapp_jobs WHERE id = ?', [id]);
  return row;
}

beforeAll(async () => {
  const dbTeste = (process.env.DB_NAME && process.env.DB_NAME !== 'gpe')
    ? process.env.DB_NAME
    : (process.env.DB_TEST_NAME || 'gpe_test');
  process.env.DB_NAME = dbTeste;
  db = mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: dbTeste, connectionLimit: 10,
  });
  await validarBancoDeTeste(db);
  await garantirSchemaEntrega4(db);
  await db.query('DELETE FROM whatsapp_jobs WHERE tipo_notificacao = ?', [TIPO]);

  let [[a]] = await db.query(
    'SELECT a.id AS aluno_id, p.id AS pai_id, p.usuario_id FROM alunos a JOIN pais p ON p.id = a.pai_id LIMIT 1'
  );
  if (!a) {
    const [resPaiUser] = await db.query(
      'INSERT INTO usuarios (nome, email, senha, tipo) VALUES (?, ?, ?, ?)',
      ['Responsavel WA Teste', `resp_wa_${Date.now()}@teste.com`, 'hash', 'pai']
    );
    const [resPai] = await db.query(
      'INSERT INTO pais (usuario_id, telefone, telefone_e164, whatsapp_optin, whatsapp_optin_em, whatsapp_optin_origem) VALUES (?, "11999998888", "+5511999998888", 1, NOW(), "painel_pais")',
      [resPaiUser.insertId]
    );
    const [resAlunoUser] = await db.query(
      'INSERT INTO usuarios (nome, email, senha, tipo) VALUES (?, ?, ?, ?)',
      ['Aluno WA Teste', `aluno_wa_${Date.now()}@teste.com`, 'hash', 'aluno']
    );
    const [resAluno] = await db.query(
      'INSERT INTO alunos (usuario_id, pai_id) VALUES (?, ?)',
      [resAlunoUser.insertId, resPai.insertId]
    );
    a = { aluno_id: resAluno.insertId, pai_id: resPai.insertId, usuario_id: resPaiUser.insertId };
  } else {
    await db.query(
      'UPDATE pais SET telefone_e164 = "+5511999998888", whatsapp_optin = 1, whatsapp_optout_em = NULL WHERE id = ?',
      [a.pai_id]
    );
  }

  alunoId = a.aluno_id;
  paiId = a.pai_id;
  usuarioId = a.usuario_id;
});

afterEach(async () => {
  await db.query('DELETE FROM whatsapp_jobs WHERE tipo_notificacao IN (?, "falta")', [TIPO]);
  await db.query('UPDATE pais SET whatsapp_optin = 1, whatsapp_optout_em = NULL WHERE id = ?', [paiId]);
});

afterAll(async () => {
  if (db) await db.end();
});

test('fluxo completo: PENDING → SENT com fakeProvider + atualização via webhook (delivered → read)', async () => {
  const id = await criarJob();
  const fake = criarFakeProvider(cfgTeste, { logger: silencioso });
  const worker = createWhatsappWorker({ db, provider: fake, config: cfgTeste, logger: silencioso });

  await worker.executarCiclo();
  let j = await job(id);
  assert.equal(j.status, 'SENT');
  assert.equal(j.provider, 'fake');
  assert.equal(j.status_entrega, 'sent');
  assert.ok(j.provider_msg_id);

  await processarEventosWebhook(db, [
    { tipo: 'status', providerMsgId: j.provider_msg_id, status: 'delivered' },
    { tipo: 'status', providerMsgId: j.provider_msg_id, status: 'read' },
  ]);

  j = await job(id);
  assert.equal(j.status_entrega, 'read');
  assert.ok(j.entregue_em);
  assert.ok(j.lido_em);
});

test('janela de correção: job com enviar_apos no futuro não é enviado ainda e pode ser cancelado se presença corrigida', async () => {
  const dataRef = '2026-11-04';
  const conn = await db.getConnection();
  try {
    await registrarFaltas(conn, { alunoIds: [alunoId], data: dataRef }, {
      waConfig: { ...cfgTeste, janelaCorrecaoMin: 15 },
    });
  } finally {
    conn.release();
  }

  const fake = criarFakeProvider(cfgTeste, { logger: silencioso });
  const worker = createWhatsappWorker({ db, provider: fake, config: cfgTeste, logger: silencioso });

  // Como enviar_apos é NOW() + 15 min, o worker não pega o job agora
  const processados = await worker.executarCiclo();
  assert.equal(processados, 0);

  // Professor corrige a chamada para presente dentro dos 15 min
  const conn2 = await db.getConnection();
  try {
    const cancelados = await cancelarFaltasCorrigidas(conn2, { alunoIds: [alunoId], data: dataRef }, { waConfig: cfgTeste });
    assert.equal(cancelados, 1);
  } finally {
    conn2.release();
  }

  const [[j]] = await db.query('SELECT status FROM whatsapp_jobs WHERE aluno_id = ? AND data_referencia = ?', [alunoId, dataRef]);
  assert.equal(j.status, 'CANCELLED');
});

test('opt-out via webhook ("SAIR") desativa consentimento do pai e cancela jobs pendentes', async () => {
  const id = await criarJob({ destinatario: '+5511999998888', enviarAposSeg: 600 });
  const r = await processarEventosWebhook(db, [
    { tipo: 'mensagem', de: '5511999998888', texto: 'sair' },
  ]);
  assert.equal(r.optouts, 1);

  const [[p]] = await db.query('SELECT whatsapp_optin, whatsapp_optout_em FROM pais WHERE id = ?', [paiId]);
  assert.equal(p.whatsapp_optin, 0);
  assert.ok(p.whatsapp_optout_em);

  const j = await job(id);
  assert.equal(j.status, 'CANCELLED');
});

