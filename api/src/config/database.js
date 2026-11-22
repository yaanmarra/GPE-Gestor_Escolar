// src/config/database.js
// Garante que .env está carregado (necessário quando scripts rodam fora do server.js)
if (!process.env.DB_HOST) {
  require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
}
const mysql = require('mysql2');

// Proteção do banco principal durante execução de suítes de teste (NODE_ENV=test)
if (process.env.NODE_ENV === 'test' && process.env.GITHUB_ACTIONS !== 'true') {
  if (!process.env.DB_NAME || process.env.DB_NAME.trim().toLowerCase() === 'gpe') {
    process.env.DB_NAME = process.env.DB_TEST_NAME || 'gpe_test';
  }
}

const db = mysql.createPool({
  host:     process.env.DB_HOST,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0
});

// Teste de conexão ao iniciar (omitido em ambiente de teste para evitar handles abertos desnecessários)
if (process.env.NODE_ENV !== 'test') {
  db.getConnection((err, connection) => {
    if (err) {
      console.error('❌ Erro ao conectar ao MySQL:', err.message);
      return;
    }
    console.log('✅ Pool MySQL conectado com sucesso!');
    connection.release();
  });
}

// Wrapper promise para uso com async/await
const dbPromise = db.promise();

/**
 * Confirma programaticamente que a conexão ativa aponta para um banco autorizado para testes
 * antes de permitir qualquer limpeza destrutiva (TRUNCATE / DELETE em massa).
 */
async function validarBancoDeTeste(pool = dbPromise, env = process.env) {
  const isCiEphemeral = env.GITHUB_ACTIONS === 'true';
  const dbConfigurado = String(env.DB_NAME || '').trim();

  if (!dbConfigurado) {
    throw new Error('[SEGURANÇA DE TESTES] DB_NAME não definido. Configure DB_NAME=gpe_test.');
  }

  if (!isCiEphemeral && (dbConfigurado.toLowerCase() === 'gpe' || !/(^|_|-)(test|teste)($|_|-)/i.test(dbConfigurado))) {
    throw new Error(
      `[SEGURANÇA DE TESTES] Execução abortada: DB_NAME="${dbConfigurado}" não é um banco de testes isolado (use gpe_test).`
    );
  }

  if (pool && typeof pool.query === 'function') {
    const [[row]] = await pool.query('SELECT DATABASE() AS db_atual');
    const dbAtual = String(row?.db_atual || '').trim();
    if (!isCiEphemeral && (dbAtual.toLowerCase() === 'gpe' || !/(^|_|-)(test|teste)($|_|-)/i.test(dbAtual))) {
      throw new Error(
        `[SEGURANÇA DE TESTES] Execução abortada: a conexão MySQL ativa aponta para "${dbAtual}" em vez de um banco de testes isolado.`
      );
    }
    return dbAtual;
  }

  return dbConfigurado;
}

module.exports = { db, dbPromise, validarBancoDeTeste };
