// src/config/database.js
// Garante que .env está carregado (necessário quando scripts rodam fora do server.js)
if (!process.env.DB_HOST) {
  require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
}
const mysql = require('mysql2');

const db = mysql.createPool({
  host:     process.env.DB_HOST,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0
});

// Teste de conexão ao iniciar
db.getConnection((err, connection) => {
  if (err) {
    console.error('❌ Erro ao conectar ao MySQL:', err.message);
    return;
  }
  console.log('✅ Pool MySQL conectado com sucesso!');
  connection.release();
});

// Wrapper promise para uso com async/await
const dbPromise = db.promise();

module.exports = { db, dbPromise };
