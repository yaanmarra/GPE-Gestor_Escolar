const express = require('express');
const router = express.Router();
const { dbPromise } = require('../config/database');

/**
 * @route GET /api/health/live
 * @desc Verifica se a aplicação está em pé
 * @access Público
 */
router.get('/live', (req, res) => {
  res.status(200).json({ status: 'UP', message: 'Servidor está vivo' });
});

/**
 * @route GET /api/health/ready
 * @desc Verifica se os serviços dependentes (Banco de Dados) estão prontos
 * @access Público
 */
router.get('/ready', async (req, res) => {
  try {
    // Tenta executar uma query simples no banco
    await dbPromise.query('SELECT 1');
    res.status(200).json({ status: 'UP', message: 'Servidor e Banco de Dados prontos' });
  } catch (error) {
    req.log.error({ err: error }, 'Healthcheck de prontidão falhou (Banco de Dados offline)');
    res.status(503).json({ status: 'DOWN', message: 'Serviço indisponível (falha no BD)' });
  }
});

module.exports = router;
