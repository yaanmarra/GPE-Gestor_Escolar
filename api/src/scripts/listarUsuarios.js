// src/scripts/listarUsuarios.js
const { dbPromise } = require('../config/database');

async function listar() {
  try {
    const [usuarios] = await dbPromise.query(`
      SELECT 
        u.id,
        u.nome,
        u.email AS login,
        u.tipo AS perfil,
        p.disciplina,
        pa.telefone,
        t.nome AS turma,
        u.senha AS hash_senha
      FROM usuarios u
      LEFT JOIN professores p ON p.usuario_id = u.id
      LEFT JOIN pais pa ON pa.usuario_id = u.id
      LEFT JOIN alunos a ON a.usuario_id = u.id
      LEFT JOIN turmas t ON t.id = a.turma_id
      ORDER BY u.id ASC;
    `);

    console.log('\n📋 --- LISTAGEM DE USUÁRIOS (GPE) ---');
    console.table(
      usuarios.map(u => ({
        ID: u.id,
        Nome: u.nome,
        Login_Email: u.login,
        Perfil: u.perfil,
        Detalhe: u.disciplina || u.telefone || (u.turma ? `Turma: ${u.turma}` : '-')
      }))
    );

    console.log('\n💡 Nota: A senha de todos os usuários de teste padrão é: 123456');
    console.log('No banco de dados, a coluna `senha` armazena o hash criptografado com bcrypt.\n');
  } catch (err) {
    console.error('❌ Erro ao consultar usuários:', err);
  } finally {
    process.exit(0);
  }
}

listar();
