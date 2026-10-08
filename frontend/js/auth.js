// ============================================================
// GPE — auth.js (Gerenciamento Global de Autenticação JWT)
// ============================================================
// Usa API_BASE_URL definida em config.js (carregado antes deste script)
const API_BASE = API_BASE_URL;

/**
 * Retorna o Access Token salvo no localStorage.
 */
function getAccessToken() {
  return localStorage.getItem('access_token');
}

/**
 * Retorna o Refresh Token salvo no localStorage.
 */
function getRefreshToken() {
  return localStorage.getItem('refresh_token');
}

/**
 * Salva os tokens no localStorage.
 */
function setTokens(accessToken, refreshToken) {
  if (accessToken) localStorage.setItem('access_token', accessToken);
  if (refreshToken) localStorage.setItem('refresh_token', refreshToken);
}

/**
 * Remove todos os dados de sessão e redireciona para o login.
 */
function limparSessao() {
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
  localStorage.removeItem('usuario_id');
  localStorage.removeItem('nome');
  localStorage.removeItem('tipo');
  window.location.href = 'index.html';
}

/**
 * Tenta renovar o Access Token usando o Refresh Token.
 * @returns {Promise<boolean>} Retorna true se renovou com sucesso, false caso contrário.
 */
async function renovarToken() {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;

  try {
    const res = await fetch(`${API_BASE}/refresh-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken })
    });

    const data = await res.json();
    if (res.ok && data.sucesso) {
      setTokens(data.dados.accessToken, null);
      return true;
    }
    return false;
  } catch (err) {
    console.error('Erro ao renovar token:', err);
    return false;
  }
}

/**
 * Wrapper para a API `fetch` que injeta o token JWT e lida com renovação automática (Refresh Token).
 * @param {string} endpoint - O caminho da API (ex: '/usuarios'). Não incluir a base da URL.
 * @param {RequestInit} options - Opções do fetch (method, headers, body, etc).
 */
async function apiFetch(endpoint, options = {}) {
  // Configurar headers padrão
  if (!options.headers) options.headers = {};
  if (!options.headers['Content-Type']) {
    options.headers['Content-Type'] = 'application/json';
  }

  // Injetar token
  let token = getAccessToken();
  if (token) {
    options.headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    let res = await fetch(`${API_BASE}${endpoint}`, options);

    // Se o token estiver expirado (401), tentamos renovar 1 vez
    if (res.status === 401) {
      const data = await res.json().catch(() => ({}));
      // Verifica pelo código customizado ou pelo status
      if (data.codigo === 'TOKEN_EXPIRADO' || data.erro?.toLowerCase().includes('expirado')) {
        const renovou = await renovarToken();
        if (renovou) {
          // Atualiza o token nos headers e refaz a requisição original
          token = getAccessToken();
          options.headers['Authorization'] = `Bearer ${token}`;
          res = await fetch(`${API_BASE}${endpoint}`, options);
        } else {
          // Não conseguiu renovar, forçar logout
          alert('Sua sessão expirou. Por favor, faça login novamente.');
          limparSessao();
          throw new Error('Sessão expirada');
        }
      } else {
        // Outro erro de autenticação (token inválido, etc)
        alert('Acesso negado. Faça login novamente.');
        limparSessao();
      }
    }

    // Intercepta res.json() para desempacotar o padrão da Entrega 1 { sucesso: true, dados: ... }
    // e o padrão paginado da Fase 5 { sucesso: true, dados: { dados: [...], meta: {...} } }
    const originalJson = res.json.bind(res);
    res.json = async () => {
      const payload = await originalJson();
      if (payload && typeof payload === 'object' && payload.sucesso === true && payload.dados !== undefined) {
        if (Array.isArray(payload.dados)) {
          payload.dados.sucesso = true;
          payload.dados.dados = payload.dados;
          return payload.dados;
        }
        if (typeof payload.dados === 'object' && payload.dados !== null) {
          // Se for resposta paginada { dados: Array, meta: Object }
          if (Array.isArray(payload.dados.dados)) {
            const arr = payload.dados.dados;
            arr.meta = payload.dados.meta;
            arr.sucesso = true;
            arr.dados = arr;
            return arr;
          }
          if (payload.dados.sucesso === undefined) payload.dados.sucesso = true;
          if (payload.mensagem && !payload.dados.mensagem) payload.dados.mensagem = payload.mensagem;
          return payload.dados;
        }
      }
      return payload;
    };

    return res;
  } catch (err) {
    if (err.message !== 'Sessão expirada' && err.message !== 'Acesso negado') {
      console.error(`Erro no fetch para ${endpoint}:`, err);
    }
    throw err;
  }
}

/**
 * Realiza o logout chamando a API para invalidar o refresh token e limpando o localStorage.
 */
async function fazerLogout() {
  const refreshToken = getRefreshToken();
  if (refreshToken) {
    try {
      await fetch(`${API_BASE}/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken })
      });
    } catch (e) {
      console.error('Erro ao comunicar logout para a API:', e);
    }
  }
  limparSessao();
}

// Verifica proteção de rotas privadas
const paginaAtual = window.location.pathname.split('/').pop();
const isLogin = paginaAtual === '' || paginaAtual === 'index.html';
// Proteção de rotas privadas: sem token → redireciona para login
if (!isLogin && !getAccessToken()) {
  alert('Acesso restrito. Faça login.');
  limparSessao();
}

window.apiFetch = apiFetch;
window.fazerLogout = fazerLogout;
window.setTokens = setTokens;
