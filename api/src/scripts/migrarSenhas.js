const bcrypt = require('bcryptjs');
const { dbPromise } = require('../config/database');

async function migrar() {
  console.log('Iniciando migração de senhas...');
  try {
    const [usuarios] = await dbPromise.query('SELECT id, senha FROM usuarios');
    
    let count = 0;
    for (const user of usuarios) {
      // Se a senha já parece um hash do bcrypt (começa com $2a$, $2b$ ou $2y$), ignorar
      if (!user.senha.startsWith('$2')) {
        const hash = await bcrypt.hash(user.senha, 12);
        await dbPromise.query('UPDATE usuarios SET senha = ? WHERE id = ?', [hash, user.id]);
        count++;
      }
    }
    console.log(`Migração concluída! ${count} senhas foram atualizadas com bcrypt.`);
  } catch (err) {
    console.error('Erro na migração:', err);
  } finally {
    process.exit(0);
  }
}

migrar();
