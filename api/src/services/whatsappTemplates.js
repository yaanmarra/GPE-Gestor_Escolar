// src/services/whatsappTemplates.js
// Templates de mensagem do WhatsApp.
//
// Cada template tem:
//  - nome:      nome EXATO do template aprovado no Meta Business Manager (categoria UTILITY)
//  - variaveis: ordem dos parâmetros {{1}}, {{2}}... (Meta usa parâmetros posicionais)
//  - texto():   render em texto puro — usado por providers não-oficiais e para auditoria
//
// LGPD: conteúdo mínimo necessário (primeiro nome do aluno, sem dados sensíveis).
// O link leva ao painel do responsável, que exige login.

/** "2026-10-19" | Date → "19/10/2026" */
function formatarDataBR(data) {
  if (data instanceof Date) {
    return `${String(data.getDate()).padStart(2, '0')}/${String(data.getMonth() + 1).padStart(2, '0')}/${data.getFullYear()}`;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(data));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(data);
}

const primeiroNome = (nome) => String(nome || '').trim().split(/\s+/)[0] || '';

const TEMPLATES = {
  aviso_falta: {
    nome: 'aviso_falta',
    variaveis: ['nome_responsavel', 'nome_aluno', 'turma', 'data', 'link', 'escola'],
    texto: (v) =>
      `Olá, ${v.nome_responsavel}. 👋\n` +
      `Informamos que ${v.nome_aluno} (turma ${v.turma}) foi registrado(a) como AUSENTE em ${v.data}.\n\n` +
      `Se a falta tiver motivo, acesse o painel da família:\n${v.link}\n\n` +
      `${v.escola}\n` +
      'Para não receber mais avisos por aqui, responda SAIR.',
  },
  teste_conexao: {
    nome: 'teste_conexao',
    variaveis: ['nome_responsavel', 'escola'],
    texto: (v) =>
      `Olá, ${v.nome_responsavel}! ✅ Este é um teste: você passará a receber avisos de frequência de ${v.escola} por aqui.\n` +
      'Para não receber mais, responda SAIR.',
  },
};

/**
 * Monta as variáveis do aviso de falta a partir dos dados do banco.
 * @returns {{ template: string, variaveis: object, mensagem: string }}
 */
function montarAvisoFalta({ nomeResponsavel, nomeAluno, turma, data }, { appPublicUrl, nomeEscola }) {
  const variaveis = {
    nome_responsavel: primeiroNome(nomeResponsavel),
    nome_aluno: primeiroNome(nomeAluno),
    turma: turma || 'N/A',
    data: formatarDataBR(data),
    link: `${appPublicUrl}/pais.html`,
    escola: nomeEscola,
  };
  return { template: 'aviso_falta', variaveis, mensagem: TEMPLATES.aviso_falta.texto(variaveis) };
}

function montarTesteConexao({ nomeResponsavel }, { nomeEscola }) {
  const variaveis = { nome_responsavel: primeiroNome(nomeResponsavel), escola: nomeEscola };
  return { template: 'teste_conexao', variaveis, mensagem: TEMPLATES.teste_conexao.texto(variaveis) };
}

/** Parâmetros posicionais na ordem do template (formato da Meta Cloud API). */
function parametrosPosicionais(template, variaveis) {
  const def = TEMPLATES[template];
  if (!def) throw Object.assign(new Error(`Template desconhecido: ${template}`), { permanente: true });
  return def.variaveis.map((chave) => String(variaveis?.[chave] ?? ''));
}

module.exports = {
  TEMPLATES,
  montarAvisoFalta,
  montarTesteConexao,
  parametrosPosicionais,
  formatarDataBR,
  primeiroNome,
};
