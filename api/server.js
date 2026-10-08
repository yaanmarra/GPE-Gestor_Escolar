// Inicializar configuração do `.env` antes de tudo
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./swagger.json');

// Middlewares
const { errorHandler, notFound } = require('./src/middlewares/errorHandler');

// Rotas
const authRoutes = require('./src/routes/authRoutes');
const usuarioRoutes = require('./src/routes/usuarioRoutes');
const turmaRoutes = require('./src/routes/turmaRoutes');
const presencaRoutes = require('./src/routes/presencaRoutes');
const healthRoutes = require('./src/routes/healthRoutes');

const logger = require('./src/utils/logger');
const pinoHttp = require('pino-http');
const rateLimit = require('express-rate-limit');

const app = express();
// CORS configurável por ambiente
const corsOptions = {
  origin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
    : ['http://localhost:5500', 'http://127.0.0.1:5500', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));
app.use(express.json());

// Log estruturado em requisições
app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url.startsWith('/api/health') } }));

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // Limite por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { sucesso: false, erro: 'Muitas requisições deste IP, tente novamente mais tarde.' }
});
// Aplica a taxa limite apenas nas rotas de API
app.use('/api', limiter);

// Documentação Swagger
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Teste de integridade base
app.get('/', (req, res) => res.send('Servidor GPE está rodando 🚀'));

// Registro de Rotas (Prefixadas com /api)
app.use('/api/health', healthRoutes);
app.use('/api', authRoutes);
app.use('/api', usuarioRoutes);
app.use('/api/turmas', turmaRoutes);
app.use('/api', presencaRoutes);

// Handlers de erro
app.use(notFound);
app.use(errorHandler);

const server = require('http').createServer(app);

// Worker de e-mail: por padrão roda no mesmo processo (mantém o comportamento
// "npm start envia e-mails"). Para rodar separado: EMAIL_WORKER_INLINE=false + npm run worker.
// Vários workers simultâneos são seguros (claim com SKIP LOCKED).
const { iniciarWorker, pararWorker } = require('./src/workers/emailWorker');

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    logger.info(`🚀 Servidor rodando na porta ${PORT}`);
  });

  if (process.env.EMAIL_WORKER_INLINE !== 'false') {
    iniciarWorker();
  }

  async function encerrar(sinal) {
    logger.info(`${sinal} recebido, encerrando...`);
    server.close();
    await pararWorker();
    process.exit(0);
  }
  process.on('SIGINT', () => encerrar('SIGINT'));
  process.on('SIGTERM', () => encerrar('SIGTERM'));
}

module.exports = { app, server };
