// tests/emailUnit.test.js — testes unitários (sem banco, sem SMTP)
const assert = require('node:assert/strict');
const { classificarErro, sanitizarErro, emailValido, TEMPORARIO, PERMANENTE } = require('../src/services/emailService');
const { calcularBackoffMs, executarComConcorrencia } = require('../src/workers/emailWorker');

function erroSmtp(props) { return Object.assign(new Error(props.message || 'erro'), props); }

test('classificação: erros de rede/timeout são temporários', () => {
  for (const code of ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNRESET']) {
    assert.equal(classificarErro(erroSmtp({ code })), TEMPORARIO, code);
  }
});

test('classificação: SMTP 4xx temporário, 5xx permanente', () => {
  assert.equal(classificarErro(erroSmtp({ responseCode: 421 })), TEMPORARIO);
  assert.equal(classificarErro(erroSmtp({ responseCode: 451 })), TEMPORARIO);
  assert.equal(classificarErro(erroSmtp({ responseCode: 550 })), PERMANENTE);
  assert.equal(classificarErro(erroSmtp({ responseCode: 553 })), PERMANENTE);
});

test('classificação: EAUTH é temporário (config do sistema), EENVELOPE é permanente', () => {
  assert.equal(classificarErro(erroSmtp({ code: 'EAUTH', responseCode: 535 })), TEMPORARIO);
  assert.equal(classificarErro(erroSmtp({ code: 'EENVELOPE' })), PERMANENTE);
  assert.equal(classificarErro(new Error('qualquer coisa')), TEMPORARIO);
});

test('sanitização: remove quebras de linha, segredos e limita tamanho', () => {
  const antigo = process.env.SENHA_APP;
  process.env.SENHA_APP = 'segredoSuperSecreto';
  try {
    const e = erroSmtp({ code: 'EAUTH', responseCode: 535, message: 'falhou\ncom senha segredoSuperSecreto\n' + 'x'.repeat(1000) });
    const s = sanitizarErro(e);
    assert.ok(!s.includes('\n'));
    assert.ok(!s.includes('segredoSuperSecreto'));
    assert.ok(s.startsWith('[EAUTH] (535) falhou com senha ***'));
    assert.ok(s.length <= 500);
  } finally {
    process.env.SENHA_APP = antigo;
  }
});

test('validação de e-mail', () => {
  assert.ok(emailValido('pai@escola.com'));
  assert.ok(!emailValido('sem-arroba'));
  assert.ok(!emailValido(''));
  assert.ok(!emailValido(null));
});

test('backoff exponencial: 30s, 60s, 120s, 240s e respeita o teto', () => {
  const cfg = { baseMs: 30_000, maxMs: 200_000, jitterRatio: 0 };
  assert.deepEqual([1, 2, 3, 4, 10].map(t => calcularBackoffMs(t, cfg)), [30_000, 60_000, 120_000, 200_000, 200_000]);
});

test('backoff com jitter fica entre (1-ratio)*exp e exp', () => {
  const cfg = { baseMs: 10_000, maxMs: 1e9, jitterRatio: 0.2 };
  assert.equal(calcularBackoffMs(1, cfg, () => 0), 10_000);
  assert.equal(calcularBackoffMs(1, cfg, () => 1), 8_000);
});

test('concorrência limitada: nunca passa do limite e processa todos', async () => {
  let ativos = 0, pico = 0;
  const feitos = [];
  await executarComConcorrencia([...Array(20).keys()], 4, async (i) => {
    ativos++; pico = Math.max(pico, ativos);
    await new Promise(r => setTimeout(r, 10 + (i % 3) * 5));
    feitos.push(i);
    ativos--;
  });
  assert.equal(pico, 4);
  assert.equal(feitos.length, 20);
});

test('concorrência: erro em um item não interrompe os outros', async () => {
  const feitos = [];
  await executarComConcorrencia([1, 2, 3, 4], 2, async (i) => {
    if (i === 2) throw new Error('boom');
    feitos.push(i);
  });
  assert.deepEqual(feitos.sort(), [1, 3, 4]);
});
