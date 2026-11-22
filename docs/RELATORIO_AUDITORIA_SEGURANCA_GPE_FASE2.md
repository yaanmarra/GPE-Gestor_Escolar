# RELATÓRIO DE AUDITORIA TÉCNICA DE SEGURANÇA (AppSec) — PROJETO GPE
**Documento Probatório para a Seção 25: Segurança da Informação**  
**Projeto:** GPE — Gestor de Presença Escolar (Fase 02 — 7º Período do Projeto Integrador)  
**Data da Auditoria:** 18 de Outubro de 2026  
**Auditor Responsável:** Equipe de Desenvolvimento e Segurança do Projeto GPE (com apoio de ferramentas automatizadas)  
**Referência Metodológica:** OWASP Top 10:2021, OWASP ASVS 4.0, CWE/SANS Top 25 e CVSS v3.1  

---

## 1. OBJETIVO E METODOLOGIA DA AUDITORIA

O objetivo desta auditoria técnica é avaliar a postura de segurança defensiva do sistema **GPE — Gestor de Presença Escolar**, fornecendo evidências empíricas, testes automatizados controlados e análise estática detalhada para fundamentar a **Seção 25 — Segurança da Informação** do Documento de Especificação do Projeto Integrador.

A metodologia adotada compreendeu:
1. **Inspeção Estática de Código-Fonte (SAST):** Análise aprofundada de rotas Express, middlewares de autenticação e RBAC, funções de criptografia JWT, queries SQL e scripts do cliente (DOM/XSS).
2. **Testes Dinâmicos de Segurança (DAST Local Controlado):** Execução de suíte de testes com **Supertest** e **Jest** contra a API real, operando estritamente sobre banco de testes isolado (`gpe_test`), sem dados reais de alunos e sem testes destrutivos.
3. **Auditoria de Dependências e Componentes de Terceiros (SCA):** Verificação local com `npm audit` para identificação de CVEs conhecidas nas dependências de produção e desenvolvimento.
4. **Classificação e Matriz de Riscos:** Categorização baseada no **OWASP Top 10:2021**, taxonomia **CWE** e pontuação de severidade fundamentada no padrão **CVSS v3.1**.

---

## 2. AMBIENTE DE TESTE E CONFIGURAÇÃO DE SEGURANÇA

| Parâmetro | Detalhes Técnicos |
|---|---|
| **Sistema Operacional** | Windows 11 Professional (x64) |
| **Runtime** | Node.js v24.16.0 / npm v11.13.0 |
| **Banco de Dados Operacional** | MySQL 8.0.43 (Base `gpe` — **completamente isolada e preservada**) |
| **Banco de Dados de Teste** | MySQL 8.0.43 (Base `gpe_test` — provisionada e isolada) |
| **Framework Web** | Express.js v5.2.1 |
| **Mecanismo de Autenticação** | JWT (JsonWebToken v9.0.3) com tokens simétricos HS256 |
| **Criptografia de Senhas** | BcryptJS v3.0.3 (fator de trabalho custo 12) |
| **Proteção de Rede / CORS** | Módulo `cors` restrito a origens confiáveis (`localhost:5500`, `3000`) |
| **Rate Limiting** | `express-rate-limit` v8.7.1 configurado para 100 requisições por 15 min por IP |
| **Observabilidade & Redação** | Pino v10.4.0 com sanitização automática de campos sensíveis |

---

## 3. CONTROLES DE SEGURANÇA EXISTENTES E EFETIVIDADE

| Controle de Segurança | Implementação no Código | Avaliação Técnica | Status |
|---|---|---|---|
| **Hash de Senhas** | `bcrypt.hash(senha, 12)` em [`usuarioRoutes.js:51`](../api/src/routes/usuarioRoutes.js#L51) | Fator de trabalho robusto contra ataques de força bruta offline. | 🟢 Efetivo |
| **Autenticação JWT** | Middleware `autenticar` em [`auth.js:8-41`](../api/src/middlewares/auth.js#L8-L41) | Rejeita tokens ausentes, forjados, com assinatura incorreta ou expirados. | 🟢 Efetivo |
| **Controle de Acesso (RBAC)** | Middleware `autorizar` em [`auth.js:48-66`](../api/src/middlewares/auth.js#L48-L66) | Bloqueia perfis não autorizados em rotas restritas com HTTP 403. | 🟢 Efetivo |
| **Prevenção de SQL Injection** | Driver `mysql2` com prepared statements em todas as rotas | Queries 100% parametrizadas com placeholders `?`. Sem concatenação de strings. | 🟢 Efetivo |
| **Sanitização de Logs de Requisição** | `pino` com política `redact.paths` em [`logger.js:7-20`](../api/src/utils/logger.js#L7-L20) | Remove automaticamente campos `senha`, `token`, `authorization` dos logs. | 🟢 Efetivo |
| **Sanitização de Logs de E-mail** | Função `sanitizarErro()` em [`emailService.js:94-106`](../api/src/services/emailService.js#L94-L106) | Mascara `SENHA_APP` e `DB_PASSWORD` com `***` e limita saída a 500 chars. | 🟢 Efetivo |
| **Proteção contra IDOR de Leitura** | Validações de titularidade em [`presencaRoutes.js:254, 303`](../api/src/routes/presencaRoutes.js#L254) | Aluno e Pai só consultam seus próprios registros; violações retornam 403. | 🟢 Efetivo |

---

## 4. TESTES DE SEGURANÇA EXECUTADOS (EVIDÊNCIAS DE EXECUÇÃO)

Os testes foram formalmente executados por meio da suíte [`tests/segurancaAppSec.test.js`](../api/tests/segurancaAppSec.test.js), operando sob o comando:
```bash
$env:DB_NAME="gpe_test"; npx jest tests/segurancaAppSec.test.js --runInBand
```

### Resumo dos Testes de Segurança:
* **Total Executado:** 12 casos de teste específicos de segurança.
* **Aprovados:** 12 (100% dos testes operaram conforme os comportamentos esperados e capturaram com exatidão as brechas da aplicação).

| ID do Teste | Categoria | Cenário e Condição de Teste | Resultado Esperado vs Obtido | Status |
|---|---|---|---|---|
| **SEC-AUTH-01** | Autenticação | Requisição a rota protegida sem cabeçalho Authorization | Esperado: HTTP 401; Obtido: HTTP 401 (`Token não fornecido`) | 🟢 PASS |
| **SEC-AUTH-02** | Autenticação | Requisição com esquema inválido (ex: `Basic ...`) | Esperado: HTTP 401; Obtido: HTTP 401 (`Token não fornecido`) | 🟢 PASS |
| **SEC-AUTH-03** | Autenticação | Requisição com token JWT cuja assinatura foi adulterada | Esperado: HTTP 401; Obtido: HTTP 401 (`Token inválido`) | 🟢 PASS |
| **SEC-AUTH-04** | Autenticação | Requisição com token JWT com tempo de vida expirado (`0s`) | Esperado: HTTP 401 com `codigo: 'TOKEN_EXPIRADO'`; Obtido: 401 | 🟢 PASS |
| **SEC-AUTH-05** | Sessão / Tokens | Avaliação de Rotação de Refresh Token (RTR) na renovação | Identificar se refresh token é rotacionado. Obtido: **Não rotaciona** | 🟢 PASS |
| **SEC-AUTH-06** | Sessão / Tokens | **Condição de Corrida (Race Condition):** Logout e renovação concorrente | Query sem `await` permite que renovação concorra e tenha êxito | 🟢 PASS |
| **SEC-AUTHZ-01** | **Autorização (Crítica)** | **Professor da Turma Alpha tentando lançar presença para Aluno da Turma Beta (Individual)** | **Esperado pela regra de negócio: 403; Obtido: HTTP 200 (Persistido no Banco!)** | 🔴 **VULN** |
| **SEC-AUTHZ-02** | **Autorização (Crítica)** | **Professor da Turma Alpha registrando chamada em lote para Turma Beta com falta** | **Esperado pela regra de negócio: 403; Obtido: HTTP 200 (Persistido + Outbox Gerado!)** | 🔴 **VULN** |
| **SEC-AUTHZ-03** | Autorização / RBAC | Aluno tentando registrar presença | Esperado: HTTP 403 Forbidden; Obtido: HTTP 403 | 🟢 PASS |
| **SEC-AUTHZ-04** | Autorização / RBAC | Responsável (Pai) tentando criar nova turma escolar | Esperado: HTTP 403 Forbidden; Obtido: HTTP 403 | 🟢 PASS |
| **SEC-SQLI-01** | Injeção SQL | Tentativa de SQL Injection no login (`' OR '1'='1`) | Bloqueado pelo validador de formato de e-mail (HTTP 400) | 🟢 PASS |
| **SEC-SQLI-02** | Injeção SQL | Tentativa de injeção via Query String (`turma_id=1' OR '1'='1`) | Parâmetro tratado como literal; 0 registros vazados (HTTP 200) | 🟢 PASS |

---

## 5. LOGS SANITIZADOS E EVIDÊNCIAS TÉCNICAS

### 1. Evidência da Quebra de Autorização BOLA / IDOR de Escrita (SEC-AUTHZ-01)
Registro gerado no log do servidor Pino demonstrando que o Professor 1 (ID de usuário `prof.alpha@teste.com`), lecionando unicamente na Turma Alpha, efetuou com sucesso um lançamento de presença para o aluno da Turma Beta:
```json
{"level":30,"time":1792368403646,"pid":18632,"req":{"id":16,"method":"POST","url":"/api/registrar-presenca"},"res":{"statusCode":200},"responseTime":6}
```
**Confirmação no Banco de Dados (`gpe_test`):**
```sql
SELECT id, aluno_id, professor_id, data, status FROM presencas WHERE aluno_id = 2;
-- Retornou: id=1, aluno_id=2 (Aluno Beta 2), professor_id=1 (Prof Alpha), status='presente'
```
*Comprovação:* O registro foi persistido associando o professor invasor ao aluno de outra turma, sem qualquer bloqueio da API.

---

### 2. Evidência da Chamada em Lote com Notificação Indevida (SEC-AUTHZ-02)
Requisição HTTP do Professor 1 submetendo presença em lote para a Turma 2:
```json
{"level":30,"time":1792368403662,"pid":18632,"req":{"id":17,"method":"POST","url":"/api/registrar-presenca-turma"},"res":{"statusCode":200},"responseTime":9}
```
**Confirmação no Outbox (`email_jobs`):**
```sql
SELECT id, aluno_id, destinatario, status, tipo_notificacao FROM email_jobs WHERE aluno_id = 2;
-- Retornou: id=1, aluno_id=2, destinatario='pai2.sec@teste.com', status='PENDING', tipo='falta'
```
*Comprovação:* Um e-mail falso de aviso de falta foi agendado para o responsável do Aluno 2, provocado por um professor não vinculado à turma.

---

### 3. Evidência da Condição de Corrida no Logout (SEC-AUTH-06)
Execução simultânea de Logout e Renovação via Refresh Token:
```json
{"level":30,"time":1792368403631,"pid":18632,"req":{"id":14,"method":"POST","url":"/api/logout"},"res":{"statusCode":200},"responseTime":1}
{"level":30,"time":1792368403634,"pid":18632,"req":{"id":15,"method":"POST","url":"/api/refresh-token"},"res":{"statusCode":200},"responseTime":3}
```
*Comprovação:* Como `authRoutes.js:123` dispara `db.query('UPDATE usuarios SET refresh_token = NULL...')` sem `await`, a rota de logout liberou a resposta HTTP imediatamente. A requisição concorrente `POST /api/refresh-token` foi processada antes da gravação no disco, emitindo com sucesso um novo `accessToken` a partir de uma sessão supostamente finalizada.

---

## 6. MATRIZ DE VULNERABILIDADES E CLASSIFICAÇÃO DE RISCOS

A matriz consolida as vulnerabilidades e riscos avaliados segundo a severidade **CVSS v3.1** e categorização **OWASP Top 10:2021** e **CWE**:

| ID | Vulnerabilidade ou Risco | Arquivo e Linha | Evidência | Probabilidade | Impacto | CVSS v3.1 Score & Vetor | Gravidade | Mitigação Recomendada | Estado |
|---|---|---|---|---|---|---|---|---|---|
| **VULN-01** | **BOLA / Ausência de Validação de Turma na Chamada do Professor** | [`presencaRoutes.js:14-50`](../api/src/routes/presencaRoutes.js#L14-L50) e [`presencaRoutes.js:107-158`](../api/src/routes/presencaRoutes.js#L107-L158) | `SEC-AUTHZ-01` e `SEC-AUTHZ-02` (HTTP 200 + DB gravado) | Alta | Alto | **7.1** (`CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:L`) | 🔴 **Alta** | Validar se `turma_id` ou `aluno_id` pertence a `professor_turma` do usuário autenticado antes de persistir. | **Confirmada por Teste** |
| **VULN-02** | **Condição de Corrida no Logout (Query Assíncrona Fire-and-Forget)** | [`authRoutes.js:120-131`](../api/src/routes/authRoutes.js#L120-L131) | `SEC-AUTH-06` (Renovação sucedeu com HTTP 200 concorrente) | Média | Baixo | **4.2** (`CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:U/C:L/I:L/A:N`) | 🟡 **Média** | Utilizar `await dbPromise.query('UPDATE usuarios SET refresh_token = NULL...')` antes de retornar HTTP 200. | **Confirmada por Teste** |
| **VULN-03** | **Risco de Stored XSS por Renderização em `innerHTML`** | [`professor.js:288-299`](../frontend/js/professor.js#L288-L299) e [`gestor.js:273, 359`](../frontend/js/gestor.js#L273) | Interpolação de `${aluno.nome}` direto em strings HTML | Baixa | Médio | **4.8** (`CVSS:3.1/AV:N/AC:L/PR:H/UI:R/S:C/C:L/I:L/A:N`) | 🟡 **Média** | Substituir `innerHTML` por `textContent` ou aplicar função de escape de caracteres HTML (`&, <, >, ", '`). | **Identificada por Inspeção** |
| **VULN-04** | **Armazenamento Inseguro de Refresh Token em `localStorage`** | [`frontend/js/auth.js:24-27`](../frontend/js/auth.js#L24-L27) | `localStorage.setItem('refresh_token', ...)` acessível via JS | Média | Médio | **5.3** (`CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:H/I:N/A:N`) | 🟡 **Média** | Migrar armazenamento de Refresh Token para cookies HTTP-Only com flags `Secure` e `SameSite=Strict`. | **Identificada por Inspeção** |
| **VULN-05** | **Ausência de Rotação de Refresh Token (RTR)** | [`authRoutes.js:72-108`](../api/src/routes/authRoutes.js#L72-L108) | `SEC-AUTH-05` (Mesmo refresh token reutilizável por 7 dias) | Média | Baixo | **3.7** (`CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:U/C:L/I:L/A:N`) | 🟢 **Baixa** | Gerar e persistir um novo Refresh Token a cada ciclo de renovação, invalidando o anterior. | **Confirmada por Teste** |
| **VULN-06** | **Inconsistência de Cancelamento de E-mail no Outbox após Retificação** | [`presencaRoutes.js:154-196`](../api/src/routes/presencaRoutes.js#L154-L196) | Falta alterada para 'presente' mantém job PENDING na fila | Alta | Baixo | **3.1** (`CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:L/A:N`) | 🟢 **Baixa** | Ao atualizar status para diferente de 'falta', cancelar job PENDING em `email_jobs`. | **Identificada por Inspeção** |
| **VULN-07** | **Agrupamento Ambíguo de Alunos Homônimos em Relatórios** | [`presencaRoutes.js:347, 360`](../api/src/routes/presencaRoutes.js#L347) | Cláusula `GROUP BY u.nome` unifica dados de homônimos | Baixa | Baixo | **3.7** (`CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:U/C:L/I:L/A:N`) | 🟢 **Baixa** | Alterar consulta para `GROUP BY a.id, u.nome` para respeitar identificador único do aluno. | **Identificada por Inspeção** |
| **VULN-08** | **DoS em Dependência de Desenvolvimento (`sprintf-js` <= 1.1.3)** | `api/package-lock.json` | `npm audit`: GHSA-hp3w-g68c-fv3c (CWE-1284) | Baixa | Baixo | **5.3** (`CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L`) | 🟢 **Baixa** | Atualizar Jest (`devDependencies`). Não afeta o código de produção em execução. | **Risco Residual (Dev)** |

---

## 7. RELAÇÃO ENTRE RISCOS DE SEGURANÇA E REQUISITOS (RF / RNF)

```
Requisitos do GPE sob a Ótica de Segurança
├── RNF-001 (Segurança da Informação e LGPD)
│   ├── Vulnerabilidade VULN-01 (Professor adulterando dados de outra turma) ────► 🔴 Impacto Direto
│   ├── Vulnerabilidade VULN-04 (Tokens em localStorage sujeitos a XSS) ────────► 🟡 Risco Residual
│   └── Proteção IDOR / BOLA de Leitura (Pais e Alunos isolados) ───────────────► 🟢 Controle Eficaz
├── RNF-004 (Controle de Acesso e Autenticação)
│   ├── Vulnerabilidade VULN-02 (Condição de corrida no Logout) ────────────────► 🟡 Risco Moderado
│   ├── Vulnerabilidade VULN-05 (Ausência de Refresh Token Rotation) ───────────► 🟢 Risco Baixo
│   └── Middleware de Autorização RBAC (/api/usuarios, /api/turmas) ────────────► 🟢 Controle Eficaz
├── RNF-003 (Integridade e Persistência Confiável)
│   ├── Vulnerabilidade VULN-07 (Agrupamento incorreto de homônimos) ───────────► 🟢 Risco Operacional
│   └── Prepared Statements em 100% das queries (Anti-SQLi) ────────────────────► 🟢 Controle Eficaz
└── RNF-005 (Confiabilidade de Notificações)
    └── Vulnerabilidade VULN-06 (Outbox não cancela e-mail após retificação) ───► 🟢 Risco de Comunicação
```

---

## 8. RECOMENDAÇÕES PRIORIZADAS DE REMEDIAÇÃO

Com base no princípio da defesa em profundidade e na criticidade do impacto:

### Prioridade 1 (Imediata — Criticidade Alta)
* **Blindar Autorização de Escrita em Presenças:**
  No início de `POST /api/registrar-presenca` e `POST /api/registrar-presenca-turma`, validar se a turma e os alunos informados estão associados ao ID do professor em `professor_turma`. Se não houver vínculo e o usuário não for `gestor`, abortar imediatamente com `HTTP 403 Forbidden` (`Acesso negado. Você não tem autorização para lançar chamada nesta turma`).

### Prioridade 2 (Curto Prazo — Criticidade Média)
* **Tornar o Logout Estritamente Síncrono:**
  Em `src/routes/authRoutes.js`, substituir a chamada `db.query` por `await dbPromise.query('UPDATE usuarios SET refresh_token = NULL WHERE id = ?', [decoded.id])` para eliminar a janela de corrida na invalidação da sessão.
* **Mitigar Risco de XSS no Frontend:**
  Criar helper de higienização de strings no cliente (ou adotar `element.textContent`) nas telas `professor.js`, `gestor.js`, `pais.js` e `aluno.js` para renderizar nomes de alunos e turmas de forma segura.

### Prioridade 3 (Médio Prazo — Melhorias Estruturais)
* **Implementar Refresh Token Rotation (RTR):**
  A cada chamada a `/api/refresh-token`, invalidar o refresh token utilizado e persistir um novo par de tokens.
* **Migrar Tokens para Cookies HTTP-Only:**
  Configurar o transporte do refresh token por meio de cookies com as flags `HttpOnly`, `Secure` e `SameSite=Strict`.
* **Corrigir Homônimos nos Relatórios:**
  Alterar a agregação em `presencaRoutes.js` para `GROUP BY a.id, u.nome`.

---

## 9. LIMITAÇÕES DA ANÁLISE

1. **Escopo Local e Sintético:** Todos os testes de injeção e autorização foram executados em ambiente isolado (`gpe_test`) utilizando exclusivamente dados sintéticos, sem impacto sobre dados reais.
2. **Ausência de Testes Destrutivos / DoS:** Em estrito cumprimento às regras da auditoria, não foram realizados testes volumétricos de negação de serviço distribuída (DDoS) nem testes de estresse com quebra de limites do provedor SMTP (Google).
3. **WAF e Redes Externas:** O teste avaliou a segurança intrínseca da aplicação (camada de código e banco de dados). Controles de infraestrutura perimetral (como Cloudflare WAF, firewalls de rede e terminação SSL/TLS) não foram avaliados, pois a aplicação operou em ambiente de desenvolvimento local.

---

## 10. CONCLUSÃO TÉCNICA E PARECER PARA A SEÇÃO 25

A avaliação técnica de segurança do **GPE — Gestor de Presença Escolar** comprovou a existência de controles arquiteturais modernos e bem implementados:
* Criptografia forte de credenciais (Bcrypt custo 12);
* Sanitização ativa de segredos nos logs (`pino` e `sanitizarErro`);
* Ausência de SQL Injection em virtude de parametrização uniforme com `mysql2`;
* Proteção efetiva contra leitura cruzada de dados por Alunos e Pais (IDOR de consulta sanado).

**PARECER CRÍTICO CONCLUSIVO:**
> O sistema **NÃO PODE SER DECLARADO COMPLETAMENTE SEGURO NEM EM PLENA CONFORMIDADE COM A LGPD** no seu estágio atual. A verificação experimental confirmou uma **falha crítica de Broken Object Level Authorization (BOLA) na escrita de frequências** (`SEC-AUTHZ-01` e `SEC-AUTHZ-02`), permitindo que um professor autenticado registre ou altere faltas de turmas e alunos sob responsabilidade de outros docentes, desencadeando inclusive comunicações externas indevidas aos responsáveis.

A resolução prioritária dessa brecha de autorização, combinada com a sincronização do encerramento de sessão (logout) e a proteção de renderização no frontend, elevará o sistema a um patamar robusto de confiabilidade e conformidade para sua entrega final.

