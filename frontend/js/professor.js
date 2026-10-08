// ============================================================
// GPE — professor.js  (Sprint 2 — Redesign Completo)
// ============================================================

// Usa API_BASE_URL de config.js (carregado antes deste script)
// Controle de acesso gerenciado no auth.js

const professorId = localStorage.getItem('usuario_id') || 1;
const nomeProf    = localStorage.getItem('nome') || 'Professor';

// ─── INIT UI ──────────────────────────────────────────────
document.getElementById('nomeProf').textContent     = nomeProf.split(' ')[0];
document.getElementById('sidebarNome').textContent  = nomeProf;
document.getElementById('sidebarAvatar').textContent = nomeProf.charAt(0).toUpperCase();
document.getElementById('topbarDate').textContent =
  new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
document.getElementById('sel-data').value = new Date().toISOString().split('T')[0];

// ─── NAVEGAÇÃO ────────────────────────────────────────────
const LABELS = { dashboard: 'Dashboard', chamada: 'Fazer Chamada', historico: 'Histórico' };
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    const sec = btn.dataset.section;
    document.getElementById(`section-${sec}`).classList.add('active');
    document.getElementById('breadcrumb').textContent = LABELS[sec] || sec;
    document.getElementById('sidebar').classList.remove('open');
    if (sec === 'dashboard') carregarDashboard();
    if (sec === 'historico') inicHistorico();
  });
});

document.getElementById('menuToggle').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
});
document.getElementById('btnSair').addEventListener('click', () => {
  if (typeof window.fazerLogout === 'function') window.fazerLogout();
  else { localStorage.clear(); location.href = 'index.html'; }
});

// ============================================================
// DASHBOARD
// ============================================================
let chartTurmas = null;

async function carregarDashboard() {
  try {
    const [rTurmas, rRelatorio] = await Promise.all([
      window.apiFetch('/turmas'),
      window.apiFetch('/relatorio-frequencia')
    ]);
    const turmas    = await rTurmas.json();
    const relatorio = await rRelatorio.json();

    document.getElementById('dash-turmas').textContent = turmas.filter(t => t.ativa).length;

    // Totais de hoje
    const hoje = new Date().toISOString().split('T')[0];
    const rHoje = await window.apiFetch('/presencas');
    const pHoje = await rHoje.json();
    const presHoje  = pHoje.filter(p => p.data?.split('T')[0] === hoje && p.status === 'presente').length;
    const faltHoje  = pHoje.filter(p => p.data?.split('T')[0] === hoje && p.status === 'falta').length;
    document.getElementById('dash-presencas').textContent = presHoje;
    document.getElementById('dash-faltas').textContent    = faltHoje;

    // Alunos em risco
    let risco = 0;
    relatorio.forEach(r => {
      const tot = +r.presencas + +r.faltas + +r.justificadas;
      const pct = tot > 0 ? (+r.presencas / tot) * 100 : 100;
      if (pct < 75) risco++;
    });
    document.getElementById('dash-risco').textContent = risco;

    // Lista de turmas
    const lista = document.getElementById('turmas-lista');
    const ativas = turmas.filter(t => t.ativa);
    if (!ativas.length) {
      lista.innerHTML = '<div class="empty-state"><span class="empty-icon">🏫</span><p>Nenhuma turma ativa.</p></div>';
    } else {
      lista.innerHTML = ativas.map(t => `
        <div class="turma-item">
          <div class="turma-info">
            <div class="turma-nome">${t.nome}</div>
            <div class="turma-meta">${t.turno || '—'} · ${t.total_alunos} alunos · ${t.ano}</div>
          </div>
          <button class="turma-btn" onclick="irParaChamada(${t.id})">📋 Chamada</button>
        </div>
      `).join('');
    }

    // Gráfico de barras por turma
    if (chartTurmas) { chartTurmas.destroy(); chartTurmas = null; }
    if (ativas.length) {
      // Busca frequência por turma
      const pctPorTurma = await Promise.all(
        ativas.map(async t => {
          try {
            const r = await window.apiFetch(`/presencas-turma?turma_id=${t.id}&data=${hoje}`);
            const d = await r.json();
            const pres = d.filter(p => p.status === 'presente').length;
            const tot  = d.length;
            return { nome: t.nome, pct: tot > 0 ? Math.round(pres / tot * 100) : 0, total: tot };
          } catch { return { nome: t.nome, pct: 0, total: 0 }; }
        })
      );

      const ctx = document.getElementById('chartTurmas').getContext('2d');
      chartTurmas = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: pctPorTurma.map(t => t.nome),
          datasets: [{
            label: '% Presença Hoje',
            data: pctPorTurma.map(t => t.pct),
            backgroundColor: pctPorTurma.map(t =>
              t.pct >= 75 ? 'rgba(22,163,74,0.7)' :
              t.pct >= 60 ? 'rgba(217,119,6,0.7)' : 'rgba(220,38,38,0.7)'
            ),
            borderRadius: 6,
            borderSkipped: false,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            y: { beginAtZero: true, max: 100, ticks: { callback: v => v + '%' }, grid: { color: '#f1f5f9' } },
            x: { grid: { display: false } }
          }
        }
      });
    }

  } catch (err) {
    console.error('Erro dashboard:', err);
  }
}

function irParaChamada(turmaId) {
  document.querySelector('[data-section="chamada"]').click();
  setTimeout(() => {
    document.getElementById('sel-turma').value = turmaId;
    document.getElementById('btn-iniciar').disabled = false;
  }, 100);
}

// ============================================================
// CHAMADA SEQUENCIAL
// ============================================================
let alunosDaTurma   = [];
let statusMap       = {};   // { aluno_id: 'presente'|'falta'|'justificado'|null }
let indiceAtual     = -1;   // -1 = não iniciado, >= length = concluído

const selTurma   = document.getElementById('sel-turma');
const selData    = document.getElementById('sel-data');
const btnIniciar = document.getElementById('btn-iniciar');
const progTexto  = document.getElementById('prog-texto');
const progPct    = document.getElementById('prog-pct');
const progFill   = document.getElementById('prog-fill');
const listaEl    = document.getElementById('chamada-lista');
const vazioEl    = document.getElementById('chamada-vazio');
const progressEl = document.getElementById('chamada-progress');
const footerEl   = document.getElementById('chamada-footer');
const msgSave    = document.getElementById('msg-save');
const btnSalvar  = document.getElementById('btn-salvar');
const btnRefazer = document.getElementById('btn-refazer');

// Carregar turmas nos selects
async function carregarSelectTurmas() {
  try {
    const r = await window.apiFetch('/turmas');
    const turmas = await r.json();
    const ativas = turmas.filter(t => t.ativa);

    [selTurma, document.getElementById('hist-turma-sel')].forEach(sel => {
      const vazio = sel.options[0].outerHTML;
      sel.innerHTML = vazio + ativas.map(t =>
        `<option value="${t.id}">${t.nome} (${t.turno || '—'}) · ${t.total_alunos} alunos</option>`
      ).join('');
    });
  } catch (e) { console.error(e); }
}

selTurma.addEventListener('change', () => {
  btnIniciar.disabled = !selTurma.value;
  // Reset da chamada se trocar turma
  resetChamada();
});

btnIniciar.addEventListener('click', iniciarChamada);

async function iniciarChamada() {
  const turmaId = selTurma.value;
  const data    = selData.value;
  if (!turmaId || !data) return;

  btnIniciar.disabled = true;
  btnIniciar.textContent = '⏳ Carregando...';
  resetChamada(false);

  try {
    const [rAlunos, rSalvos] = await Promise.all([
      window.apiFetch(`/turmas/${turmaId}/alunos`),
      window.apiFetch(`/presencas-turma?turma_id=${turmaId}&data=${data}`)
    ]);
    alunosDaTurma = await rAlunos.json();
    const salvos  = await rSalvos.json().catch(() => []);

    if (!alunosDaTurma.length) {
      vazioEl.innerHTML = '<span class="empty-icon">😕</span><p>Nenhum aluno nesta turma.</p>';
      btnIniciar.disabled  = false;
      btnIniciar.textContent = '▶ Iniciar Chamada';
      return;
    }

    // Ordenar por nome
    alunosDaTurma.sort((a, b) => a.nome.localeCompare(b.nome));

    // Pre-preencher com dados já salvos
    statusMap = {};
    alunosDaTurma.forEach(a => { statusMap[a.id] = null; });
    salvos.forEach(s => { statusMap[s.aluno_id] = s.status; });

    // Determinar onde continuar (primeiro sem status)
    indiceAtual = alunosDaTurma.findIndex(a => statusMap[a.id] === null);
    if (indiceAtual === -1) indiceAtual = alunosDaTurma.length; // todos marcados

    vazioEl.classList.add('hidden');
    progressEl.classList.remove('hidden');
    listaEl.classList.remove('hidden');
    footerEl.classList.remove('hidden');

    renderLista();
    atualizarProgresso();
    scrollParaAtual();
    listaEl.focus();

    if (salvos.length > 0) {
      msgSave.textContent = '⚠ Chamada já registrada. Editando...';
      msgSave.className   = 'save-msg err';
    }

  } catch (err) {
    console.error(err);
    vazioEl.innerHTML = '<span class="empty-icon">❌</span><p>Erro ao carregar alunos.</p>';
  } finally {
    btnIniciar.disabled    = false;
    btnIniciar.textContent = '▶ Iniciar Chamada';
  }
}

function resetChamada(showVazio = true) {
  alunosDaTurma = [];
  statusMap     = {};
  indiceAtual   = -1;
  listaEl.innerHTML = '';
  if (showVazio) {
    vazioEl.innerHTML = '<span class="empty-icon">📋</span><p>Selecione uma turma e data para iniciar a chamada.</p>';
    vazioEl.classList.remove('hidden');
  }
  progressEl.classList.add('hidden');
  listaEl.classList.add('hidden');
  footerEl.classList.add('hidden');
  msgSave.textContent = '';
}

// ─── RENDER ──────────────────────────────────────────────
function renderLista() {
  listaEl.innerHTML = '';

  alunosDaTurma.forEach((aluno, idx) => {
    const st       = statusMap[aluno.id];
    const isAtual  = idx === indiceAtual;
    const isPend   = st === null && !isAtual;

    const item = document.createElement('div');
    item.className = `chamada-item ${isAtual ? 'atual' : (st || 'pendente')}`;
    item.dataset.idx = idx;
    item.dataset.id  = aluno.id;

    const badgeTxt = isAtual ? '← aqui' : (st || '—');
    const badgeCls = isAtual ? 'atual'   : (st || 'pendente');

    item.innerHTML = `
      <span class="aluno-num">${idx + 1}</span>
      <div class="aluno-avatar">${aluno.nome.charAt(0).toUpperCase()}</div>
      <span class="aluno-nome">${aluno.nome}</span>
      ${isAtual ? '<span class="atual-indicator">▶</span>' : ''}
      <div class="item-actions">
        <button class="act-btn act-p" data-act="presente">✓ Presente</button>
        <button class="act-btn act-f" data-act="falta">✗ Falta</button>
        <button class="act-btn act-j" data-act="justificado">⚠ Just.</button>
      </div>
      <span class="status-badge ${badgeCls}">${badgeTxt === 'presente' ? '✓ Presente' : badgeTxt === 'falta' ? '✗ Falta' : badgeTxt === 'justificado' ? '⚠ Just.' : badgeTxt === '← aqui' ? '← aqui' : '—'}</span>
    `;

    // Clique nos botões do item
    item.querySelectorAll('.act-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        marcarEAvancar(btn.dataset.act);
      });
    });

    // Clique no item = ir para ele
    item.addEventListener('click', () => {
      if (indiceAtual === alunosDaTurma.length) return;
      indiceAtual = idx;
      renderLista();
      scrollParaAtual();
    });

    listaEl.appendChild(item);
  });
}

function marcarEAvancar(status) {
  if (indiceAtual < 0 || indiceAtual >= alunosDaTurma.length) return;
  const aluno = alunosDaTurma[indiceAtual];
  statusMap[aluno.id] = status;

  // Avança
  indiceAtual++;

  renderLista();
  atualizarProgresso();
  scrollParaAtual();

  if (indiceAtual >= alunosDaTurma.length) {
    // Chamada concluída!
    renderResumoFinal();
  }
}

function marcarSemAvancar(status) {
  if (indiceAtual < 0 || indiceAtual >= alunosDaTurma.length) return;
  const aluno = alunosDaTurma[indiceAtual];
  statusMap[aluno.id] = status;
  renderLista();
  atualizarProgresso();
}

function voltarUm() {
  if (indiceAtual <= 0) return;
  indiceAtual--;
  renderLista();
  atualizarProgresso();
  scrollParaAtual();
}

function atualizarProgresso() {
  const chamados = Object.values(statusMap).filter(s => s !== null).length;
  const total    = alunosDaTurma.length;
  const pct      = total > 0 ? Math.round(chamados / total * 100) : 0;

  progTexto.textContent = `${chamados} / ${total} alunos chamados`;
  progPct.textContent   = pct + '%';
  progFill.style.width  = pct + '%';
}

function scrollParaAtual() {
  const el = listaEl.querySelector('.chamada-item.atual');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderResumoFinal() {
  const pres = Object.values(statusMap).filter(s => s === 'presente').length;
  const falt = Object.values(statusMap).filter(s => s === 'falta').length;
  const just = Object.values(statusMap).filter(s => s === 'justificado').length;

  document.getElementById('chamada-resumo').innerHTML = `
    <div class="resumo-item">
      <div class="resumo-dot" style="background:var(--green)"></div>
      <span>${pres} Presentes</span>
    </div>
    <div class="resumo-item">
      <div class="resumo-dot" style="background:var(--red)"></div>
      <span>${falt} Faltas</span>
    </div>
    <div class="resumo-item">
      <div class="resumo-dot" style="background:var(--yellow)"></div>
      <span>${just} Justificados</span>
    </div>
    <div class="resumo-item" style="color:var(--blue);font-weight:700;">
      ✅ Chamada concluída!
    </div>
  `;
}

// ─── TECLADO ─────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  // Ignorar quando foco está em input/select
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;

  // Só funciona na seção de chamada
  const secChamada = document.getElementById('section-chamada');
  if (!secChamada.classList.contains('active')) return;
  if (indiceAtual < 0 || indiceAtual >= alunosDaTurma.length) return;

  if (e.key === 'Enter') {
    e.preventDefault();
    marcarEAvancar('presente');
  } else if (e.key === ' ') {
    e.preventDefault();
    marcarEAvancar('falta');
  } else if (e.key === 'j' || e.key === 'J') {
    marcarEAvancar('justificado');
  } else if (e.key === 'Backspace' || e.key === 'ArrowLeft') {
    e.preventDefault();
    voltarUm();
  } else if (e.key === 'p' || e.key === 'P') {
    marcarSemAvancar('presente');
  } else if (e.key === 'f' || e.key === 'F') {
    marcarSemAvancar('falta');
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    indiceAtual = Math.min(indiceAtual + 1, alunosDaTurma.length - 1);
    renderLista(); scrollParaAtual();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    indiceAtual = Math.max(indiceAtual - 1, 0);
    renderLista(); scrollParaAtual();
  }
});

// ─── SALVAR ───────────────────────────────────────────────
btnSalvar.addEventListener('click', salvarFrequencia);

async function salvarFrequencia() {
  const data = selData.value;
  if (!data) { alert('Selecione a data.'); return; }

  // Checar pendentes
  const pendentes = alunosDaTurma.filter(a => statusMap[a.id] === null);
  if (pendentes.length) {
    const ok = confirm(`${pendentes.length} aluno(s) sem status. Marcar como FALTA?`);
    if (ok) pendentes.forEach(a => { statusMap[a.id] = 'falta'; });
    else return;
  }

  const payload = {
    professor_id: professorId,
    data,
    presencas: alunosDaTurma.map(a => ({ aluno_id: a.id, status: statusMap[a.id] }))
  };

  btnSalvar.disabled    = true;
  btnSalvar.textContent = 'Salvando...';

  try {
    const r    = await window.apiFetch(`/registrar-presenca-turma`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    const resp = await r.json();

    if (r.ok) {
      msgSave.textContent = `✅ ${resp.mensagem}`;
      msgSave.className   = 'save-msg ok';
      renderLista();
      renderResumoFinal();
    } else {
      msgSave.textContent = `❌ ${resp.erro || 'Erro ao salvar.'}`;
      msgSave.className   = 'save-msg err';
    }
  } catch {
    msgSave.textContent = '❌ Erro ao conectar ao servidor.';
    msgSave.className   = 'save-msg err';
  } finally {
    btnSalvar.disabled    = false;
    btnSalvar.textContent = '💾 Salvar Frequência';
  }
}

btnRefazer.addEventListener('click', () => {
  indiceAtual = 0;
  alunosDaTurma.forEach(a => { statusMap[a.id] = null; });
  msgSave.textContent = '';
  renderLista();
  atualizarProgresso();
  scrollParaAtual();
});

// ============================================================
// HISTÓRICO
// ============================================================
let histDados    = [];
let histFiltrado = [];

function inicHistorico() {
  const hoje = new Date().toISOString().split('T')[0];
  const umMesAtras = new Date();
  umMesAtras.setMonth(umMesAtras.getMonth() - 1);
  document.getElementById('hist-data-ini').value = umMesAtras.toISOString().split('T')[0];
  document.getElementById('hist-data-fim').value = hoje;
}

document.getElementById('btn-hist-buscar').addEventListener('click', buscarHistorico);
document.getElementById('hist-busca').addEventListener('input', filtrarHistorico);

async function buscarHistorico() {
  const turmaId = document.getElementById('hist-turma-sel').value;
  const ini     = document.getElementById('hist-data-ini').value;
  const fim     = document.getElementById('hist-data-fim').value;
  const tbody   = document.getElementById('hist-tbody');
  const meta    = document.getElementById('hist-meta');

  tbody.innerHTML = '<tr><td colspan="4" class="loading-cell">Buscando...</td></tr>';

  try {
    const r = await window.apiFetch('/presencas');
    histDados = await r.json();

    // Filtrar por turma se especificada
    if (turmaId) {
      const rA = await window.apiFetch(`/turmas/${turmaId}/alunos`);
      const al = await rA.json();
      const nomes = new Set(al.map(a => a.nome));
      histDados = histDados.filter(p => nomes.has(p.aluno));
    }

    // Filtrar por data
    if (ini) histDados = histDados.filter(p => p.data?.split('T')[0] >= ini);
    if (fim) histDados = histDados.filter(p => p.data?.split('T')[0] <= fim);

    histFiltrado = [...histDados];
    renderHistorico();
    meta.textContent = `${histDados.length} registros`;
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="4" class="loading-cell">Erro ao carregar.</td></tr>';
  }
}

function filtrarHistorico() {
  const q = document.getElementById('hist-busca').value.toLowerCase().trim();
  histFiltrado = q ? histDados.filter(p => p.aluno.toLowerCase().includes(q)) : [...histDados];
  renderHistorico();
  document.getElementById('hist-meta').textContent = `${histFiltrado.length} registros`;
}

function renderHistorico() {
  const tbody = document.getElementById('hist-tbody');
  if (!histFiltrado.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="loading-cell">Nenhum registro encontrado.</td></tr>';
    return;
  }
  tbody.innerHTML = histFiltrado.map(p => `
    <tr>
      <td><strong>${p.aluno}</strong></td>
      <td>${new Date(p.data).toLocaleDateString('pt-BR')}</td>
      <td>—</td>
      <td><span class="badge badge-${p.status}">${p.status}</span></td>
    </tr>
  `).join('');
}

// ============================================================
// INIT
// ============================================================
window.addEventListener('DOMContentLoaded', async () => {
  await carregarSelectTurmas();
  carregarDashboard();
  inicHistorico();
});
