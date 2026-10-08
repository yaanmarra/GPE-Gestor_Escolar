// src/middlewares/auth.js
const { verificarAccessToken } = require('../config/jwt');

/**
 * Middleware de autenticação — verifica o JWT no header Authorization.
 * Popula `req.usuario` com { id, nome, tipo } se válido.
 */
function autenticar(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      sucesso: false,
      erro: 'Token de autenticação não fornecido. Faça login novamente.'
    });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = verificarAccessToken(token);
    req.usuario = {
      id:   decoded.id,
      nome: decoded.nome,
      tipo: decoded.tipo,
    };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        sucesso: false,
        erro: 'Token expirado. Renove sua sessão.',
        codigo: 'TOKEN_EXPIRADO'
      });
    }
    return res.status(401).json({
      sucesso: false,
      erro: 'Token inválido. Faça login novamente.'
    });
  }
}

/**
 * Middleware de autorização — verifica se o tipo do usuário está na lista permitida.
 * Deve ser usado APÓS `autenticar`.
 * @param  {...string} perfisPermitidos - Ex: 'gestor', 'professor'
 */
function autorizar(...perfisPermitidos) {
  return (req, res, next) => {
    if (!req.usuario) {
      return res.status(401).json({
        sucesso: false,
        erro: 'Usuário não autenticado.'
      });
    }

    if (!perfisPermitidos.includes(req.usuario.tipo)) {
      return res.status(403).json({
        sucesso: false,
        erro: `Acesso negado. Apenas ${perfisPermitidos.join(', ')} podem acessar esta funcionalidade.`
      });
    }

    next();
  };
}

module.exports = { autenticar, autorizar };
