const pino = require('pino');

const isProduction = process.env.NODE_ENV === 'production';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.body.senha',
      'req.body.senhaAntiga',
      'req.body.senhaNova',
      'res.headers',
      'senha',
      'token',
      '*.senha',
      '*.token'
    ],
    remove: true, // remove campos do log para garantir segurança
  },
  // No ambiente dev, formata os logs bonito. Em prod, JSON limpo para ferramentas
  ...(isProduction ? {} : {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    },
  })
});

module.exports = logger;
