// ============================================================
// GPE — aluno.js  (Sprint 2 — Redesign Completo)
// ============================================================

// Usa API_BASE_URL de config.js (carregado antes deste script)
// Controle de acesso gerenciado no auth.js

const usuarioId  = localStorage.getItem('usuario_id') || 1;
const nomeAluno  = localStorage.getItem('nome') || 'Aluno';

// ─── INIT UI ──────────────────────────────────────────────
document.getElementById('nomeAluno').textContent      = nomeAluno.split(' ')[0];
document.getElementById('sidebarNome').textContent    = nomeAluno;
document.getElementById('sidebarAvatar').textContent  = nomeAluno.charAt(0).toUpperCase();
document.getElementById('topbarDate').textContent =
  new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });

const LABELS = { dashboard: 'Meu Painel', historico: 'Histórico' };
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    const sec = btn.dataset.section;
    document.getElementById(`section-${sec}`).classList.add('active');
    document.getElementById('breadcrumb').textContent = LABELS[sec] || sec;
    document.getElementById('sidebar').classList.remove('open');
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
// DADOS
// ============================================================
let registros = [];
let filtroAtivo = 'todos';
let chartMensal = null;

async function carregarDados() {
  try {
    const r = await window.apiFetch(`/presencas/${usuarioId}`);
    registros = await r.json();
    if (!Array.isArray(registros)) registros = [];

    renderStats();
    renderFreqBar();
    renderAlertas();
    renderGrafico();
    renderUltimasAulas();
    renderHistorico();

  } catch (err) {
    console.error('Erro ao carregar presencas:', err);
  }
}

function renderStats() {
  const pres = registros.filter(p => p.status === 'presente').length;
  const falt = registros.filter(p => p.status === 'falta').length;
  const just = registros.filter(p => p.status === 'justificado').length;
  const tot  = pres + falt + just;
  const pct  = tot > 0 ? Math.round(pres / tot * 100) : 0;

  document.getElementById('s-pres').textContent = pres;
  document.getElementById('s-falt').textContent = falt;
  document.getElementById('s-just').textContent = just;
  document.getElementById('s-pct').textContent  = pct + '%';

  return { pres, falt, just, tot, pct };
}

function renderFreqBar() {
  const pres = registros.filter(p => p.status === 'presente').length;
  const tot  = registros.length;
  const pct  = tot > 0 ? Math.round(pres / tot * 100) : 0;

  const fill = document.getElementById('freq-fill-a');
  fill.style.width = pct + '%';
  fill.className = `freq-fill-aluno ${pct >= 75 ? 'verde' : pct >= 60 ? 'amarelo' : 'vermelho'}`;

  document.getElementById('freq-pct-a').textContent = pct + '%';
  document.getElementById('freq-pct-a').style.color =
    pct >= 75 ? 'var(--green)' : pct >= 60 ? 'var(--yellow)' : 'var(--red)';

  const badge = document.getElementById('freq-badge');
  badge.textContent = pct >= 75 ? '✓ Regular' : pct >= 60 ? '⚠ Risco' : '🚨 Crítico';
  badge.style.background = pct >= 75 ? 'var(--green-light)' : pct >= 60 ? 'var(--yellow-light)' : 'var(--red-light)';
  badge.style.color = pct >= 75 ? 'var(--green)' : pct >= 60 ? 'var(--yellow)' : 'var(--red)';

  const faltMax = tot > 0 ? Math.floor(tot * 0.25) : 0;
  const faltAtual = registros.filter(p => p.status === 'falta').length;
  const faltRestam = Math.max(0, faltMax - faltAtual);

  document.getElementById('freq-dica').textContent = pct >= 75
    ? `🟢 Você pode faltar mais ${faltRestam} vez(es) e ainda manter a frequência mínima de 75%.`
    : pct >= 60
    ? `⚠️ Você está em risco! Não falte mais — você já usou ${faltAtual} de ${faltMax} faltas permitidas.`
    : `🚨 Frequência crítica! Procure a coordenação da escola para verificar sua situação.`;
}

function renderAlertas() {
  const pres = registros.filter(p => p.status === 'presente').length;
  const tot  = registros.length;
  const pct  = tot > 0 ? Math.round(pres / tot * 100) : 0;
  const cont = document.getElementById('alerta-aluno');
  cont.innerHTML = '';

  if (pct < 60 && tot > 0) {
    cont.innerHTML = `
      <div class="alerta-critico">
        <span style="font-size:1.3rem;">🚨</span>
        <div>
          <strong style="color:var(--red);font-size:0.88rem;">Atenção: Frequência Crítica (${pct}%)</strong>
          <p style="font-size:0.8rem;color:#7f1d1d;margin-top:4px;">
            Sua frequência está abaixo do mínimo exigido de 75%. Procure a coordenação da escola.
          </p>
        </div>
      </div>`;
  } else if (pct < 75 && tot > 0) {
    cont.innerHTML = `
      <div class="alerta-aviso">
        <span style="font-size:1.3rem;">⚠️</span>
        <div>
          <strong style="color:var(--yellow);font-size:0.88rem;">Frequência em risco (${pct}%)</strong>
          <p style="font-size:0.8rem;color:#78350f;margin-top:4px;">
            Você está abaixo dos 75% exigidos. Evite mais faltas.
          </p>
        </div>
      </div>`;
  }
}

function renderGrafico() {
  const meses = {};
  const hoje  = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    meses[key] = { pres: 0, falt: 0, just: 0 };
  }

  registros.forEach(p => {
    const key = p.data?.substring(0, 7);
    if (meses[key]) {
      if (p.status === 'presente')    meses[key].pres++;
      else if (p.status === 'falta')  meses[key].falt++;
      else if (p.status === 'justificado') meses[key].just++;
    }
  });

  const labels = Object.keys(meses).map(k => {
    const [y, m] = k.split('-');
    return new Date(+y, +m - 1, 1).toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' });
  });
  const presData = Object.values(meses).map(v => v.pres);
  const faltData = Object.values(meses).map(v => v.falt);

  if (chartMensal) { chartMensal.destroy(); chartMensal = null; }
  const ctx = document.getElementById('chartMensal').getContext('2d');
  chartMensal = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Presenças',
          data: presData,
          backgroundColor: 'rgba(22,163,74,0.75)',
          borderRadius: 6,
          borderSkipped: false,
        },
        {
          label: 'Faltas',
          data: faltData,
          backgroundColor: 'rgba(220,38,38,0.65)',
          borderRadius: 6,
          borderSkipped: false,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11 }, boxWidth: 12 } }
      },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#f1f5f9' } }
      }
    }
  });
}

function renderUltimasAulas() {
  const cont  = document.getElementById('ultimas-aulas');
  const ults  = registros.slice(0, 10);
  document.getElementById('ult-badge').textContent = `${ults.length} registros`;

  const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

  if (!ults.length) {
    cont.innerHTML = '<div class="empty-state"><span class="empty-icon">📅</span><p>Nenhuma aula registrada.</p></div>';
    return;
  }

  cont.innerHTML = ults.map(p => {
    const d = new Date(p.data);
    return `
      <div class="aula-item">
        <span class="aula-data">${d.toLocaleDateString('pt-BR')} <small style="color:var(--gray-400)">${DIAS[d.getDay()]}</small></span>
        <span class="aula-prof">${p.professor || '—'}</span>
        <span class="badge badge-${p.status}">${p.status}</span>
      </div>
    `;
  }).join('');
}

// ─── HISTÓRICO ────────────────────────────────────────────
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    filtroAtivo = btn.dataset.f;
    renderHistorico();
  });
});

document.getElementById('hist-busca').addEventListener('input', renderHistorico);

function renderHistorico() {
  const q     = document.getElementById('hist-busca').value.toLowerCase().trim();
  const tbody = document.getElementById('hist-tbody');
  const DIAS  = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

  let dados = [...registros];
  if (filtroAtivo !== 'todos') dados = dados.filter(p => p.status === filtroAtivo);
  if (q) dados = dados.filter(p => p.data?.toLowerCase().includes(q) || p.professor?.toLowerCase().includes(q));

  if (!dados.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="loading-cell">Nenhum registro encontrado.</td></tr>';
    return;
  }

  tbody.innerHTML = dados.map(p => {
    const d = new Date(p.data);
    return `
      <tr>
        <td><strong>${d.toLocaleDateString('pt-BR')}</strong></td>
        <td style="color:var(--gray-400);font-size:0.8rem;">${DIAS[d.getDay()]}</td>
        <td>${p.professor || '—'}</td>
        <td><span class="badge badge-${p.status}">${p.status}</span></td>
      </tr>
    `;
  }).join('');
}

// ─── INIT ─────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', carregarDados);
