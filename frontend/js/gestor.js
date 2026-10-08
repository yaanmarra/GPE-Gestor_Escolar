// ============================================================
// GPE — gestor.js  (Sprint 2 — Gestor com Chamada)
// ============================================================

// Usa API_BASE_URL de config.js (carregado antes deste script)
// Controle de acesso agora é gerenciado pelo auth.js

// ─── TOPBAR DATE ─────────────────────────────────────────
document.getElementById('topbarDate').textContent =
  new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });

// ─── NAVEGAÇÃO ────────────────────────────────────────────
const navItems   = document.querySelectorAll('.nav-item');
const sections   = document.querySelectorAll('.section');
const breadcrumb = document.getElementById('breadcrumbText');

const sectionLabels = {
  dashboard:  'Dashboard',
  chamada:    'Chamada',
  frequencia: 'Frequência',
  turmas:     'Turmas',
  usuarios:   'Usuários',
  cadastro:   'Cadastrar Usuário',
};

navItems.forEach(item => {
  item.addEventListener('click', () => {
    const target = item.dataset.section;
    navItems.forEach(n => n.classList.remove('active'));
    item.classList.add('active');
    sections.forEach(s => s.classList.remove('active'));
    document.getElementById(`section-${target}`).classList.add('active');
    breadcrumb.textContent = sectionLabels[target] || target;
    document.getElementById('sidebar').classList.remove('open');
    if (target === 'dashboard')  carregarDashboard();
    if (target === 'chamada')    inicChamadaGestor();
    if (target === 'frequencia') carregarRelatorio();
    if (target === 'turmas')     carregarTurmas();
    if (target === 'usuarios')   carregarUsuarios();
  });
});

document.getElementById('menuToggle').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
});

// ─── TABS ────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

// ─── SAIR ────────────────────────────────────────────────
document.getElementById('btnSair').addEventListener('click', () => {
  if (typeof window.fazerLogout === 'function') {
    window.fazerLogout();
  } else {
    localStorage.clear();
    window.location.href = 'index.html';
  }
});

// ─── CAMPOS DINÂMICOS DE CADASTRO ───────────────────────
document.getElementById('tipo').addEventListener('change', async function () {
  document.getElementById('camposAluno').style.display     = this.value === 'aluno'     ? 'block' : 'none';
  document.getElementById('camposPai').style.display       = this.value === 'pai'       ? 'block' : 'none';
  document.getElementById('camposProfessor').style.display = this.value === 'professor' ? 'block' : 'none';
  if (this.value === 'aluno') await carregarSelectsTurmaEPai();
});

async function carregarSelectsTurmaEPai() {
  const avisoEl  = document.getElementById('avisoSemTurma');
  const formEl   = document.getElementById('camposAlunoForm');
  const selTurma = document.getElementById('turma_id');
  const selPai   = document.getElementById('pai_id');
  selTurma.innerHTML = '<option value="">Carregando...</option>';
  selPai.innerHTML   = '<option value="">Carregando...</option>';
  try {
    const [rTurmas, rPais] = await Promise.all([window.apiFetch(`/turmas`), window.apiFetch(`/pais`)]);
    const turmas = await rTurmas.json();
    const paisRaw = await rPais.json();
    const pais = Array.isArray(paisRaw) ? paisRaw : (Array.isArray(paisRaw?.dados) ? paisRaw.dados : []);
    const ativas = (Array.isArray(turmas) ? turmas : (turmas?.dados || [])).filter(t => t.ativa);
    if (!ativas.length) { avisoEl.style.display = 'block'; formEl.style.display = 'none'; return; }
    avisoEl.style.display = 'none';
    formEl.style.display  = 'block';
    selTurma.innerHTML = '<option value="">Selecione a turma...</option>' +
      ativas.map(t => `<option value="${t.id}">${t.nome} — ${t.ano} (${t.turno})</option>`).join('');
    selPai.innerHTML = '<option value="">Selecione o responsável...</option>' +
      pais.map(p => `<option value="${p.id}">${p.nome}${p.telefone ? ' — ' + p.telefone : ''}</option>`).join('');
  } catch {
    selTurma.innerHTML = '<option value="">Erro ao carregar</option>';
    selPai.innerHTML   = '<option value="">Erro ao carregar</option>';
  }
}

function irParaTurmas() { document.querySelector('[data-section="turmas"]').click(); }

// ─── UTILS ───────────────────────────────────────────────
function showMsg(el, texto, tipo) { el.textContent = texto; el.className = `form-message ${tipo}`; }
function corFrequencia(pct) { return pct >= 75 ? '#16a34a' : pct >= 60 ? '#d97706' : '#dc2626'; }
function badgeStatus(pct) {
  if (pct >= 75) return '<span class="badge badge-ok">Regular</span>';
  if (pct >= 60) return '<span class="badge badge-risco">Risco</span>';
  return '<span class="badge badge-critico">Crítico</span>';
}

// ─── GRÁFICOS ────────────────────────────────────────────
let chartDonut = null, chartBarras = null, chartLinha = null;

function destruirGraficos() {
  if (chartDonut)  { chartDonut.destroy();  chartDonut  = null; }
  if (chartBarras) { chartBarras.destroy(); chartBarras = null; }
  if (chartLinha)  { chartLinha.destroy();  chartLinha  = null; }
}

async function carregarDashboard() {
  try {
    const [relResp, alunosResp] = await Promise.all([
      window.apiFetch(`/relatorio-frequencia`),
      window.apiFetch(`/alunos`),
    ]);
    const relRaw = await relResp.json();
    const relatorio = Array.isArray(relRaw) ? relRaw : (Array.isArray(relRaw?.dados) ? relRaw.dados : []);
    const alunosRaw = await alunosResp.json();
    const alunos    = Array.isArray(alunosRaw) ? alunosRaw : (Array.isArray(alunosRaw?.dados) ? alunosRaw.dados : []);
    let totalPresencas = 0, totalFaltas = 0, totalJustificadas = 0, emRisco = 0;
    relatorio.forEach(row => {
      totalPresencas    += Number(row.presencas    || 0);
      totalFaltas       += Number(row.faltas       || 0);
      totalJustificadas += Number(row.justificadas || 0);
      const total = Number(row.presencas||0) + Number(row.faltas||0) + Number(row.justificadas||0);
      const pct   = total > 0 ? (row.presencas / total) * 100 : 100;
      if (pct < 75) emRisco++;
    });
    document.getElementById('statTotalAlunos').textContent = alunos.length;
    document.getElementById('statPresencas').textContent   = totalPresencas;
    document.getElementById('statFaltas').textContent      = totalFaltas;
    document.getElementById('statRisco').textContent       = emRisco;
    destruirGraficos();
    desenharDonut(totalPresencas, totalFaltas, totalJustificadas);
    desenharBarras(relatorio);
    await desenharLinha();
  } catch (err) { console.error('Erro ao carregar dashboard:', err); }
}

function desenharDonut(presencas, faltas, justificadas) {
  const ctx = document.getElementById('chartDonut').getContext('2d');
  chartDonut = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: ['Presentes','Faltas','Justificadas'], datasets: [{ data:[presencas,faltas,justificadas], backgroundColor:['#16a34a','#dc2626','#d97706'], borderWidth:0, hoverOffset:8 }] },
    options: { responsive:true, maintainAspectRatio:false, cutout:'65%', plugins:{ legend:{display:false}, tooltip:{callbacks:{label: ctx => ` ${ctx.label}: ${ctx.parsed} registros`}} } },
  });
  const legenda = document.getElementById('legendDonut');
  const cores   = ['#16a34a','#dc2626','#d97706'];
  const rotulos = ['Presentes','Faltas','Justificadas'];
  const valores = [presencas,faltas,justificadas];
  legenda.innerHTML = rotulos.map((r,i) => `<div class="legend-item"><div class="legend-dot" style="background:${cores[i]}"></div><span>${r}: <strong>${valores[i]}</strong></span></div>`).join('');
}

function desenharBarras(relatorio) {
  const ctx   = document.getElementById('chartBarras').getContext('2d');
  const dados = relatorio.slice(0,10);
  chartBarras = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: dados.map(r => r.aluno.split(' ')[0]),
      datasets: [
        { label:'Presentes',    data:dados.map(r=>Number(r.presencas||0)),    backgroundColor:'#16a34a', borderRadius:6, barPercentage:.7 },
        { label:'Faltas',       data:dados.map(r=>Number(r.faltas||0)),       backgroundColor:'#dc2626', borderRadius:6, barPercentage:.7 },
        { label:'Justificadas', data:dados.map(r=>Number(r.justificadas||0)), backgroundColor:'#d97706', borderRadius:6, barPercentage:.7 },
      ],
    },
    options: {
      responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ position:'top', labels:{ font:{family:'DM Sans',size:11}, boxWidth:12 } } },
      scales:{ x:{grid:{display:false}}, y:{grid:{color:'#f1f5f9'},beginAtZero:true,ticks:{stepSize:1}} },
    },
  });
}

async function desenharLinha() {
  const ctx = document.getElementById('chartLinha').getContext('2d');
  let dados = [];
  try { const r = await window.apiFetch(`/presencas`); dados = await r.json(); } catch { dados = []; }
  const hoje = new Date();
  const diasMap = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(hoje); d.setDate(hoje.getDate()-i);
    diasMap[d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})] = 0;
  }
  dados.forEach(p => {
    if (p.status === 'falta') {
      const key = new Date(p.data).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'});
      if (key in diasMap) diasMap[key]++;
    }
  });
  chartLinha = new Chart(ctx, {
    type: 'line',
    data: { labels:Object.keys(diasMap), datasets:[{ label:'Faltas por dia', data:Object.values(diasMap), borderColor:'#1a56db', backgroundColor:'rgba(26,86,219,.08)', fill:true, tension:.4, pointBackgroundColor:'#1a56db', pointRadius:4, borderWidth:2 }] },
    options: {
      responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false}, tooltip:{callbacks:{label: ctx => ` ${ctx.parsed.y} falta(s)`}} },
      scales:{ x:{grid:{display:false}, ticks:{font:{size:10},callback:(val,idx)=>idx%5===0?Object.keys(diasMap)[idx]:''}}, y:{beginAtZero:true,grid:{color:'#f1f5f9'},ticks:{stepSize:1}} },
    },
  });
}

// ─── RELATÓRIO DE FREQUÊNCIA ─────────────────────────────
let dadosRelatorio = [];

async function carregarRelatorio() {
  const corpo = document.getElementById('corpoRelatorio');
  const meta  = document.getElementById('metaFrequencia');
  corpo.innerHTML = '<tr><td colspan="6" class="loading-cell">Carregando...</td></tr>';
  try {
    const resp = await window.apiFetch(`/relatorio-frequencia`);
    dadosRelatorio = await resp.json();
    renderizarRelatorio(dadosRelatorio);
    meta.textContent = `${dadosRelatorio.length} alunos encontrados`;
  } catch {
    corpo.innerHTML = '<tr><td colspan="6" class="loading-cell">Erro ao carregar dados.</td></tr>';
  }
}

function renderizarRelatorio(dados) {
  const corpo = document.getElementById('corpoRelatorio');
  if (!dados.length) { corpo.innerHTML = '<tr><td colspan="6" class="loading-cell">Nenhum registro.</td></tr>'; return; }
  corpo.innerHTML = dados.map(r => {
    const p=Number(r.presencas||0), f=Number(r.faltas||0), j=Number(r.justificadas||0);
    const tot=p+f+j, pct=tot>0?Math.round(p/tot*100):100, cor=corFrequencia(pct);
    return `<tr>
      <td><strong>${r.aluno}</strong></td>
      <td style="color:#16a34a;font-weight:600">${p}</td>
      <td style="color:#dc2626;font-weight:600">${f}</td>
      <td style="color:#d97706;font-weight:600">${j}</td>
      <td><div class="freq-bar"><div class="freq-track"><div class="freq-fill" style="width:${pct}%;background:${cor}"></div></div><span class="freq-text" style="color:${cor}">${pct}%</span></div></td>
      <td>${badgeStatus(pct)}</td>
    </tr>`;
  }).join('');
}

document.getElementById('buscaFrequencia').addEventListener('input', function () {
  const q = this.value.toLowerCase().trim();
  const filtrado = dadosRelatorio.filter(r => r.aluno.toLowerCase().includes(q));
  renderizarRelatorio(filtrado);
  document.getElementById('metaFrequencia').textContent = `${filtrado.length} alunos encontrados`;
});

// ─── TURMAS ──────────────────────────────────────────────
let todasTurmas = [], turmaAtualId = null;

async function carregarTurmas() {
  const grid = document.getElementById('turmasGrid');
  grid.innerHTML = '<div class="empty-state"><div class="empty-state-icon">⏳</div><div class="empty-state-text">Carregando...</div></div>';
  try {
    const resp = await window.apiFetch(`/turmas`);
    todasTurmas = await resp.json();
    renderizarTurmas(todasTurmas);
  } catch {
    grid.innerHTML = '<div class="empty-state"><div class="empty-state-icon">❌</div><div class="empty-state-text">Erro ao carregar turmas.</div></div>';
  }
}

function renderizarTurmas(turmas) {
  const grid = document.getElementById('turmasGrid');
  if (!turmas.length) { grid.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🏫</div><div class="empty-state-text">Nenhuma turma encontrada.</div></div>'; return; }
  const turnos = { matutino:'Matutino', vespertino:'Vespertino', noturno:'Noturno' };
  grid.innerHTML = turmas.map(t => `
    <div class="turma-card${t.ativa ? '' : ' inativa'}">
      <div class="turma-card-header">
        <div><div class="turma-nome">${t.nome}</div><div class="turma-ano">${t.ano}</div></div>
        ${t.ativa ? `<span class="turma-badge-turno">${turnos[t.turno]||t.turno}</span>` : '<span class="turma-badge-inativa">Inativa</span>'}
      </div>
      <div class="turma-stats">
        <div class="turma-stat"><span class="turma-stat-val">${t.total_alunos||0}</span><span class="turma-stat-label">Alunos</span></div>
      </div>
      <div class="turma-actions">
        <button class="btn-turma btn-turma-alunos" onclick="abrirModalAlunos(${t.id},'${t.nome}')">👥 Alunos</button>
        <button class="btn-turma btn-turma-edit"   onclick="abrirModalEditarTurma(${t.id})">✏️ Editar</button>
        <button class="btn-turma btn-turma-del"    onclick="excluirTurma(${t.id},'${t.nome}')">🗑️</button>
      </div>
    </div>
  `).join('');
}

document.getElementById('buscaTurma').addEventListener('input', function () {
  const q = this.value.toLowerCase().trim();
  renderizarTurmas(todasTurmas.filter(t => t.nome.toLowerCase().includes(q)));
});

function abrirModalNovaTurma() {
  document.getElementById('modalTurmaTitle').textContent = 'Nova Turma';
  document.getElementById('turmaEditId').value = '';
  document.getElementById('turmaNome').value   = '';
  document.getElementById('turmaAno').value    = new Date().getFullYear();
  document.getElementById('turmaTurno').value  = 'matutino';
  document.getElementById('modalTurmaMsg').className = 'form-message';
  document.getElementById('modalTurma').classList.add('open');
}
function fecharModalTurma() { document.getElementById('modalTurma').classList.remove('open'); }

function abrirModalEditarTurma(id) {
  const turma = todasTurmas.find(t => t.id === id);
  if (!turma) return;
  document.getElementById('modalTurmaTitle').textContent = 'Editar Turma';
  document.getElementById('turmaEditId').value = turma.id;
  document.getElementById('turmaNome').value   = turma.nome;
  document.getElementById('turmaAno').value    = turma.ano;
  document.getElementById('turmaTurno').value  = turma.turno;
  document.getElementById('modalTurmaMsg').className = 'form-message';
  document.getElementById('modalTurma').classList.add('open');
}

async function salvarTurma() {
  const msg   = document.getElementById('modalTurmaMsg');
  const id    = document.getElementById('turmaEditId').value;
  const nome  = document.getElementById('turmaNome').value.trim();
  const ano   = document.getElementById('turmaAno').value.trim();
  const turno = document.getElementById('turmaTurno').value;
  if (!nome || !ano) { showMsg(msg,'⚠️ Preencha o nome e o ano da turma.','error'); return; }
  const isEdicao = !!id;
  const method = isEdicao ? 'PUT' : 'POST';
  try {
    const resp = await window.apiFetch(isEdicao ? `/turmas/${id}` : `/turmas`, { method, body:JSON.stringify({nome,ano,turno}) });
    const dados = await resp.json();
    if (resp.ok) { showMsg(msg,`✅ ${dados.mensagem}`,'success'); setTimeout(()=>{ fecharModalTurma(); carregarTurmas(); },800); }
    else          { showMsg(msg,`❌ ${dados.erro||'Erro ao salvar.'}`, 'error'); }
  } catch { showMsg(msg,'❌ Não foi possível conectar ao servidor.','error'); }
}

async function excluirTurma(id, nome) {
  if (!confirm(`Excluir a turma "${nome}"?`)) return;
  try {
    const resp = await window.apiFetch(`/turmas/${id}`, { method:'DELETE' });
    const dados = await resp.json();
    if (resp.ok) carregarTurmas();
    else alert(`Erro: ${dados.erro}`);
  } catch { alert('Erro ao conectar ao servidor.'); }
}

async function abrirModalAlunos(turmaId, turmaNome) {
  turmaAtualId = turmaId;
  document.getElementById('modalAlunosTitle').textContent = `Alunos — ${turmaNome}`;
  document.getElementById('modalAlunosMsg').className = 'form-message';
  document.getElementById('modalAlunos').classList.add('open');
  const lista = document.getElementById('modalAlunosLista');
  lista.innerHTML = '<div class="modal-aluno-item">Carregando...</div>';
  try {
    const [resp, respTodos] = await Promise.all([window.apiFetch(`/turmas/${turmaId}/alunos`), window.apiFetch(`/alunos`)]);
    const alunosRaw = await resp.json();
    const todosRaw  = await respTodos.json();
    const alunos = Array.isArray(alunosRaw) ? alunosRaw : (Array.isArray(alunosRaw?.dados) ? alunosRaw.dados : []);
    const todos  = Array.isArray(todosRaw) ? todosRaw : (Array.isArray(todosRaw?.dados) ? todosRaw.dados : []);
    lista.innerHTML = alunos.length
      ? alunos.map(a => `<div class="modal-aluno-item"><div><div class="modal-aluno-nome">${a.nome}</div><div class="modal-aluno-email">${a.email}</div></div></div>`).join('')
      : '<div class="modal-aluno-item" style="color:var(--gray-400)">Nenhum aluno vinculado ainda.</div>';
    const vinculados = new Set(alunos.map(a => a.id));
    const select = document.getElementById('selectVincularAluno');
    select.innerHTML = '<option value="">Selecione um aluno para vincular...</option>' +
      todos.filter(a => !vinculados.has(a.id)).map(a => `<option value="${a.id}">${a.nome}</option>`).join('');
  } catch { lista.innerHTML = '<div class="modal-aluno-item" style="color:var(--red)">Erro ao carregar alunos.</div>'; }
}

function fecharModalAlunos() { document.getElementById('modalAlunos').classList.remove('open'); turmaAtualId = null; }

async function vincularAluno() {
  const msg     = document.getElementById('modalAlunosMsg');
  const alunoId = document.getElementById('selectVincularAluno').value;
  if (!alunoId) { showMsg(msg,'⚠️ Selecione um aluno para vincular.','error'); return; }
  try {
    const resp = await window.apiFetch(`/alunos/${alunoId}/turma`, { method:'PATCH', body:JSON.stringify({turma_id:turmaAtualId}) });
    const dados = await resp.json();
    if (resp.ok) { showMsg(msg,'✅ Aluno vinculado com sucesso!','success'); const t=todasTurmas.find(t=>t.id===turmaAtualId); await abrirModalAlunos(turmaAtualId,t?.nome||''); }
    else          { showMsg(msg,`❌ ${dados.erro||'Erro ao vincular.'}`, 'error'); }
  } catch { showMsg(msg,'❌ Não foi possível conectar ao servidor.','error'); }
}

document.getElementById('modalTurma').addEventListener('click', function(e){ if(e.target===this) fecharModalTurma(); });
document.getElementById('modalAlunos').addEventListener('click', function(e){ if(e.target===this) fecharModalAlunos(); });

// ─── USUÁRIOS ────────────────────────────────────────────
async function carregarUsuarios() {
  await Promise.all([carregarAlunosList(), carregarPaisList(), carregarProfessoresList()]);
}
async function carregarAlunosList() {
  const tbody = document.getElementById('tabelaAlunos');
  tbody.innerHTML = '<tr><td colspan="4" class="loading-cell">Carregando...</td></tr>';
  try {
    const r = await window.apiFetch(`/alunos`);
    const d = await r.json();
    const lista = Array.isArray(d) ? d : (Array.isArray(d?.dados) ? d.dados : []);
    tbody.innerHTML = lista.length
      ? lista.map((a,i)=>`<tr><td style="color:var(--gray-400);font-size:.8rem">${i+1}</td><td><strong>${a.nome}</strong></td><td>${a.email}</td><td><span class="badge badge-ok">${a.turma||'—'}</span></td></tr>`).join('')
      : '<tr><td colspan="4" class="loading-cell">Nenhum aluno cadastrado.</td></tr>';
  } catch { tbody.innerHTML='<tr><td colspan="4" class="loading-cell">Erro ao carregar.</td></tr>'; }
}
async function carregarPaisList() {
  const tbody = document.getElementById('tabelaPais');
  tbody.innerHTML = '<tr><td colspan="4" class="loading-cell">Carregando...</td></tr>';
  try {
    const r = await window.apiFetch(`/pais`);
    const d = await r.json();
    const lista = Array.isArray(d) ? d : (Array.isArray(d?.dados) ? d.dados : []);
    tbody.innerHTML = lista.length
      ? lista.map((p,i)=>`<tr><td style="color:var(--gray-400);font-size:.8rem">${i+1}</td><td><strong>${p.nome}</strong></td><td>${p.email}</td><td>${p.telefone||'—'}</td></tr>`).join('')
      : '<tr><td colspan="4" class="loading-cell">Nenhum pai cadastrado.</td></tr>';
  } catch { tbody.innerHTML='<tr><td colspan="4" class="loading-cell">Erro ao carregar.</td></tr>'; }
}
async function carregarProfessoresList() {
  const tbody = document.getElementById('tabelaProfessores');
  tbody.innerHTML = '<tr><td colspan="4" class="loading-cell">Carregando...</td></tr>';
  try {
    const r = await window.apiFetch(`/professores`);
    const d = await r.json();
    const lista = Array.isArray(d) ? d : (Array.isArray(d?.dados) ? d.dados : []);
    tbody.innerHTML = lista.length
      ? lista.map((p,i)=>`<tr><td style="color:var(--gray-400);font-size:.8rem">${i+1}</td><td><strong>${p.nome}</strong></td><td>${p.email}</td><td>${p.disciplina||'—'}</td></tr>`).join('')
      : '<tr><td colspan="4" class="loading-cell">Nenhum professor cadastrado.</td></tr>';
  } catch { tbody.innerHTML='<tr><td colspan="4" class="loading-cell">Erro ao carregar.</td></tr>'; }
}

// ─── CADASTRO ────────────────────────────────────────────
document.getElementById('formCadastro').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('mensagemCadastro');
  const payload = {
    nome:       document.getElementById('nome').value.trim(),
    email:      document.getElementById('email').value.trim(),
    senha:      document.getElementById('senha').value.trim(),
    tipo:       document.getElementById('tipo').value,
    turma_id:   document.getElementById('turma_id')?.value   || '',
    pai_id:     document.getElementById('pai_id')?.value     || '',
    telefone:   document.getElementById('telefone')?.value.trim() || '',
    disciplina: document.getElementById('disciplina')?.value.trim() || '',
  };
  if (!payload.nome || !payload.email || !payload.senha || !payload.tipo) { showMsg(msg,'⚠️ Preencha todos os campos obrigatórios.','error'); return; }
  if (payload.tipo==='aluno' && !payload.turma_id) { showMsg(msg,'⚠️ Selecione a turma do aluno.','error'); return; }
  if (payload.tipo==='aluno' && !payload.pai_id)   { showMsg(msg,'⚠️ Selecione o pai/responsável do aluno.','error'); return; }
  try {
    const resp = await window.apiFetch(`/cadastro`, { method:'POST', body:JSON.stringify(payload) });
    const dados = await resp.json();
    if (resp.ok) {
      showMsg(msg,`✅ ${dados.mensagem||'Usuário cadastrado com sucesso!'}`, 'success');
      e.target.reset();
      ['camposAluno','camposPai','camposProfessor'].forEach(id => { document.getElementById(id).style.display='none'; });
    } else { showMsg(msg,`❌ ${dados.erro||'Erro ao cadastrar.'}`, 'error'); }
  } catch { showMsg(msg,'❌ Não foi possível conectar ao servidor.','error'); }
});

// ============================================================
// CHAMADA — GESTOR
// ============================================================
let gAlunos = [], gStatusMap = {}, gIndice = -1;

function inicChamadaGestor() {
  document.getElementById('g-sel-data').value = new Date().toISOString().split('T')[0];
  carregarTurmasSelect();
}

async function carregarTurmasSelect() {
  const sel = document.getElementById('g-sel-turma');
  try {
    const r = await window.apiFetch(`/turmas`);
    const t = await r.json();
    sel.innerHTML = '<option value="">— Selecione —</option>' +
      t.filter(x=>x.ativa).map(x=>`<option value="${x.id}">${x.nome} (${x.turno||'—'})</option>`).join('');
  } catch {}
}

document.getElementById('g-sel-turma').addEventListener('change', () => {
  document.getElementById('g-btn-iniciar').disabled = !document.getElementById('g-sel-turma').value;
  gReset();
});

document.getElementById('g-btn-iniciar').addEventListener('click', gIniciarChamada);

async function gIniciarChamada() {
  const turmaId = document.getElementById('g-sel-turma').value;
  const data    = document.getElementById('g-sel-data').value;
  if (!turmaId||!data) return;
  const btn = document.getElementById('g-btn-iniciar');
  btn.disabled=true; btn.textContent='⏳ Carregando...';
  gReset(false);
  try {
    const [rA, rS] = await Promise.all([
      window.apiFetch(`/turmas/${turmaId}/alunos`),
      window.apiFetch(`/presencas-turma?turma_id=${turmaId}&data=${data}`)
    ]);
    gAlunos = await rA.json();
    const salvos = await rS.json().catch(()=>[]);
    if (!gAlunos.length) { document.getElementById('g-chamada-empty').innerHTML='<span class="chamada-empty-icon">😕</span><p>Nenhum aluno nesta turma.</p>'; btn.disabled=false; btn.textContent='▶ Iniciar'; return; }
    gAlunos.sort((a,b)=>a.nome.localeCompare(b.nome));
    gAlunos.forEach(a=>{ gStatusMap[a.id]=null; });
    salvos.forEach(s=>{ gStatusMap[s.aluno_id]=s.status; });
    gIndice = gAlunos.findIndex(a=>gStatusMap[a.id]===null);
    if (gIndice===-1) gIndice=gAlunos.length;
    document.getElementById('g-chamada-empty').classList.add('hidden');
    document.getElementById('g-progress').classList.remove('hidden');
    document.getElementById('g-chamada-lista').classList.remove('hidden');
    document.getElementById('g-chamada-footer').classList.remove('hidden');
    gRenderLista(); gAtualizarProg();
    document.getElementById('g-chamada-lista').querySelector('.chamada-item.atual')?.scrollIntoView({block:'center'});
  } catch(e){ console.error(e); }
  finally { btn.disabled=false; btn.textContent='▶ Iniciar'; }
}

function gReset(showEmpty=true) {
  gAlunos=[]; gStatusMap={}; gIndice=-1;
  document.getElementById('g-chamada-lista').innerHTML='';
  if(showEmpty) { const e=document.getElementById('g-chamada-empty'); e.innerHTML='<span class="chamada-empty-icon">📋</span><p>Selecione uma turma e data para iniciar.</p>'; e.classList.remove('hidden'); }
  document.getElementById('g-progress').classList.add('hidden');
  document.getElementById('g-chamada-lista').classList.add('hidden');
  document.getElementById('g-chamada-footer').classList.add('hidden');
}

function gRenderLista() {
  const lista = document.getElementById('g-chamada-lista');
  lista.innerHTML = '';
  gAlunos.forEach((aluno,idx) => {
    const st      = gStatusMap[aluno.id];
    const isAtual = idx===gIndice;
    const item    = document.createElement('div');
    item.className=`chamada-item ${isAtual?'atual':(st||'pendente')}`;
    const badgeTxt = isAtual?'← aqui':(st||'—');
    const badgeCls = isAtual?'atual':(st||'pendente');
    const badgeLabel = {presente:'✓ Presente',falta:'✗ Falta',justificado:'⚠ Just.',pendente:'—','← aqui':'← aqui','atual':'← aqui'}[badgeTxt]||badgeTxt;
    item.innerHTML=`
      <span class="aluno-num">${idx+1}</span>
      <div class="aluno-avatar">${aluno.nome.charAt(0).toUpperCase()}</div>
      <span class="aluno-nome">${aluno.nome}</span>
      ${isAtual?'<span class="atual-indicator">▶</span>':''}
      <div class="item-actions">
        <button class="act-btn act-p" data-act="presente">✓ Presente</button>
        <button class="act-btn act-f" data-act="falta">✗ Falta</button>
        <button class="act-btn act-j" data-act="justificado">⚠ Just.</button>
      </div>
      <span class="status-badge ${badgeCls}">${badgeLabel}</span>
    `;
    item.querySelectorAll('.act-btn').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();gMarcar(b.dataset.act);}));
    item.addEventListener('click',()=>{ if(gIndice<gAlunos.length){gIndice=idx;gRenderLista();} });
    lista.appendChild(item);
  });
}

function gMarcar(status) {
  if(gIndice<0||gIndice>=gAlunos.length) return;
  gStatusMap[gAlunos[gIndice].id]=status;
  gIndice++;
  gRenderLista(); gAtualizarProg();
  document.getElementById('g-chamada-lista').querySelector('.chamada-item.atual')?.scrollIntoView({block:'center'});
  if(gIndice>=gAlunos.length) gRenderResumo();
}

function gAtualizarProg() {
  const chamados=Object.values(gStatusMap).filter(s=>s!==null).length;
  const total=gAlunos.length;
  const pct=total>0?Math.round(chamados/total*100):0;
  document.getElementById('g-prog-texto').textContent=`${chamados} / ${total} alunos`;
  document.getElementById('g-prog-pct').textContent=pct+'%';
  document.getElementById('g-prog-fill').style.width=pct+'%';
}

function gRenderResumo() {
  const p=Object.values(gStatusMap).filter(s=>s==='presente').length;
  const f=Object.values(gStatusMap).filter(s=>s==='falta').length;
  const j=Object.values(gStatusMap).filter(s=>s==='justificado').length;
  document.getElementById('g-chamada-resumo').innerHTML=`
    <div class="resumo-item"><div class="resumo-dot" style="background:var(--green)"></div><span>${p} Presentes</span></div>
    <div class="resumo-item"><div class="resumo-dot" style="background:var(--red)"></div><span>${f} Faltas</span></div>
    <div class="resumo-item"><div class="resumo-dot" style="background:var(--yellow)"></div><span>${j} Justificados</span></div>
    <div class="resumo-item" style="color:var(--blue);font-weight:700;">✅ Concluída!</div>
  `;
}

// Teclado para chamada do gestor
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement.tagName;
  if(tag==='INPUT'||tag==='SELECT'||tag==='TEXTAREA'||tag==='BUTTON') return;
  const secChamada = document.getElementById('section-chamada');
  if(!secChamada.classList.contains('active')) return;
  if(gIndice<0||gIndice>=gAlunos.length) return;
  if(e.key==='Enter')     { e.preventDefault(); gMarcar('presente'); }
  else if(e.key===' ')    { e.preventDefault(); gMarcar('falta'); }
  else if(e.key==='j'||e.key==='J') gMarcar('justificado');
  else if(e.key==='Backspace'||e.key==='ArrowLeft') { e.preventDefault(); if(gIndice>0){gIndice--;gRenderLista();gAtualizarProg();} }
  else if(e.key==='p'||e.key==='P') { gStatusMap[gAlunos[gIndice].id]='presente'; gRenderLista(); gAtualizarProg(); }
  else if(e.key==='f'||e.key==='F') { gStatusMap[gAlunos[gIndice].id]='falta';    gRenderLista(); gAtualizarProg(); }
});

document.getElementById('g-btn-refazer').addEventListener('click', ()=>{
  gIndice=0; gAlunos.forEach(a=>{gStatusMap[a.id]=null;}); document.getElementById('g-msg-save').textContent=''; gRenderLista(); gAtualizarProg();
});

document.getElementById('g-btn-salvar').addEventListener('click', async ()=>{
  const data = document.getElementById('g-sel-data').value;
  if(!data){ alert('Selecione a data.'); return; }
  const pendentes = gAlunos.filter(a=>gStatusMap[a.id]===null);
  if(pendentes.length){ const ok=confirm(`${pendentes.length} aluno(s) sem status. Marcar como FALTA?`); if(ok) pendentes.forEach(a=>{gStatusMap[a.id]='falta';}); else return; }
  const btn = document.getElementById('g-btn-salvar');
  btn.disabled=true; btn.textContent='Salvando...';
  try {
    const turmaId = document.getElementById('g-sel-turma').value;
    const r = await window.apiFetch(`/registrar-presenca-turma`, {
      method:'POST',
      body: JSON.stringify({ turma_id: turmaId, data, presencas: gAlunos.map(a=>({aluno_id:a.id,status:gStatusMap[a.id]})) })
    });
    const resp=await r.json();
    const msg=document.getElementById('g-msg-save');
    if(r.ok){ msg.textContent=`✅ ${resp.mensagem}`; msg.className='save-msg ok'; gRenderLista(); gRenderResumo(); }
    else     { msg.textContent=`❌ ${resp.erro||'Erro ao salvar.'}`; msg.className='save-msg err'; }
  } catch { document.getElementById('g-msg-save').textContent='❌ Erro de conexão.'; }
  finally { btn.disabled=false; btn.textContent='💾 Salvar'; }
});

// ─── INIT ────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', carregarDashboard);
