// src/utils/validadores.js

/**
 * Valida formato de e-mail.
 * @param {string} email
 * @returns {boolean}
 */
function validarEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email.trim());
}

/**
 * Valida senha (mínimo 6 caracteres).
 * @param {string} senha
 * @returns {boolean}
 */
function validarSenha(senha) {
  return typeof senha === 'string' && senha.trim().length >= 6;
}

/**
 * Valida se o tipo de usuário está no enum permitido.
 * @param {string} tipo
 * @returns {boolean}
 */
function validarTipo(tipo) {
  return ['aluno', 'pai', 'professor', 'gestor'].includes(tipo);
}

/**
 * Verifica se todos os campos obrigatórios estão presentes no body.
 * @param {string[]} campos - Lista de nomes de campos obrigatórios.
 * @param {object} body - Objeto req.body.
 * @returns {{ valido: boolean, faltando: string[] }}
 */
function validarCamposObrigatorios(campos, body) {
  const faltando = campos.filter(campo => {
    const valor = body[campo];
    return valor === undefined || valor === null || (typeof valor === 'string' && valor.trim() === '');
  });

  return {
    valido: faltando.length === 0,
    faltando,
  };
}

module.exports = {
  validarEmail,
  validarSenha,
  validarTipo,
  validarCamposObrigatorios,
};
