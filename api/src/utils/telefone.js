// src/utils/telefone.js
// Normalização de telefones brasileiros para E.164 (+55DDDNÚMERO).

// DDDs válidos no Brasil (Anatel).
const DDDS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

/**
 * Normaliza um celular brasileiro para E.164.
 * Aceita "(11) 99999-8888", "11999998888", "+55 11 99999-8888", "5511999998888".
 * Só aceita celular (9 dígitos começando com 9) — WhatsApp em fixo é raro e
 * normalmente indica erro de cadastro.
 * @returns {string|null} "+5511999998888" ou null se inválido.
 */
function normalizarTelefoneBR(entrada) {
  if (entrada === null || entrada === undefined) return null;
  let d = String(entrada).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 13 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 12 && d.startsWith('0')) d = d.slice(1); // 0 + DDD + número
  if (d.length !== 11) return null;

  const ddd = Number(d.slice(0, 2));
  const numero = d.slice(2);
  if (!DDDS.has(ddd)) return null;
  if (!numero.startsWith('9')) return null;
  if (/^(\d)\1+$/.test(numero)) return null; // 999999999 etc.
  return `+55${d}`;
}

/**
 * O WhatsApp às vezes devolve números BR sem o 9º dígito (wa_id legado).
 * Retorna as duas variantes em E.164 para comparação.
 */
function variantesBR(numero) {
  const d = String(numero || '').replace(/\D/g, '');
  const sem55 = d.startsWith('55') ? d.slice(2) : d;
  if (sem55.length === 11) return [`+55${sem55}`, `+55${sem55.slice(0, 2)}${sem55.slice(3)}`];
  if (sem55.length === 10) return [`+55${sem55.slice(0, 2)}9${sem55.slice(2)}`, `+55${sem55}`];
  return [`+${d}`];
}

/** "+5511999998888" → "+55 11 9****-8888" (para logs sem expor o número). */
function mascararTelefone(e164) {
  const d = String(e164 || '').replace(/\D/g, '');
  if (d.length < 8) return '***';
  return `+${d.slice(0, 2)} ${d.slice(2, 4)} ${d[4]}****-${d.slice(-4)}`;
}

module.exports = { normalizarTelefoneBR, variantesBR, mascararTelefone };
