// tests/emailWorker.integration.test.js — worker contra o MySQL real, com SMTP falso.
// Usa tipo_notificacao = 'teste_fase4' e apaga tudo ao final.
// Rodar: npm run test:email
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');

const { createEmailWorker } = require('../src/workers/emailWorker');
const baseConfig = require('../src/config/emailConfig');

const TIPO = 'teste_fase4';
const silencioso = { log() {}, warn() {}, error() {} };
const dormir = (ms) => new Promise(r => setTimeout(r, ms));

let db, usuarioId, alunoId, seqData = 0;

const cfgTeste = {
  ...baseConfig,
  batchSize: 50,
  concurrency: 3,
  retryBaseDelayMs: 2_000, // backoff curto para o teste: 2s, 4s...
  retryMaxDelayMs: 60_000,
  retryJitterRatio: 0,     // determinístico
  processingTimeoutMs: 10_000,
};

function novoWorker(enviar, extra = {}) {
  return createEmailWorker({ db, enviar, config: { ...cfgTeste, ...extra }, logger: silencioso });
}

async function criarJob({ destinatario = 'pai@teste.com', max = 5, status = 'PENDING', tentativas = 0, processadoHaSeg = null } = {}) {
  seqData++;
  const data = new Date(Date.UTC(2000, 0, 1) + seqData * 86_400_000).toISOString().slice(0, 10);
  const [r] = await db.query(
    `INSERT INTO email_jobs (usuario_id, aluno_id, destinatario, assunto, mensagem, tipo_notificacao,
                             data_referencia, status, tentativas, max_tentativas, processado_em)
     VALUES (?, ?, ?, 'Assunto teste', 'Mensagem teste', ?, ?, ?, ?, ?,
             IF(? IS NULL, NULL, DATE_SUB(NOW(), INTERVAL ? SECOND)))`,
    [usuarioId, alunoId, destinatario, TIPO, data, status, tentativas, max, processadoHaSeg, processadoHaSeg]
  );
  return r.insertId;
}

async function job(id) {
  const [[row]] = await db.query(
    `SELECT *, TIMESTAMPDIFF(SECOND, NOW(), proxima_tentativa_em) AS segundos_ate_retry
       FROM email_jobs WHERE id = ?`, [id]);
  return row;
}

const erroTemp = () => Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' });
const erroPerm = () => Object.assign(new Error('550 Mailbox not found'), { code: 'EENVELOPE', responseCode: 550 });

beforeAll(async () => {
  db = mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME, connectionLimit: 10,
  });
  await db.query('DELETE FROM email_jobs WHERE tipo_notificacao = ?', [TIPO]);

  // Segurança: o worker processa QUALQUER job elegível. Não rodar se houver jobs reais na fila.
  const [[{ n }]] = await db.query(
    `SELECT COUNT(*) n FROM email_jobs WHERE status IN ('PENDING','RETRY','PROCESSING') AND tipo_notificacao <> ?`, [TIPO]);
  if (n > 0) throw new Error(`Há ${n} job(s) reais pendentes em email_jobs. Abortando para não processá-los com SMTP falso.`);

  const [[a]] = await db.query(
    'SELECT a.id AS aluno_id, p.usuario_id FROM alunos a JOIN pais p ON p.id = a.pai_id LIMIT 1');
  assert.ok(a, 'precisa de pelo menos 1 aluno com responsável no banco');
  alunoId = a.aluno_id;
  usuarioId = a.usuario_id;
});

afterEach(async () => {
  await db.query('DELETE FROM email_jobs WHERE tipo_notificacao = ?', [TIPO]);
});

afterAll(async () => { await db.end(); });

test('sucesso: PENDING → SENT na 1ª tentativa', async () => {
  const id = await criarJob();
  const enviados = [];
  await novoWorker(async (to) => { enviados.push(to); }).executarCiclo();

  const j = await job(id);
  assert.equal(j.status, 'SENT');
  assert.equal(j.tentativas, 1);
  assert.equal(j.ultimo_erro, null);
  assert.deepEqual(enviados, ['pai@teste.com']);
});

test('erro temporário → RETRY com backoff; não é reprocessado antes da hora; sucesso após retry', async () => {
  const id = await criarJob();
  let chamadas = 0;
  const worker = novoWorker(async () => { chamadas++; if (chamadas === 1) throw erroTemp(); });

  await worker.executarCiclo();
  let j = await job(id);
  assert.equal(j.status, 'RETRY');
  assert.equal(j.tentativas, 1);
  assert.match(j.ultimo_erro, /^\[ETIMEDOUT\] Connection timeout$/);
  assert.ok(j.segundos_ate_retry >= 1 && j.segundos_ate_retry <= 2, `backoff ~2s, obtido ${j.segundos_ate_retry}s`);

  // Backoff respeitado: ciclo imediato NÃO pega o job
  await worker.executarCiclo();
  assert.equal(chamadas, 1);
  assert.equal((await job(id)).status, 'RETRY');

  await dormir(3_000);
  await worker.executarCiclo();
  j = await job(id);
  assert.equal(j.status, 'SENT');
  assert.equal(j.tentativas, 2);
  assert.equal(chamadas, 2);
});

test('backoff cresce exponencialmente entre tentativas (2s → 4s)', async () => {
  const id = await criarJob({ max: 5 });
  const worker = novoWorker(async () => { throw erroTemp(); });

  await worker.executarCiclo();
  const t1 = (await job(id)).segundos_ate_retry;
  await dormir(2_500);
  await worker.executarCiclo();
  const j = await job(id);
  assert.equal(j.tentativas, 2);
  assert.ok(t1 >= 1 && t1 <= 2, `1º atraso ~2s, obtido ${t1}`);
  assert.ok(j.segundos_ate_retry >= 3 && j.segundos_ate_retry <= 4, `2º atraso ~4s, obtido ${j.segundos_ate_retry}`);
});

test('FAILED após atingir max_tentativas (sem retry infinito)', async () => {
  const id = await criarJob({ max: 2 });
  let chamadas = 0;
  const worker = novoWorker(async () => { chamadas++; throw erroTemp(); });

  await worker.executarCiclo();
  assert.equal((await job(id)).status, 'RETRY');
  await dormir(2_500);
  await worker.executarCiclo();

  const j = await job(id);
  assert.equal(j.status, 'FAILED');
  assert.equal(j.tentativas, 2);
  assert.equal(j.proxima_tentativa_em, null);

  await dormir(1_000);
  await worker.executarCiclo();
  assert.equal(chamadas, 2, 'FAILED não deve ser reprocessado');
});

test('erro permanente (550) → FAILED direto, sem retry', async () => {
  const id = await criarJob({ max: 5 });
  await novoWorker(async () => { throw erroPerm(); }).executarCiclo();
  const j = await job(id);
  assert.equal(j.status, 'FAILED');
  assert.equal(j.tentativas, 1);
  assert.match(j.ultimo_erro, /550/);
});

test('destinatário inválido → FAILED sem chamar o SMTP', async () => {
  const id = await criarJob({ destinatario: 'invalido-sem-arroba' });
  let chamadas = 0;
  await novoWorker(async () => { chamadas++; }).executarCiclo();
  assert.equal(chamadas, 0);
  assert.equal((await job(id)).status, 'FAILED');
});

test('vários jobs com concorrência limitada a 3', async () => {
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push(await criarJob());
  let ativos = 0, pico = 0;
  const worker = novoWorker(async () => {
    ativos++; pico = Math.max(pico, ativos);
    await dormir(100);
    ativos--;
  });

  const n = await worker.executarCiclo();
  assert.equal(n, 12);
  assert.equal(pico, 3, `pico de concorrência deveria ser 3, foi ${pico}`);
  assert.equal(worker.stats.picoConcorrencia, 3);
  const [rows] = await db.query(`SELECT status, COUNT(*) n FROM email_jobs WHERE tipo_notificacao = ? GROUP BY status`, [TIPO]);
  assert.deepEqual(rows.map(r => [r.status, r.n]), [['SENT', 12]]);
});

test('dois workers simultâneos não enviam o mesmo job (SKIP LOCKED)', async () => {
  for (let i = 0; i < 30; i++) await criarJob();
  const enviar = async () => { await dormir(20); };
  const w1 = novoWorker(enviar, { batchSize: 10 });
  const w2 = novoWorker(enviar, { batchSize: 10 });

  // Rodar ciclos concorrentes até esvaziar
  let total = 0, n1, n2;
  do {
    [n1, n2] = await Promise.all([w1.executarCiclo(), w2.executarCiclo()]);
    total += n1 + n2;
  } while (n1 + n2 > 0);

  assert.equal(total, 30, 'cada job reivindicado exatamente uma vez');
  assert.equal(w1.stats.enviados + w2.stats.enviados, 30);
  assert.ok(w1.stats.enviados > 0 && w2.stats.enviados > 0, 'os dois workers participaram');
  const [[{ n, maxT }]] = await db.query(
    `SELECT COUNT(*) n, MAX(tentativas) maxT FROM email_jobs WHERE tipo_notificacao = ? AND status = 'SENT'`, [TIPO]);
  assert.equal(n, 30);
  assert.equal(maxT, 1, 'nenhum job foi tentado duas vezes');
});

test('job órfão em PROCESSING (processo morreu) é recuperado e enviado', async () => {
  const id = await criarJob({ status: 'PROCESSING', tentativas: 1, processadoHaSeg: 3600 });
  const recente = await criarJob({ status: 'PROCESSING', tentativas: 1, processadoHaSeg: 1 });
  const worker = novoWorker(async () => {});

  await worker.executarCiclo();
  const j = await job(id);
  assert.equal(j.status, 'SENT');
  assert.equal(j.tentativas, 2);
  assert.equal(worker.stats.recuperados, 1);
  assert.equal((await job(recente)).status, 'PROCESSING', 'job ainda dentro do timeout não pode ser tocado');
});

test('órfão que já esgotou tentativas vai para FAILED', async () => {
  const id = await criarJob({ status: 'PROCESSING', tentativas: 5, max: 5, processadoHaSeg: 3600 });
  await novoWorker(async () => {}).executarCiclo();
  assert.equal((await job(id)).status, 'FAILED');
});
