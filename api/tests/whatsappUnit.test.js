// tests/whatsappUnit.test.js — testes unitários para WhatsApp (sem banco e sem rede)
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { normalizarTelefoneBR, variantesBR, mascararTelefone } = require('../src/utils/telefone');
const { montarAvisoFalta, montarTesteConexao, parametrosPosicionais, formatarDataBR, primeiroNome } = require('../src/services/whatsappTemplates');
const { TEMPORARIO, PERMANENTE, classificarHttp, iguaisSeguro, ehPedidoOptOut } = require('../src/providers/whatsapp/comum');
const { criarMetaProvider, verificarAssinatura, parsearWebhook: parseMeta } = require('../src/providers/whatsapp/metaCloudProvider');
const { criarEvolutionProvider, parsearWebhook: parseEvolution } = require('../src/providers/whatsapp/evolutionProvider');
const { criarWahaProvider, parsearWebhook: parseWaha, verificarHmacWaha, extrairIdMensagem } = require('../src/providers/whatsapp/wahaProvider');
const { criarFakeProvider } = require('../src/providers/whatsapp/fakeProvider');
const { criarProvider } = require('../src/providers/whatsapp');
const { parseHorarioSilencio } = require('../src/config/whatsappConfig');
const { emHorarioSilencio, sanitizarErroWa, createWhatsappWorker } = require('../src/workers/whatsappWorker');
const { registrarFaltas, cancelarFaltasCorrigidas } = require('../src/services/notificacaoService');
const { processarEventosWebhook } = require('../src/routes/whatsappRoutes');

describe('WhatsApp — Telefone BR (E.164)', () => {
  test('normaliza celulares brasileiros válidos em vários formatos', () => {
    assert.equal(normalizarTelefoneBR('(11) 99999-8888'), '+5511999998888');
    assert.equal(normalizarTelefoneBR('11999998888'), '+5511999998888');
    assert.equal(normalizarTelefoneBR('+55 62 98123-4567'), '+5562981234567');
    assert.equal(normalizarTelefoneBR('011988887777'), '+5511988887777');
    assert.equal(normalizarTelefoneBR('005521987654321'), '+5521987654321');
  });

  test('rejeita DDD inexistente, fixo (sem 9 inicial) e dígitos repetidos', () => {
    assert.equal(normalizarTelefoneBR('20999998888'), null); // DDD 20 não existe
    assert.equal(normalizarTelefoneBR('1133334444'), null);  // fixo 10 dígitos
    assert.equal(normalizarTelefoneBR('11888887777'), null); // 9º dígito != 9
    assert.equal(normalizarTelefoneBR('11999999999'), null); // todos iguais
    assert.equal(normalizarTelefoneBR(''), null);
    assert.equal(normalizarTelefoneBR(null), null);
  });

  test('variantesBR devolve com e sem o 9º dígito para conciliação de webhook', () => {
    assert.deepEqual(variantesBR('5511988887777'), ['+5511988887777', '+551188887777']);
    assert.deepEqual(variantesBR('551188887777'), ['+5511988887777', '+551188887777']);
  });

  test('mascararTelefone oculta parte central do número', () => {
    assert.equal(mascararTelefone('+5511999998888'), '+55 11 9****-8888');
    assert.equal(mascararTelefone('curto'), '***');
  });
});

describe('WhatsApp — Templates e LGPD', () => {
  test('monta aviso de falta usando apenas o primeiro nome e parâmetros posicionais', () => {
    const r = montarAvisoFalta(
      { nomeResponsavel: 'Maria Clara Silva', nomeAluno: 'João Pedro Silva', turma: '9º Ano A', data: '2026-10-19' },
      { appPublicUrl: 'https://escola.gov.br', nomeEscola: 'Escola Modelo' }
    );
    assert.equal(r.template, 'aviso_falta');
    assert.equal(r.variaveis.nome_responsavel, 'Maria');
    assert.equal(r.variaveis.nome_aluno, 'João');
    assert.equal(r.variaveis.data, '19/10/2026');
    assert.equal(r.variaveis.link, 'https://escola.gov.br/pais.html');
    assert.match(r.mensagem, /responda SAIR/);

    const pos = parametrosPosicionais('aviso_falta', r.variaveis);
    assert.deepEqual(pos, ['Maria', 'João', '9º Ano A', '19/10/2026', 'https://escola.gov.br/pais.html', 'Escola Modelo']);
  });

  test('monta teste de conexão e rejeita template desconhecido como erro permanente', () => {
    const t = montarTesteConexao({ nomeResponsavel: 'Carlos Eduardo' }, { nomeEscola: 'GPE' });
    assert.equal(t.template, 'teste_conexao');
    assert.deepEqual(parametrosPosicionais('teste_conexao', t.variaveis), ['Carlos', 'GPE']);
    assert.throws(() => parametrosPosicionais('inexistente', {}), (err) => err.permanente === true);
    assert.equal(formatarDataBR(new Date(2026, 9, 5)), '05/10/2026');
    assert.equal(primeiroNome('  Ana   Beatriz '), 'Ana');
  });
});

describe('WhatsApp — Providers, Classificação de Erros e Webhooks', () => {
  test('classificarHttp diferencia erros temporários e permanentes', () => {
    assert.equal(classificarHttp({ rede: true }), TEMPORARIO);
    assert.equal(classificarHttp({ status: 429 }), TEMPORARIO);
    assert.equal(classificarHttp({ status: 503 }), TEMPORARIO);
    assert.equal(classificarHttp({ status: 401 }), TEMPORARIO);
    assert.equal(classificarHttp({ status: 400 }), PERMANENTE);
    assert.equal(classificarHttp({ permanente: true }), PERMANENTE);
  });

  test('Meta provider: classificação por código específico e validação HMAC SHA-256', () => {
    const meta = criarMetaProvider({
      httpTimeoutMs: 5000,
      meta: { phoneNumberId: '123', token: 'tok', appSecret: 'segredo_meta', graphVersion: 'v21.0', idioma: 'pt_BR' },
    });
    assert.equal(meta.classificarErro({ codigo: 131026 }), PERMANENTE); // destinatário sem WhatsApp
    assert.equal(meta.classificarErro({ codigo: 130429 }), TEMPORARIO); // rate limit

    const raw = Buffer.from('{"object":"whatsapp_business_account"}');
    const sigValida = 'sha256=' + crypto.createHmac('sha256', 'segredo_meta').update(raw).digest('hex');
    assert.ok(verificarAssinatura(raw, sigValida, 'segredo_meta'));
    assert.ok(!verificarAssinatura(raw, 'sha256=invalida', 'segredo_meta'));
  });

  test('Meta e Evolution: parseiam eventos de status e mensagens de opt-out', () => {
    const evMeta = parseMeta({
      entry: [{
        changes: [{
          value: {
            statuses: [{ id: 'wamid.1', status: 'delivered' }, { id: 'wamid.2', status: 'failed', errors: [{ code: 131026, title: 'Undeliverable' }] }],
            messages: [{ from: '5511999998888', text: { body: ' sair ' } }],
          },
        }],
      }],
    });
    assert.equal(evMeta.length, 3);
    assert.deepEqual(evMeta[0], { tipo: 'status', providerMsgId: 'wamid.1', status: 'delivered', erro: undefined });
    assert.equal(evMeta[1].status, 'failed');
    assert.match(evMeta[1].erro, /131026/);
    assert.deepEqual(evMeta[2], { tipo: 'mensagem', de: '5511999998888', texto: ' sair ' });
    assert.ok(ehPedidoOptOut(evMeta[2].texto));
    assert.ok(ehPedidoOptOut('PARAR!'));
    assert.ok(!ehPedidoOptOut('Obrigado pelo aviso'));

    const evEvo = parseEvolution({
      event: 'messages.update',
      data: [{ keyId: 'evo-1', status: 'READ' }],
    });
    assert.deepEqual(evEvo, [{ tipo: 'status', providerMsgId: 'evo-1', status: 'read' }]);

    const evoProv = criarEvolutionProvider({
      httpTimeoutMs: 5000,
      verifyToken: 'tok_evo',
      evolution: { url: 'http://localhost:8080', apiKey: 'k', instance: 'gpe' },
    });
    assert.equal(evoProv.classificarErro({ status: 400, corpo: { response: { message: [{ exists: false }] } } }), PERMANENTE);
  });

  test('Fake provider registra envios em memória sem chamar rede', async () => {
    const fake = criarFakeProvider({ verifyToken: 't' }, { logger: { log() {} } });
    const res = await fake.enviar({ destinatario: '+5511999998888', template: 'aviso_falta' });
    assert.match(res.providerMsgId, /^fake-/);
    assert.equal(fake.enviados.length, 1);
    assert.ok(iguaisSeguro('abc', 'abc'));
    assert.ok(!iguaisSeguro('abc', 'abd'));
  });

  test('WAHA provider: parseia webhooks (message.ack e message), valida HMAC SHA-512 e classifica erros', () => {
    const waha = criarProvider('waha', {
      httpTimeoutMs: 5000,
      verifyToken: 'tok_waha',
      waha: { url: 'http://localhost:3001', apiKey: 'gpe_waha_key', session: 'default', hmacSecret: 'segredo_waha', checkNumberExists: true },
    });
    assert.equal(waha.nome, 'waha');

    // Eventos de ACK (2 = delivered, 3 = read, -1 = failed)
    const evAck = parseWaha({
      event: 'message.ack',
      payload: { id: 'true_5511999998888@c.us_3EB012345', ack: 3, ackName: 'READ' },
    });
    assert.deepEqual(evAck, [{
      tipo: 'status',
      providerMsgId: '3EB012345',
      status: 'read',
      erro: undefined,
    }]);

    // Mensagem recebida com opt-out SAIR
    const evMsg = parseWaha({
      event: 'message',
      payload: { from: '5562999998888@c.us', fromMe: false, body: 'SAIR' },
    });
    assert.deepEqual(evMsg, [{ tipo: 'mensagem', de: '5562999998888', texto: 'SAIR' }]);

    // Validação HMAC SHA-512 do WAHA
    const raw = Buffer.from('{"event":"message"}');
    const hmac512 = crypto.createHmac('sha512', 'segredo_waha').update(raw).digest('hex');
    assert.ok(verificarHmacWaha(raw, hmac512, 'sha512', 'segredo_waha'));
    assert.ok(!verificarHmacWaha(raw, 'assinatura_invalida', 'sha512', 'segredo_waha'));

    // Classificação de erro: 422 sessão ainda não WORKING é temporário; número sem WhatsApp é permanente
    assert.equal(waha.classificarErro({ status: 422, corpo: { message: 'Session status is not as expected' } }), TEMPORARIO);
    assert.equal(waha.classificarErro({ status: 400, permanente: true }), PERMANENTE);
  });

  test('WAHA: ID da mensagem é normalizado igual no envio (NOWEB/WEBJS) e no ACK', () => {
    // NOWEB devolve a mensagem crua do Baileys
    assert.equal(extrairIdMensagem({ key: { id: '3EB0ABC', remoteJid: '5511999998888@s.whatsapp.net', fromMe: true } }), '3EB0ABC');
    // WEBJS: objeto de id ou string serializada
    assert.equal(extrairIdMensagem({ id: { fromMe: true, remote: '5511999998888@c.us', id: '3EB0ABC', _serialized: 'true_5511999998888@c.us_3EB0ABC' } }), '3EB0ABC');
    assert.equal(extrairIdMensagem({ id: 'true_5511999998888@c.us_3EB0ABC' }), '3EB0ABC');
    // ACK em grupo (com participant no final)
    assert.equal(extrairIdMensagem('false_123@g.us_3EB0ABC_5511999998888@c.us'), '3EB0ABC');
    assert.equal(extrairIdMensagem(null), null);
  });

  test('WAHA: webhook exige HMAC quando configurado e recusa sem segredo em produção', () => {
    const raw = Buffer.from('{"event":"message"}');
    const hmac = crypto.createHmac('sha512', 'segredo_waha').update(raw).digest('hex');
    const req = (headers = {}, query = {}) => ({ rawBody: raw, query, get: (h) => headers[h.toLowerCase()] });

    const comHmac = criarProvider('waha', { verifyToken: 'tok', waha: { url: 'http://x', session: 'default', hmacSecret: 'segredo_waha' } });
    assert.ok(comHmac.validarWebhook(req({ 'x-webhook-hmac': hmac })));
    // Sem header HMAC não cai para o token
    assert.ok(!comHmac.validarWebhook(req({}, { token: 'tok' })));

    const comToken = criarProvider('waha', { verifyToken: 'tok', waha: { url: 'http://x', session: 'default' } });
    assert.ok(comToken.validarWebhook(req({}, { token: 'tok' })));
    assert.ok(!comToken.validarWebhook(req({}, { token: 'errado' })));

    const semSegredo = criarProvider('waha', { waha: { url: 'http://x', session: 'default' } });
    const envAnterior = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      assert.ok(!semSegredo.validarWebhook(req()));
    } finally {
      process.env.NODE_ENV = envAnterior;
    }
  });
});

describe('WhatsApp — Horário de Silêncio, Sanitização e Worker', () => {
  test('emHorarioSilencio suporta faixas que cruzam meia-noite (21:00-07:00)', () => {
    const faixa = parseHorarioSilencio('21:00-07:00');
    assert.ok(emHorarioSilencio(faixa, new Date(2026, 10, 4, 22, 30))); // 22:30 -> silêncio
    assert.ok(emHorarioSilencio(faixa, new Date(2026, 10, 4, 6, 59)));  // 06:59 -> silêncio
    assert.ok(!emHorarioSilencio(faixa, new Date(2026, 10, 4, 7, 0)));  // 07:00 -> liberado
    assert.ok(!emHorarioSilencio(faixa, new Date(2026, 10, 4, 14, 0))); // 14:00 -> liberado
    assert.equal(parseHorarioSilencio('off'), null);
  });

  test('sanitizarErroWa oculta segredos de API', () => {
    const cfg = { meta: { token: 'EAAB_SEGREDO_123', appSecret: 'APP_SEC_999' }, evolution: { apiKey: 'EVO_KEY_777' }, verifyToken: 'VER_TOK_555' };
    const msg = sanitizarErroWa(new Error('Falha com token EAAB_SEGREDO_123\nna chamada'), cfg);
    assert.ok(!msg.includes('EAAB_SEGREDO_123'));
    assert.ok(!msg.includes('\n'));
    assert.match(msg, /\*\*\*/);
  });

  test('worker respeita horário de silêncio e processa jobs com provider fake', async () => {
    const jobsNoBanco = [
      { id: 10, destinatario: '+5511999998888', template: 'aviso_falta', variaveis: '{}', mensagem: 'msg', tentativas: 0, max_tentativas: 5 },
    ];
    const updates = [];
    const mockConn = {
      async beginTransaction() {},
      async query(sql, params) {
        if (sql.includes('SELECT id')) return [jobsNoBanco];
        updates.push({ sql, params });
        return [{ affectedRows: 1 }];
      },
      async commit() {},
      async rollback() {},
      release() {},
    };
    const mockDb = {
      async query(sql, params) {
        updates.push({ sql, params });
        return [{ affectedRows: 0 }];
      },
      async getConnection() { return mockConn; },
    };

    const fake = criarFakeProvider({ verifyToken: 't' }, { logger: { log() {} } });
    const cfg = {
      batchSize: 10,
      concurrency: 2,
      maxTentativas: 5,
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 10000,
      retryJitterRatio: 0,
      processingTimeoutMs: 60000,
      intervaloEntreEnviosMs: 0,
      horarioSilencio: parseHorarioSilencio('21:00-07:00'),
    };

    // 1) Em horário de silêncio (23:00): não reivindica lote
    const workerSilencio = createWhatsappWorker({
      db: mockDb, provider: fake, config: cfg, logger: { log() {}, warn() {}, error() {} },
      now: () => new Date(2026, 10, 4, 23, 0),
    });
    const nSilencio = await workerSilencio.executarCiclo();
    assert.equal(nSilencio, 0);
    assert.equal(workerSilencio.stats.ciclosEmSilencio, 1);

    // 2) Fora do horário de silêncio (10:00): reivindica e envia
    const workerAtivo = createWhatsappWorker({
      db: mockDb, provider: fake, config: cfg, logger: { log() {}, warn() {}, error() {} },
      now: () => new Date(2026, 10, 4, 10, 0),
    });
    const nAtivo = await workerAtivo.executarCiclo();
    assert.equal(nAtivo, 1);
    assert.equal(workerAtivo.stats.enviados, 1);
    assert.equal(fake.enviados.length, 1);
  });
});

describe('WhatsApp — Serviço de Notificação e Processamento de Webhook', () => {
  test('registrarFaltas enfileira whatsapp_jobs quando waConfig.enabled = true e cancelarFaltasCorrigidas cancela pendentes', async () => {
    const queries = [];
    const mockConn = {
      async query(sql, params) {
        queries.push({ sql, params });
        if (sql.includes('FROM presencas')) return [[]];
        if (sql.includes('FROM alunos a') && sql.includes('email_responsavel')) {
          return [[{ aluno_id: 1, usuario_pai_id: 2, nome_responsavel: 'Ana Silva', email_responsavel: 'ana@test.com', nome_aluno: 'Pedro Silva', turma: '8A' }]];
        }
        if (sql.includes('whatsapp_optin = 1')) {
          return [[{ aluno_id: 1, usuario_pai_id: 2, nome_responsavel: 'Ana Silva', nome_aluno: 'Pedro Silva', turma: '8A', telefone_e164: '+5511999998888' }]];
        }
        return [{ affectedRows: 1 }];
      },
    };

    const waConfig = { enabled: true, maxTentativas: 5, janelaCorrecaoMin: 15, appPublicUrl: 'http://localhost:5500', nomeEscola: 'GPE' };
    const r = await registrarFaltas(mockConn, { alunoIds: [1], data: '2026-10-19' }, { waConfig });
    assert.deepEqual(r, { notificados: 1, whatsapp: 1 });
    assert.ok(queries.some(q => q.sql.includes('INSERT INTO whatsapp_jobs')));

    const cancelados = await cancelarFaltasCorrigidas(mockConn, { alunoIds: [1], data: '2026-10-19' }, { waConfig });
    assert.equal(cancelados, 1);
  });

  test('processarEventosWebhook atualiza status monotonicamente e executa opt-out em pedido SAIR', async () => {
    const executadas = [];
    const mockDb = {
      async query(sql, params) {
        executadas.push({ sql, params });
        if (sql.includes('SELECT id, status_entrega')) {
          return [[{ id: 99, status_entrega: 'sent' }]];
        }
        return [{ affectedRows: 1 }];
      },
    };

    const res = await processarEventosWebhook(mockDb, [
      { tipo: 'status', providerMsgId: 'wamid.99', status: 'read' },
      { tipo: 'mensagem', de: '5511999998888', texto: 'SAIR' },
    ]);
    assert.deepEqual(res, { statusAtualizados: 1, optouts: 1 });
    assert.ok(executadas.some(q => q.sql.includes('whatsapp_optin = 0')));
    assert.ok(executadas.some(q => q.sql.includes("status = 'CANCELLED'")));
  });
});

