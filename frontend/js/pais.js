// ============================================================
// GPE — pais.js  (Sprint 2 — Redesign Completo)
// ============================================================

// Usa API_BASE_URL de config.js (carregado antes deste script)
// Controle de acesso gerenciado no auth.js

const usuarioId = localStorage.getItem('usuario_id') || 1;
const nomePai   = localStorage.getItem('nome') || 'Responsável';

// ─── INIT UI ──────────────────────────────────────────────
document.getElementById('nomePai').textContent       = nomePai.split(' ')[0];
document.getElementById('sidebarNome').textContent   = nomePai;
document.getElementById('sidebarAvatar').textContent = nomePai.charAt(0).toUpperCase();
document.getElementById('topbarDate').textContent =
  new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });

// ─── NAVEGAÇÃO ────────────────────────────────────────────
const LABELS = { resumo: 'Resumo', historico: 'Histórico', notificacoes: 'Notificações' };

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    const sec = btn.dataset.section;
    document.getElementById(`section-${sec}`).classList.add('active');
    document.getElementById('breadcrumb').textContent = LABELS[sec] || sec;
    document.getElementById('sidebar').classList.remove('open');
    if (sec === 'historico')     carregarHistorico();
    if (sec === 'notificacoes')  carregarNotificacoes();
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
// RESUMO  
// ============================================================
let chartDonut = null;
let chartLinha = null;
let todosRegistros = [];

async function carregarResumo() {
  try {
    const r = await window.apiFetch(`/presencas-filho/${usuarioId}`);
    todosRegistros = await r.json();

    if (!Array.isArray(todosRegistros)) todosRegistros = [];

    calcularStats();
    verificarAlertas();
    renderUltimasFaltas();
    renderGraficos();

  } catch (err) {
    console.error('Erro resumo pai:', err);
    document.getElementById('stat-pres').textContent = 'Err';
  }
}

function calcularStats() {
  const pres = todosRegistros.filter(p => p.status === 'presente').length;
  const falt = todosRegistros.filter(p => p.status === 'falta').length;
  const just = todosRegistros.filter(p => p.status === 'justificado').length;
  const tot  = pres + falt + just;
  const pct  = tot > 0 ? Math.round(pres / tot * 100) : 0;

  document.getElementById('stat-pres').textContent = pres;
  document.getElementById('stat-falt').textContent = falt;
  document.getElementById('stat-just').textContent = just;
  document.getElementById('stat-pct').textContent  = pct + '%';

  // Barra grande
  const fill = document.getElementById('freq-fill-big');
  fill.style.width = pct + '%';
  fill.className = 'freq-fill-big ' + (pct >= 75 ? '' : pct >= 60 ? 'amarelo' : 'vermelho');

  document.getElementById('freq-pct-big').textContent = pct + '%';
  document.getElementById('freq-pct-big').style.color =
    pct >= 75 ? 'var(--green)' : pct >= 60 ? 'var(--yellow)' : 'var(--red)';

  // Observação
  const obs = pct >= 90 ? '🌟 Excelente frequência! Continue assim.' :
              pct >= 75 ? '✅ Frequência regular. Dentro do mínimo exigido.' :
              pct >= 60 ? '⚠️ Frequência em risco! Mínimo exigido é 75%.' :
                          '🚨 Frequência CRÍTICA! Entre em contato com a escola imediatamente.';
  document.getElementById('freq-obs').textContent = obs;

  // Badge de status no card
  const badge = document.getElementById('freq-status-badge');
  badge.textContent = pct >= 75 ? 'Regular ✓' : pct >= 60 ? 'Em Risco ⚠' : 'Crítico 🚨';
  badge.style.background = pct >= 75 ? 'var(--green-light)' : pct >= 60 ? 'var(--yellow-light)' : 'var(--red-light)';
  badge.style.color = pct >= 75 ? 'var(--green)' : pct >= 60 ? 'var(--yellow)' : 'var(--red)';
}

function verificarAlertas() {
  const cont = document.getElementById('alertas-container');
  const pres = todosRegistros.filter(p => p.status === 'presente').length;
  const falt = todosRegistros.filter(p => p.status === 'falta').length;
  const just = todosRegistros.filter(p => p.status === 'justificado').length;
  const tot  = pres + falt + just;
  const pct  = tot > 0 ? Math.round(pres / tot * 100) : 0;

  cont.innerHTML = '';

  if (pct < 60 && tot > 0) {
    cont.innerHTML += `
      <div class="alerta-critico">
        <span style="font-size:1.4rem;">🚨</span>
        <div>
          <strong style="color:var(--red);font-size:0.9rem;">Frequência CRÍTICA: ${pct}%</strong>
          <p style="font-size:0.82rem;color:#7f1d1d;margin-top:4px;">
            O mínimo exigido é 75%. Com ${falt} faltas em ${tot} aulas, o aluno pode ser reprovado por infrequência.
            Entre em contato com a escola urgentemente.
          </p>
        </div>
      </div>`;
  } else if (pct < 75 && tot > 0) {
    cont.innerHTML += `
      <div class="alerta-aviso">
        <span style="font-size:1.4rem;">⚠️</span>
        <div>
          <strong style="color:var(--yellow);font-size:0.9rem;">Frequência em risco: ${pct}%</strong>
          <p style="font-size:0.82rem;color:#78350f;margin-top:4px;">
            O mínimo é 75%. Já são ${falt} falta(s). Fique atento e acompanhe a frequência regularmente.
          </p>
        </div>
      </div>`;
  }
}

function renderUltimasFaltas() {
  const faltas = todosRegistros
    .filter(p => p.status === 'falta' || p.status === 'justificado')
    .slice(0, 8);

  const cont = document.getElementById('ultimas-faltas');
  document.getElementById('ultimas-badge').textContent = `${faltas.length} registros`;

  if (!faltas.length) {
    cont.innerHTML = '<div class="empty-state"><span class="empty-icon">✅</span><p>Nenhuma falta registrada!</p></div>';
    return;
  }

  cont.innerHTML = faltas.map(p => {
    const d = new Date(p.data);
    const dia = d.getDate().toString().padStart(2, '0');
    const mes = d.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
    const isFalt = p.status === 'falta';
    return `
      <div class="falta-item">
        <div class="falta-data-box" style="${isFalt ? '' : 'background:var(--yellow-light);color:var(--yellow);'}">
          <div class="falta-dia">${dia}</div>
          <div class="falta-mes">${mes}</div>
        </div>
        <div>
          <div class="falta-aluno">${p.aluno}</div>
          <div class="falta-tipo">${isFalt ? '❌ Falta' : '📝 Justificada'}</div>
        </div>
        <div style="margin-left:auto;">
          <span class="badge badge-${p.status}">${p.status}</span>
        </div>
      </div>
    `;
  }).join('');
}

function renderGraficos() {
  const pres = todosRegistros.filter(p => p.status === 'presente').length;
  const falt = todosRegistros.filter(p => p.status === 'falta').length;
  const just = todosRegistros.filter(p => p.status === 'justificado').length;

  // Donut
  if (chartDonut) { chartDonut.destroy(); chartDonut = null; }
  const ctx1 = document.getElementById('chartDonut').getContext('2d');
  chartDonut = new Chart(ctx1, {
    type: 'doughnut',
    data: {
      labels: ['Presentes', 'Faltas', 'Justificadas'],
      datasets: [{
        data: [pres, falt, just],
        backgroundColor: ['#16a34a', '#dc2626', '#d97706'],
        borderWidth: 0,
        hoverOffset: 6,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '68%',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.label}: ${ctx.raw} (${Math.round(ctx.raw / (pres+falt+just) * 100)}%)`
          }
        }
      }
    }
  });

  // Legenda manual
  document.getElementById('donut-legend').innerHTML = [
    { label: 'Presentes',    color: '#16a34a', val: pres },
    { label: 'Faltas',       color: '#dc2626', val: falt },
    { label: 'Justificadas', color: '#d97706', val: just },
  ].map(l => `
    <div class="legend-item">
      <div class="legend-dot" style="background:${l.color}"></div>
      <span>${l.label}: <strong>${l.val}</strong></span>
    </div>
  `).join('');

  // Linha — frequência dos últimos 6 meses
  const meses = {};
  const hoje  = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    meses[key] = { pres: 0, tot: 0 };
  }

  todosRegistros.forEach(p => {
    const key = p.data?.substring(0, 7);
    if (meses[key]) {
      meses[key].tot++;
      if (p.status === 'presente') meses[key].pres++;
    }
  });

  const labels   = Object.keys(meses).map(k => {
    const [y, m] = k.split('-');
    return new Date(+y, +m - 1, 1).toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' });
  });
  const pctMes  = Object.values(meses).map(v => v.tot > 0 ? Math.round(v.pres / v.tot * 100) : null);

  if (chartLinha) { chartLinha.destroy(); chartLinha = null; }
  const ctx2 = document.getElementById('chartLinha').getContext('2d');
  chartLinha = new Chart(ctx2, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: '% Frequência',
        data: pctMes,
        borderColor: '#1a56db',
        backgroundColor: 'rgba(26,86,219,0.1)',
        fill: true,
        tension: 0.4,
        pointBackgroundColor: '#1a56db',
        pointRadius: 5,
        spanGaps: true,
      }, {
        label: 'Mínimo (75%)',
        data: Array(labels.length).fill(75),
        borderColor: '#dc2626',
        borderDash: [6, 3],
        borderWidth: 1.5,
        pointRadius: 0,
        fill: false,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { font: { size: 11 }, boxWidth: 12 } } },
      scales: {
        y: { min: 0, max: 100, ticks: { callback: v => v + '%' }, grid: { color: '#f1f5f9' } },
        x: { grid: { display: false } }
      }
    }
  });
}

// ============================================================
// HISTÓRICO
// ============================================================
async function carregarHistorico() {
  const hoje = new Date().toISOString().split('T')[0];
  const seis = new Date(); seis.setMonth(seis.getMonth() - 6);
  if (!document.getElementById('hist-ini').value)
    document.getElementById('hist-ini').value = seis.toISOString().split('T')[0];
  if (!document.getElementById('hist-fim').value)
    document.getElementById('hist-fim').value = hoje;
  filtrarHistorico();
}

document.getElementById('btn-filtrar').addEventListener('click', filtrarHistorico);

async function filtrarHistorico() {
  const ini    = document.getElementById('hist-ini').value;
  const fim    = document.getElementById('hist-fim').value;
  const status = document.getElementById('hist-status').value;
  const tbody  = document.getElementById('hist-tbody');

  tbody.innerHTML = '<tr><td colspan="4" class="loading-cell">Filtrando...</td></tr>';

  let dados = [...todosRegistros];

  if (ini) dados = dados.filter(p => p.data?.split('T')[0] >= ini);
  if (fim) dados = dados.filter(p => p.data?.split('T')[0] <= fim);
  if (status) dados = dados.filter(p => p.status === status);

  const pres = dados.filter(p => p.status === 'presente').length;
  const falt = dados.filter(p => p.status === 'falta').length;
  const just = dados.filter(p => p.status === 'justificado').length;

  document.getElementById('cnt-p').textContent = pres + ' Pres.';
  document.getElementById('cnt-f').textContent = falt + ' Faltas';
  document.getElementById('cnt-j').textContent = just + ' Just.';
  document.getElementById('hist-meta').textContent = `${dados.length} registros`;

  if (!dados.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="loading-cell">Nenhum registro encontrado.</td></tr>';
    return;
  }

  const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  tbody.innerHTML = dados.map(p => {
    const d = new Date(p.data);
    const dia = DIAS[d.getDay()];
    return `
      <tr>
        <td><strong>${p.aluno}</strong></td>
        <td>${d.toLocaleDateString('pt-BR')}</td>
        <td style="color:var(--gray-400);font-size:0.8rem;">${dia}</td>
        <td><span class="badge badge-${p.status}">${p.status}</span></td>
      </tr>
    `;
  }).join('');
}

// ============================================================
// NOTIFICAÇÕES
// ============================================================
async function carregarNotificacoes() {
  const cont = document.getElementById('notif-lista');
  cont.innerHTML = '<div class="empty-state"><span class="empty-icon">⏳</span><p>Carregando...</p></div>';

  // Usamos os próprios dados de presença para simular notificações
  // (a API de notificações real seria /api/notificacoes/:id)
  const faltas = todosRegistros
    .filter(p => p.status === 'falta' || p.status === 'justificado')
    .slice(0, 15);

  if (!faltas.length) {
    cont.innerHTML = '<div class="empty-state"><span class="empty-icon">🔔</span><p>Nenhuma notificação.</p></div>';
    return;
  }

  cont.innerHTML = faltas.map(p => {
    const d = new Date(p.data).toLocaleDateString('pt-BR');
    const isFalt = p.status === 'falta';
    return `
      <div class="notif-item ${p.status}">
        <span class="notif-icon">${isFalt ? '❌' : '📝'}</span>
        <div class="notif-texto">
          <strong>${isFalt ? 'Falta registrada' : 'Falta justificada'}</strong> — ${p.aluno}<br/>
          ${isFalt
            ? `Foi registrada uma falta para ${p.aluno} no dia ${d}.`
            : `A falta de ${p.aluno} no dia ${d} foi justificada.`}
          <div class="notif-data">${d}</div>
        </div>
      </div>
    `;
  }).join('');
}

// ============================================================
// INIT
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
  carregarResumo();
});
