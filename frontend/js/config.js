// ============================================================
// GPE — config.js (Configuração Global do Frontend)
// ============================================================

/**
 * URL base da API.
 * Altere aqui para apontar para produção quando necessário.
 */
const API_BASE_URL = 'http://localhost:3000/api';

function escapeHtml(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
