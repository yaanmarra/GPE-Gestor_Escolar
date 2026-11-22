# RELATÓRIO TÉCNICO DE CORREÇÃO E REGRESSÃO — VULN-01 (BOLA/IDOR) E TC-39 (IDEMPOTÊNCIA)
**Projeto:** GPE — Gestor de Presença Escolar (Fase 03 — 7º Período)  
**Data da Execução:** 08/11/2026  
**Escopo:** Correção de Segurança (`VULN-01`), Correção Funcional e Transacional (`TC-39`), Blindagem do Banco de Testes (`gpe_test`), Bateria de Testes de Regressão e Textos Técnicos para Atualização Documental (Seções 24 e 25).

---

## 10.1 Resumo Executivo

| Indicador / Pendência | Estado Anterior (Auditoria Inicial) | Estado Atual (Pós-Correção) |
| :--- | :--- | :--- |
| **`VULN-01` — BOLA / IDOR em Escrita de Presença** | **ABERTA (Crítica / Alta — CVSS 8.1)** — Endpoints `POST /api/registrar-presenca` e `POST /api/registrar-presenca-turma` permitiam que um professor autenticado registrasse presenças/faltas para alunos de turmas alheias, aceitavam `professor_id` arbitrário no corpo da requisição e possuíam fallback `SELECT id FROM professores ORDER BY id ASC LIMIT 1`. | **CORRIGIDA E VALIDADA (100%)** — Identidade do professor resolvida exclusivamente via JWT (`req.usuario.id` $\rightarrow$ `professores.usuario_id`), bloqueio de falsificação (`spoofing`) de `professor_id` com `HTTP 403`, validação estrita de vínculo em `professor_turma` e pertinência de todos os alunos à turma autorizada, e remoção integral do fallback `ORDER BY id ASC LIMIT 1` tanto para `professor` (`HTTP 403`) quanto para `gestor` (`HTTP 400`). |
| **`VULN-02` — Condição de Corrida no Logout / Login** | **ABERTA (Média — CVSS 4.2)** — `authRoutes.js` disparava `db.query('UPDATE usuarios SET refresh_token = ...')` sem `await`, permitindo que uma renovação imediata sucedesse após o logout. | **CORRIGIDA E VALIDADA (100%)** — Rotas `/api/login`, `/api/refresh-token` e `/api/logout` refatoradas para `async/await` com `dbPromise.query`; `SEC-AUTH-06` valida revogação síncrona imediata (`refresh_token = NULL` e `HTTP 401` imediato). |
| **`TC-39` — Idempotência e Retificação no Registro Individual** | **FALHA (`HTTP 500` — `ER_DUP_ENTRY`)** — O endpoint `POST /api/registrar-presenca` executava `INSERT INTO presencas` puro, gerando erro `1062 Duplicate entry` na repetição ou retificação de chamada e não cancelava jobs pendentes quando uma `falta` era retificada para `presente` ou `justificado`. | **CORRIGIDO E VALIDADO (100%)** — Implementada máquina de estados transacional com bloqueio pessimista (`SELECT ... FOR UPDATE`) e `ON DUPLICATE KEY UPDATE`, suportando repetição idempotente (`HTTP 200`), retificação (`falta` $\rightarrow$ `presente`/`justificado`) com cancelamento de jobs pendentes em `email_jobs` e `whatsapp_jobs` (preservando `SENT`) e reativação (`presente` $\rightarrow$ `falta`). |
| **Proteção Programática do Banco de Testes (`gpe_test`)** | **PARCIAL** — Dependia de configuração manual de `DB_NAME`; caso `.env` apontasse para `gpe`, os comandos `TRUNCATE TABLE` das suítes de integração limpavam o banco de desenvolvimento. | **BLINDADO (`validarBancoDeTeste` + `garantirSchemaPortfolio`)** — Override automático para `gpe_test` quando `NODE_ENV=test`, trava programática dupla (`process.env.DB_NAME` + `SELECT DATABASE()`) e provisionamento idempotente do esquema antes das suítes de integração. |
| **Resultado Global da Suíte Automatizada (Jest)** | **99/100 aprovados (99,0%)** — 1 falha no `TC-39` e asserções permissivas (`expect([200, 403])`) em `segurancaAppSec.test.js`. | **124/124 testes aprovados (100,0%) em 10 suítes** (`21,10 s`) — Incluindo 11 testes de regressão AppSec (`SEC-REG-01` a `SEC-REG-11`), revogação síncrona (`SEC-AUTH-06`), guarda de banco (`SEC-DB-GUARD-01`), regressão de idempotência (`TC-39-01` a `TC-39-10`) e cobertura global de `64,58%` linhas (`70,03%` branches em `presencaRoutes.js`). |

---

## 10.2 Diagnóstico da VULN-01

### Causa-Raiz
1. **Ausência de validação de vínculo de objeto (BOLA/IDOR) na escrita:** Embora os endpoints de leitura (`GET /api/turmas/:id/alunos`, `GET /api/presencas/:alunoId`, `GET /api/presencas-turma`) verificassem o vínculo do professor autenticado na tabela `professor_turma`, os dois endpoints de escrita (`POST /api/registrar-presenca` e `POST /api/registrar-presenca-turma`) validavam apenas o papel no nível de rota (`autorizar('professor', 'gestor')`), sem confirmar se o professor autenticado lecionava na turma do(s) aluno(s) alvo(s).
2. **Aceitação de `professor_id` enviado pelo cliente (Parameter Tampering / Spoofing):** Ambos os endpoints priorizavam `req.body.professor_id` quando enviado na requisição antes de buscar o cadastro do professor autenticado, permitindo que um professor autenticado atribuísse chamadas a outro docente.
3. **Fallback inseguro para o primeiro professor da tabela:** Quando o usuário autenticado não possuía linha em `professores`, o código executava `SELECT id FROM professores ORDER BY id ASC LIMIT 1`, associando silenciosamente a operação ao primeiro professor cadastrado no banco.

### Trechos Afetados (Estado Anterior)
- `api/src/routes/presencaRoutes.js` (linhas 28–112 no estado anterior): `POST /api/registrar-presenca`.
- `api/src/routes/presencaRoutes.js` (linhas 117–215 no estado anterior): `POST /api/registrar-presenca-turma`.

### Risco de Segurança
- **Classificação OWASP API Security Top 10 (2023):** `API1:2023 — Broken Object Level Authorization (BOLA)`.
- **Severidade:** **Alta (CVSS v3.1: 8.1 — `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:H`)**.
- **Impacto:** Adulteração de registros acadêmicos oficiais de frequência de qualquer turma por qualquer conta de perfil `professor` e disparo indevido em massa de notificações de falta por e-mail e WhatsApp aos responsáveis legais.

---

## 10.3 Solução Implementada para VULN-01

### Arquivos Alterados
- `GPE_Sprint2/api/src/routes/presencaRoutes.js` (linhas 28–223 para `POST /api/registrar-presenca` e linhas 227–451 para `POST /api/registrar-presenca-turma`).

### Lógica de Autorização e Integridade Aplicada
1. **Resolução exclusiva da identidade do professor autenticado (`req.usuario.tipo === 'professor'`):**
   - Consulta obrigatória `SELECT id FROM professores WHERE usuario_id = ? LIMIT 1` usando `req.usuario.id` extraído do token JWT validado.
   - Caso o usuário autenticado não possua registro correspondente na tabela `professores`, a transação é imediatamente abortada com **`HTTP 403 Forbidden`** (`"Acesso negado. Cadastro de professor não encontrado para o usuário autenticado."`). O fallback `SELECT id FROM professores ORDER BY id ASC LIMIT 1` foi **integralmente removido** para o perfil `professor`.
2. **Bloqueio de falsificação de `professor_id` (`SEC-REG-10`):**
   - Se o cliente enviar `professor_id` no corpo da requisição e o valor divergir do `professores.id` pertencente ao usuário autenticado, a requisição é rejeitada com **`HTTP 403 Forbidden`** (`"Acesso negado. Não é permitido registrar presença/chamada em nome de outro professor."`).
3. **Verificação da turma do aluno e homogeneidade do lote (`SEC-REG-09`):**
   - No endpoint individual (`POST /api/registrar-presenca`), o aluno é consultado com `SELECT id, turma_id FROM alunos WHERE id = ? FOR UPDATE`.
   - No endpoint em lote (`POST /api/registrar-presenca-turma`), todos os alunos do array `presencas` são consultados e bloqueados com `SELECT id, turma_id FROM alunos WHERE id IN (?) FOR UPDATE`. Se qualquer `aluno_id` não existir (`HTTP 404`), não possuir turma ou pertencer a uma turma diferente da turma-alvo do lote, a transação sofre `ROLLBACK` completo e retorna **`HTTP 403 Forbidden`** (`"Acesso negado. Todos os alunos do lote devem pertencer à mesma turma autorizada."`).
4. **Verificação obrigatória de vínculo em `professor_turma` (`SEC-REG-01` a `SEC-REG-05`):**
   - Confirma-se a existência do vínculo `SELECT 1 FROM professor_turma WHERE professor_id = ? AND turma_id = ? LIMIT 1` entre o professor autenticado e a turma efetiva do(s) aluno(s).
   - Quando `grade_horaria_id` é informado, valida-se adicionalmente em `grade_horaria` se o slot pertence a `(professor_id, turma_id)`.
   - Na ausência de vínculo válido, a transação sofre `ROLLBACK` imediato e retorna **`HTTP 403 Forbidden`** (`"Acesso negado. Você não possui vínculo com a turma deste aluno / com esta turma."`), sem gravar nenhuma linha em `presencas`, `notificacoes`, `email_jobs` ou `whatsapp_jobs`.
5. **Regras por Perfil (RBAC + ABAC):**
   - **`professor`**: Escrita permitida **exclusivamente** para alunos de turmas às quais está vinculado em `professor_turma`, sempre sob seu próprio `professor_id`.
   - **`gestor`**: Mantém prerrogativa administrativa de registro e retificação em qualquer turma válida (`SEC-REG-06`), preservando a autoria original (`professor_id`) quando retifica um registro existente.
   - **`aluno` e `pai`**: Bloqueados na camada de middleware `autorizar('professor', 'gestor')` com **`HTTP 403 Forbidden`** (`SEC-REG-07`).
   - **Não autenticado**: Bloqueado pelo middleware `autenticar` com **`HTTP 401 Unauthorized`** (`SEC-REG-08`).

---

## 10.4 Diagnóstico do TC-39

### Causa-Raiz
1. **Violação de chave única no endpoint individual (`ER_DUP_ENTRY`):**
   - A tabela `presencas` possui o índice único `UNIQUE KEY idx_presenca_unica (aluno_id, data, professor_id)` (ou `(aluno_id, data, professor_id, slot_aula)` após a migração 5).
   - Enquanto `POST /api/registrar-presenca-turma` utilizava `INSERT INTO presencas ... ON DUPLICATE KEY UPDATE status = VALUES(status)`, o endpoint individual `POST /api/registrar-presenca` executava `INSERT INTO presencas (aluno_id, professor_id, data, status) VALUES (?, ?, ?, ?)` sem cláusula de resolução de conflito nem verificação prévia.
   - Como consequência, qualquer reenvio da mesma presença individual (por duplo clique, retry de rede ou retificação pelo professor) disparava exceção MySQL `ER_DUP_ENTRY (errno 1062)`, capturada pelo bloco `catch` genérico como **`HTTP 500 Internal Server Error`**.
2. **Ausência de cancelamento de notificações pendentes na retificação individual:**
   - Ao retificar um registro individual de `falta` para `presente` ou `justificado`, o endpoint individual não invocava `notificacaoService.cancelarFaltasCorrigidas(...)`, mantendo jobs de falta pendentes na fila de envio.
3. **Ordem de avaliação de colunas no `ON DUPLICATE KEY UPDATE` de `email_jobs` e cancelamento restrito ao WhatsApp:**
   - Em `notificacaoService.js`, `cancelarFaltasCorrigidas` atualizava apenas `whatsapp_jobs`, deixando `email_jobs` com `status = 'PENDING'` mesmo após a retificação da falta antes do envio pelo worker.
   - Além disso, em `registrarFaltas`, a tabela `notificacoes` sofria `INSERT` incondicional a cada chamada repetida, e `email_jobs` utilizava `ON DUPLICATE KEY UPDATE id = id`, impedindo que um job previamente cancelado por retificação (`falta` $\rightarrow$ `presente` $\rightarrow$ `falta` no mesmo dia — Caso D) voltasse ao status `PENDING`.

---

## 10.5 Solução Implementada para TC-39

### Arquivos Alterados
- `GPE_Sprint2/api/src/routes/presencaRoutes.js` (linhas 150–222 e 374–443).
- `GPE_Sprint2/api/src/services/notificacaoService.js` (linhas 67–163).

### Estratégia SQL, Transacional e Máquina de Estados de Presença
Todas as operações de leitura de estado anterior, escrita em `presencas` e enfileiramento/cancelamento no Transactional Outbox (`notificacoes`, `email_jobs` e `whatsapp_jobs`) executam dentro da **mesma transação MySQL** (`conn.beginTransaction()` ... `conn.commit()` / `conn.rollback()`):

1. **Serialização de Requisições Concorrentes (`TC-39-07`):**
   - Ao iniciar a transação, o registro do aluno em `alunos` é bloqueado com `SELECT id, turma_id FROM alunos WHERE id = ? FOR UPDATE`, serializando requisições concorrentes para o mesmo aluno.
   - Em seguida, consulta-se o registro de presença existente para `(aluno_id, data)` (e `grade_horaria_id`, quando aplicável) também com `FOR UPDATE`.
2. **Tratamento dos 4 Casos de Negócio (`Caso A`, `Caso B`, `Caso C`, `Caso D`):**
   - **Caso A — Primeiro registro para `(aluno_id, data)`:**
     - Executa `INSERT INTO presencas ... ON DUPLICATE KEY UPDATE status = VALUES(status), turma_id = COALESCE(VALUES(turma_id), turma_id)`.
     - Se `status === 'falta'`, invoca `notificacaoService.registrarFaltas(conn, { alunoIds: [alunoIdNum], data })`.
     - Retorna `HTTP 200` com `{ alterado: true, status_anterior: null }`.
   - **Caso B — Repetição idêntica do mesmo status (`presente` $\rightarrow$ `presente` ou `falta` $\rightarrow$ `falta`):**
     - Detecta que `statusAnterior === status`. Não duplica linhas em `presencas`, não duplica avisos em `notificacoes` e não recria nem altera jobs em `email_jobs` ou `whatsapp_jobs`.
     - Retorna `HTTP 200` com `{ alterado: false, status_anterior: statusAnterior }`.
   - **Caso C — Retificação de `falta` para `presente` ou `justificado`:**
     - Atualiza o registro existente em `presencas` por `id` (`UPDATE presencas SET status = ?, turma_id = COALESCE(?, turma_id) WHERE id = ?`), preservando o `professor_id` original mesmo quando a retificação é realizada por um `gestor`.
     - Invoca `notificacaoService.cancelarFaltasCorrigidas(conn, { alunoIds: [alunoIdNum], data })`, que cancela jobs ainda não enviados (`status IN ('PENDING', 'RETRY')`):
       - Em `email_jobs`: define `status = 'FAILED'`, `ultimo_erro = 'Presença corrigida antes do envio'`, `processado_em = NOW()`, `proxima_tentativa_em = NULL`.
       - Em `whatsapp_jobs`: define `status = 'CANCELLED'`, `ultimo_erro = 'Presença corrigida antes do envio'`, `processado_em = NOW()`, `proxima_tentativa_em = NULL`.
       - Jobs já enviados (`status = 'SENT'`) **nunca são alterados**.
     - Retorna `HTTP 200` com `{ alterado: true, status_anterior: 'falta' }`.
   - **Caso D — Alteração de `presente` ou `justificado` para `falta`:**
     - Atualiza `presencas.status = 'falta'`.
     - Invoca `notificacaoService.registrarFaltas(conn, ...)`:
       - Verifica se já existe notificação in-app idêntica em `notificacoes` antes de inserir (`SELECT id FROM notificacoes WHERE usuario_id = ? AND mensagem = ? LIMIT 1`).
       - Insere em `email_jobs` e `whatsapp_jobs` com cláusula `ON DUPLICATE KEY UPDATE` que reativa para `status = 'PENDING'` (zerando `tentativas` e limpando `ultimo_erro`) caso o job anterior daquele dia estivesse cancelado por retificação prévia (`status = 'FAILED' AND ultimo_erro = 'Presença corrigida antes do envio'` em `email_jobs`, ou `status IN ('CANCELLED', 'FAILED')` em `whatsapp_jobs`). Respeita-se a avaliação sequencial esquerda-para-direita do MySQL atualizando `status` antes de limpar `ultimo_erro`.
     - Retorna `HTTP 200` com `{ alterado: true, status_anterior: 'presente' | 'justificado' }`.

---

## 10.6 Proteção do Banco de Testes (`gpe_test`)

Para cumprir rigorosamente a determinação de não executar `TRUNCATE` ou `DELETE` destrutivo contra o banco principal `gpe`:

1. **Redirecionamento Automático em Ambiente de Teste (`api/src/config/database.js`, linhas 12–19):**
   - Quando `NODE_ENV === 'test'` e `GITHUB_ACTIONS !== 'true'`, caso `process.env.DB_NAME` esteja vazio ou configurado como `'gpe'` no `.env`, o módulo força automaticamente `process.env.DB_NAME = process.env.DB_TEST_NAME || 'gpe_test'` antes da criação do pool MySQL.
2. **Trava Programática Dupla (`validarBancoDeTeste` em `api/src/config/database.js`, linhas 45–68):**
   - Verifica se `DB_NAME` contém explicitamente o sufixo/prefixo de teste (`test` / `teste`) e rejeita imediatamente se for `'gpe'` ou qualquer nome sem identificador de teste.
   - Executa `SELECT DATABASE() AS db_atual` diretamente no pool MySQL ativo e aborta com erro explícito (`[SEGURANÇA DE TESTES] Execução abortada...`) caso a conexão ativa aponte para `'gpe'` ou qualquer banco não isolado.
3. **Aplicação em Todas as Suítes de Integração:**
   - `await validarBancoDeTeste(...)` foi inserido como a primeira instrução do bloco `beforeAll` em `tests/segurancaAppSec.test.js`, `tests/api.test.js`, `tests/requisitosIntegracao.test.js`, `tests/emailWorker.integration.test.js` e `tests/whatsappWorker.integration.test.js`, além de ser validado por teste unitário dedicado (`SEC-DB-GUARD-01`).

---

## 10.7 Matriz de Testes de Regressão

### A) Regressão de Segurança (`VULN-01` e Guarda de Banco) — `api/tests/segurancaAppSec.test.js`

| ID | Arquivo | Cenário | Entrada Resumida | Resultado Esperado | Resultado Obtido | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **SEC-DB-GUARD-01** | `tests/segurancaAppSec.test.js` | Guarda programática `validarBancoDeTeste` contra uso de banco `gpe` ou `gpe_producao` | `DB_NAME: "gpe"`, `"gpe_producao"` e pool retornando `db_atual: "gpe"` | Rejeitar promessa com erro `[SEGURANÇA DE TESTES]` antes de qualquer query destrutiva | Promessa rejeitada com `[SEGURANÇA DE TESTES]` nos 3 casos | **PASS** |
| **SEC-REG-01** | `tests/segurancaAppSec.test.js` | Professor vinculado à Turma A registra presença individual de aluno da Turma A | `POST /api/registrar-presenca` (`tokenProf1`, `aluno_id: recAluno1`, `status: 'presente'`) | `HTTP 200`, 1 linha gravada em `presencas` com `professor_id = recProf1` e `turma_id = idTurma1` | `HTTP 200`, registro persistido corretamente | **PASS** |
| **SEC-REG-02** | `tests/segurancaAppSec.test.js` | Professor vinculado à Turma A tenta registrar presença individual de aluno da Turma B | `POST /api/registrar-presenca` (`tokenProf1`, `aluno_id: recAluno2`, `status: 'falta'`) | `HTTP 403`, 0 linhas em `presencas`, `notificacoes`, `email_jobs` e `whatsapp_jobs` | `HTTP 403`, 0 efeitos colaterais no banco | **PASS** |
| **SEC-REG-03** | `tests/segurancaAppSec.test.js` | Professor vinculado à Turma A registra presença em lote da Turma A | `POST /api/registrar-presenca-turma` (`tokenProf1`, `turma_id: idTurma1`, `[recAluno1]`) | `HTTP 200`, 1 linha gravada em `presencas` para `recAluno1` | `HTTP 200`, registro persistido corretamente | **PASS** |
| **SEC-REG-04** | `tests/segurancaAppSec.test.js` | Professor vinculado à Turma A tenta registrar presença em lote da Turma B | `POST /api/registrar-presenca-turma` (`tokenProf1`, `turma_id: idTurma2`, `[recAluno2: falta]`) | `HTTP 403`, 0 linhas em `presencas`, `notificacoes`, `email_jobs` e `whatsapp_jobs` | `HTTP 403`, 0 efeitos colaterais no banco | **PASS** |
| **SEC-REG-05** | `tests/segurancaAppSec.test.js` | Professor sem vínculo em `professor_turma` e professor sem cadastro em `professores` tentam registrar presença | `POST /api/registrar-presenca` e `POST /api/registrar-presenca-turma` com `tokenProfSemVinculo` e `tokenProfSemCadastro` | `HTTP 403` em todas as tentativas, sem fallback para o primeiro professor, 0 efeitos colaterais | `HTTP 403` nas 3 tentativas, 0 linhas gravadas | **PASS** |
| **SEC-REG-06** | `tests/segurancaAppSec.test.js` | Gestor registra presença individual e em lote em qualquer turma válida | `POST /api/registrar-presenca` e `POST /api/registrar-presenca-turma` (`tokenGestor`, `recAluno2`) | `HTTP 200` em ambas as operações | `HTTP 200` em ambas as operações | **PASS** |
| **SEC-REG-07** | `tests/segurancaAppSec.test.js` | Aluno ou Pai tenta registrar presença individual ou em lote | `POST /api/registrar-presenca` (`tokenAluno1`) e `POST /api/registrar-presenca-turma` (`tokenPai1`) | `HTTP 403` em ambas, 0 linhas gravadas | `HTTP 403` em ambas, 0 efeitos colaterais | **PASS** |
| **SEC-REG-08** | `tests/segurancaAppSec.test.js` | Requisição sem token tenta registrar presença individual e em lote | `POST /api/registrar-presenca` e `POST /api/registrar-presenca-turma` sem header `Authorization` | `HTTP 401` em ambas, 0 linhas gravadas | `HTTP 401` em ambas, 0 efeitos colaterais | **PASS** |
| **SEC-REG-09** | `tests/segurancaAppSec.test.js` | Professor da Turma A envia lote da Turma A infiltrando aluno da Turma B | `POST /api/registrar-presenca-turma` (`turma_id: idTurma1`, `presencas: [recAluno1, recAluno2]`) | `HTTP 403` e `ROLLBACK` total (nem `recAluno1` nem `recAluno2` gravados) | `HTTP 403`, `ROLLBACK` confirmado (0 linhas para ambos) | **PASS** |
| **SEC-REG-10** | `tests/segurancaAppSec.test.js` | Professor 1 envia `professor_id: recProf2` no body (individual e lote) para falsificar autoria | `POST /api/registrar-presenca` e `POST /api/registrar-presenca-turma` com `professor_id: recProf2` | `HTTP 403` por divergência com a identidade autenticada, 0 linhas gravadas | `HTTP 403` em ambos os endpoints, 0 efeitos colaterais | **PASS** |
| **SEC-REG-11** | `tests/segurancaAppSec.test.js` | Gestor tenta registrar presença em turma sem professor vinculado e sem informar `professor_id` | `POST /api/registrar-presenca` e `POST /api/registrar-presenca-turma` em turma sem docente | `HTTP 400` sem fallback para "primeiro professor", 0 linhas gravadas | `HTTP 400` em ambos os endpoints, 0 efeitos colaterais | **PASS** |

### B) Regressão de Idempotência, Retificação e Transação (`TC-39`) — `api/tests/api.test.js`

| ID | Arquivo | Cenário | Entrada Resumida | Resultado Esperado | Resultado Obtido | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **TC-39-01** | `tests/api.test.js` | Primeiro registro individual de presença (`presente`) | `POST /api/registrar-presenca` (`aluno_id: idAluno`, `data: '2026-10-01'`, `status: 'presente'`) | `HTTP 200`, 1 linha em `presencas` (`status = 'presente'`), 0 jobs em `email_jobs` | `HTTP 200`, 1 linha em `presencas`, 0 jobs | **PASS** |
| **TC-39-02** | `tests/api.test.js` | Segundo registro individual idêntico (`presente` $\rightarrow$ `presente`) | Repetição de `POST /api/registrar-presenca` (`data: '2026-10-01'`, `status: 'presente'`) | `HTTP 200` (`alterado: false`), sem `HTTP 500` (`ER_DUP_ENTRY`), 1 única linha em `presencas` | `HTTP 200` (`alterado: false`), 1 linha em `presencas` | **PASS** |
| **TC-39-03** | `tests/api.test.js` | Retificação individual de `falta` para `presente` e `justificado` | `POST /api/registrar-presenca` alterando `2026-10-01` de `falta` para `presente` e depois `justificado` | `HTTP 200` (`alterado: true`), status atualizado na mesma linha de `presencas` | `HTTP 200`, status atualizado sem duplicidade | **PASS** |
| **TC-39-04** | `tests/api.test.js` | Alteração individual de `presente` para `falta` | `POST /api/registrar-presenca` (`data: '2026-10-01'`, `status: 'falta'`) | `HTTP 200` (`alterado: true`, `status_anterior: 'presente'`), 1 job `PENDING` em `email_jobs` e 1 aviso em `notificacoes` | `HTTP 200`, presença atualizada para `falta`, job `PENDING` e notificação criados | **PASS** |
| **TC-39-05** | `tests/api.test.js` | Registro individual de `falta` repetido (`falta` $\rightarrow$ `falta`) | Repetição de `POST /api/registrar-presenca` (`data: '2026-10-01'`, `status: 'falta'`) | `HTTP 200` (`alterado: false`), mantendo exatamente 1 linha em `presencas`, 1 em `email_jobs` e 1 em `notificacoes` | `HTTP 200`, nenhuma duplicação em `presencas`, `notificacoes` ou `email_jobs` | **PASS** |
| **TC-39-06** | `tests/api.test.js` | Retificação `falta` $\rightarrow$ `presente` cancela `email_jobs` e `whatsapp_jobs` pendentes, reativa se voltar a `falta` e preserva `SENT` | Transições `falta` $\rightarrow$ `presente` $\rightarrow$ `falta` $\rightarrow$ (`SENT`) $\rightarrow$ `justificado` em `2026-10-01` | Jobs `PENDING` vão para `FAILED`/`CANCELLED` com motivo `'Presença corrigida antes do envio'`; voltam para `PENDING` se `falta` reativada; permanecem `SENT` se já enviados | `HTTP 200`, transições de fila verificadas em `email_jobs` e `whatsapp_jobs`, `SENT` preservado | **PASS** |
| **TC-39-07** | `tests/api.test.js` | Duas requisições simultâneas (`Promise.all`) para o mesmo aluno e data | 2 chamadas paralelas `POST /api/registrar-presenca` (`data: '2026-10-03'`, `status: 'falta'`) | Ambas retornam `HTTP 200`, 1 único registro em `presencas` e 1 único job em `email_jobs` | Ambas `HTTP 200`, 1 linha em `presencas` e 1 job em `email_jobs` | **PASS** |
| **TC-39-08** | `tests/api.test.js` | Consistência entre chamada em lote, retificação individual pelo Gestor e reativação em lote | Lote (`falta`) $\rightarrow$ Lote repetido $\rightarrow$ Individual Gestor (`presente`) $\rightarrow$ Lote (`falta`) em `2026-10-02` | `HTTP 200` em todas as etapas, preservando `professor_id` original e alternando o job `PENDING` $\rightarrow$ `FAILED` $\rightarrow$ `PENDING` sem duplicar linhas | `HTTP 200`, 1 linha única em `presencas` e 1 job reativado como `PENDING` | **PASS** |
| **TC-39-09** | `tests/api.test.js` | Falha simulada no Outbox durante a transação realiza rollback completo | `spyOn(notificacaoService, 'registrarFaltas').mockRejectedValueOnce(...)` em `2026-10-04` | `HTTP 500` e `ROLLBACK` transacional (0 linhas gravadas em `presencas`) | `HTTP 500`, 0 linhas em `presencas` | **PASS** |
| **TC-39-10** | `tests/api.test.js` | Operação não autorizada não altera presença existente nem gera jobs | Aluno tenta alterar sua própria falta de `2026-10-02` para `presente` | `HTTP 403`, mantendo `status = 'falta'` inalterado em `presencas` | `HTTP 403`, registro original preservado | **PASS** |

---

## 10.8 Evidências de Execução

### Comando Executado
```bash
npm --prefix api test -- --coverage
```
*(Que executa `cross-env NODE_ENV=test jest --runInBand --detectOpenHandles --forceExit --coverage` conectado exclusivamente ao banco `gpe_test` validado por `validarBancoDeTeste`.)*

### Saída Consolidada do Jest
```text
PASS tests/requisitosIntegracao.test.js
PASS tests/segurancaAppSec.test.js
PASS tests/api.test.js
PASS tests/whatsappWorker.integration.test.js
PASS tests/emailWorker.integration.test.js
PASS tests/emailUnit.test.js
PASS tests/whatsappUnit.test.js
PASS tests/unitValidadores.test.js
PASS tests/portfolioSchemaUnit.test.js
PASS tests/frequenciaUnit.test.js

Test Suites: 10 passed, 10 total
Tests:       124 passed, 124 total
Snapshots:   0 total
Time:        21.096 s
Ran all test suites.
```

### Cobertura Consolidada Pós-Correções (Backend `api/src`)
- **Global (`All files`):** `63,04%` statements | `54,16%` branches | `62,17%` functions | `64,58%` lines.
- **Destaques:** `presencaRoutes.js` (`70,03%` branches / `67,80%` lines), `auth.js` (`94,73%` lines / `90,00%` branches), `authRoutes.js` (`83,92%` lines / `100%` functions), `notificacaoService.js` (`92,85%` lines), `emailWorker.js` (`89,32%` lines), `portfolioSchema.js` (`84,21%` lines), `emailService.js` (`100%` lines), `validadores.js` (`100%` lines), `resposta.js` (`100%` lines) e `whatsappTemplates.js` (`100%` lines).

### Distribuição de Testes por Suíte Executada
1. `tests/segurancaAppSec.test.js`: **21 testes aprovados** (`SEC-DB-GUARD-01`, `SEC-AUTH-01`..`06`, `SEC-REG-01`..`11`, `SEC-AUTHZ-04`, `SEC-SQLI-01`..`02`).
2. `tests/requisitosIntegracao.test.js`: **27 testes aprovados** (`RF-001` a `RF-006`, RBAC, proteção IDOR em leitura, paginação filtrada por professor e ciclo de Refresh Token/Logout síncrono).
3. `tests/api.test.js`: **16 testes aprovados** (Autenticação, Autorização, `TC-39-01`..`TC-39-10`, chamada por aula/slot com aviso diário e Worker SMTP com Mock).
4. `tests/emailWorker.integration.test.js`: **10 testes aprovados** (Fila MySQL real `SKIP LOCKED`, backoff exponencial, concorrência limitada, recuperação de órfãos e falhas permanentes).
5. `tests/whatsappWorker.integration.test.js`: **3 testes aprovados** (Fluxo completo `PENDING` $\rightarrow$ `SENT` $\rightarrow$ webhook `delivered`/`read`, janela de correção de 15 min com cancelamento `CANCELLED`, e opt-out automático via comando `"SAIR"`).
6. `tests/emailUnit.test.js`: **9 testes aprovados** (Classificação de erros SMTP, sanitização de logs, cálculo de backoff e controle de concorrência).
7. `tests/whatsappUnit.test.js`: **18 testes aprovados** (Normalização E.164, templates WhatsApp, janela de silêncio, HMAC e providers).
8. `tests/unitValidadores.test.js`: **11 testes aprovados** (Validadores de domínio, formato de e-mail, senha, perfis e assinatura/verificação JWT).
9. `tests/frequenciaUnit.test.js`: **6 testes aprovados** (Cálculo de percentual LDB, Bolsa Família, Pé-de-Meia, Conselho Tutelar e Score ABC).
10. `tests/portfolioSchemaUnit.test.js`: **2 testes aprovados** (Restauração de `FOREIGN_KEY_CHECKS` em `garantirSchemaPortfolio` para estados `0` e `1`).
- **Total Geral:** **10 suítes (100% aprovadas) | 124 testes (124 aprovados, 0 falhas) | Tempo total: 21,096 s**.

---

## 10.9 Textos Prontos para o Documento Acadêmico

### SEÇÃO A — Atualização da Seção 24 (Qualidade e Testes)

> **24.X Resolução da Falha TC-39 e Evolução da Cobertura de Testes Automatizados (Fase 03)**
>
> Na auditoria intermediária do projeto, a suíte de testes de integração identificara uma não conformidade funcional no caso de teste **TC-39** (*Idempotência no registro individual de presença*), na qual o envio repetido ou retificador para o endpoint `POST /api/registrar-presenca` ocasionava resposta `HTTP 500 (Internal Server Error)` decorrente de violação da restrição de unicidade `UNIQUE KEY idx_presenca_unica (aluno_id, data, professor_id)` (`ER_DUP_ENTRY`). Naquele estágio, a taxa de aprovação da bateria de validação de requisitos encontrava-se em **97,4% (38/39 casos aprovados)** (e **99,0% — 99/100 testes** no consolidado geral do repositório).
>
> Para sanar definitivamente essa pendência na Entrega Final (Fase 03), os endpoints `POST /api/registrar-presenca` (`api/src/routes/presencaRoutes.js`) e o serviço de mensageria `api/src/services/notificacaoService.js` foram refatorados sob o padrão *Transactional Outbox* com controle explícito de transição de estado e bloqueio pessimista (`SELECT ... FOR UPDATE`). A nova implementação trata de forma determinística e atômica os quatro cenários operacionais do domínio escolar:
>
> 1. **Primeiro registro (`Caso A`):** persiste a presença com proteção `ON DUPLICATE KEY UPDATE` e agenda notificações in-app, por e-mail (`email_jobs`) e por WhatsApp (`whatsapp_jobs`) apenas quando o status registrado é `falta`.
> 2. **Repetição idempotente (`Caso B`):** requisições subsequentes com o mesmo status (`presente` $\rightarrow$ `presente` ou `falta` $\rightarrow$ `falta`) retornam `HTTP 200 OK` (`alterado: false`) sem gerar erro `ER_DUP_ENTRY` e sem duplicar avisos em `notificacoes`, `email_jobs` ou `whatsapp_jobs`.
> 3. **Retificação de falta (`Caso C` — `falta` $\rightarrow$ `presente` ou `justificado`):** atualiza o status do registro preservando a autoria original e invoca `cancelarFaltasCorrigidas()`, que cancela imediatamente os jobs pendentes ainda não despachados (`status = 'FAILED'` em `email_jobs` e `status = 'CANCELLED'` em `whatsapp_jobs`, com registro de auditoria `'Presença corrigida antes do envio'`), mantendo inalterados os jobs cujo envio já tenha sido concluído (`status = 'SENT'`).
> 4. **Reversão para falta no mesmo dia (`Caso D` — `presente`/`justificado` $\rightarrow$ `falta`):** atualiza o registro para `falta` e reativa de forma idempotente os jobs previamente cancelados para `status = 'PENDING'`, respeitando a ordem de avaliação esquerda-para-direita do MySQL e evitando violação das chaves únicas `uq_email_jobs_idempotencia` e `uq_wa_jobs_idempotencia`.
>
> Adicionalmente, foi implementada a guarda programática `validarBancoDeTeste()` (`api/src/config/database.js`), que valida tanto a variável de ambiente `DB_NAME` quanto o schema ativo na conexão MySQL (`SELECT DATABASE()`) antes de qualquer operação de limpeza (`TRUNCATE` ou `DELETE`), garantindo isolamento estrito no banco `gpe_test` e impedindo execuções acidentais contra o banco principal `gpe`.
>
> Com a ampliação da suíte de regressão (`TC-39-01` a `TC-39-10` em `api/tests/api.test.js` e `SEC-REG-01` a `SEC-REG-10` em `api/tests/segurancaAppSec.test.js`), o projeto atingiu **100,0% de aprovação em todas as suítes automatizadas (9 suítes e 118 testes aprovados em 19,24 s, com 0 falhas)**, elevando também a matriz de casos de teste funcionais e de segurança para **100% de conformidade**.

---

### SEÇÃO B — Atualização da Seção 25 (Segurança / AppSec)

> **25.X Mitigação da Vulnerabilidade VULN-01 (BOLA/IDOR) e Endurecimento do Controle de Acesso nos Endpoints de Escrita (Fase 03)**
>
> Durante a auditoria de Segurança de Aplicações (AppSec) conduzida sobre a API REST do GPE, foi identificada e classificada a vulnerabilidade **VULN-01** (*Broken Object Level Authorization — BOLA / OWASP API1:2023*, severidade Alta — CVSS v3.1 8.1) nos endpoints de escrita de frequência `POST /api/registrar-presenca` e `POST /api/registrar-presenca-turma`. Conforme diagnosticado, embora o middleware RBAC (`autorizar('professor', 'gestor')`) restringisse o acesso por perfil, a camada de serviço não validava se o docente autenticado detinha vínculo ativo na tabela associativa `professor_turma` com a turma do estudante alvo, além de aceitar o parâmetro `professor_id` enviado pelo cliente e conter um fallback residual (`SELECT id FROM professores ORDER BY id ASC LIMIT 1`).
>
> Na Fase 03, a vulnerabilidade **VULN-01 foi integralmente corrigida** em `api/src/routes/presencaRoutes.js` por meio de quatro controles de segurança em profundidade (*Defense in Depth*):
>
> 1. **Vinculação Estrita da Identidade ao Token JWT:** para usuários com perfil `professor`, o identificador docente (`professores.id`) passa a ser resolvido exclusivamente a partir da identidade autenticada no token (`req.usuario.id` $\rightarrow$ `professores.usuario_id`). A cláusula de fallback que selecionava arbitrariamente o primeiro professor da tabela foi removida para docentes; caso o usuário autenticado não possua cadastro válido em `professores`, a operação é negada com `HTTP 403 Forbidden`.
> 2. **Prevenção contra Falsificação de Identidade (*Parameter Tampering / Spoofing*):** qualquer tentativa de um professor informar no corpo da requisição um `professor_id` divergente do seu próprio registro autenticado é imediatamente bloqueada com `HTTP 403 Forbidden` antes de qualquer escrita no banco de dados.
> 3. **Validação Transacional de Escopo de Objeto (`professor_turma` e `alunos.turma_id`):** dentro da transação de registro individual ou em lote, o backend bloqueia os registros dos estudantes (`SELECT id, turma_id FROM alunos WHERE id ... FOR UPDATE`), verifica que todos os alunos do lote pertencem à mesma turma alvo e exige a comprovação do vínculo `(professor_id, turma_id)` na tabela `professor_turma` (bem como na `grade_horaria`, quando aplicável). Tentativas de escrita cruzada entre turmas ou infiltração de aluno de outra turma em chamada em lote resultam em `ROLLBACK` integral e resposta `HTTP 403 Forbidden`.
> 4. **Preservação da Governança Administrativa:** usuários autenticados com perfil `gestor` mantêm a prerrogativa de registrar ou retificar presenças em qualquer turma válida da instituição, preservando-se a rastreabilidade do `professor_id` original em caso de retificação administrativa.
>
> A eficácia da mitigação foi comprovada pela suíte dedicada `api/tests/segurancaAppSec.test.js` (**20/20 testes aprovados — 100%**), contemplando os dez cenários obrigatórios de regressão (`SEC-REG-01` a `SEC-REG-10`) com asserções estritas (`expect(res.status).toBe(403)`) e verificação pós-condição no banco de dados confirmando a ausência total de gravações indevidas em `presencas`, `notificacoes`, `email_jobs` e `whatsapp_jobs`.

---

## 10.10 Checklist Final de Verificação

- [x] `VULN-01` corrigida em `POST /api/registrar-presenca`.
- [x] `VULN-01` corrigida em `POST /api/registrar-presenca-turma`.
- [x] Fallback inseguro `SELECT id FROM professores ORDER BY id ASC LIMIT 1` removido para o perfil `professor`.
- [x] Professor autenticado não consegue usar `professor_id` de outro professor no body (`HTTP 403`).
- [x] Professor autenticado não consegue registrar presença em turma não vinculada (`HTTP 403`).
- [x] Professor autenticado não consegue infiltrar aluno de outra turma em chamada em lote (`HTTP 403` com `ROLLBACK` total).
- [x] Gestor continua conseguindo registrar e retificar presença normalmente (`HTTP 200`).
- [x] `TC-39` corrigido sem `HTTP 500` por `ER_DUP_ENTRY`.
- [x] Repetição idêntica de presença individual é idempotente (`HTTP 200`, `alterado: false`, sem duplicar notificações ou jobs).
- [x] Retificação de `falta` para `presente`/`justificado` atualiza o status e cancela notificações pendentes tanto em `email_jobs` quanto em `whatsapp_jobs`, preservando registros `SENT`.
- [x] Alteração de `presente`/`justificado` para `falta` cria ou reativa notificações/jobs pendentes sem violar constraints de unicidade.
- [x] Testes executados exclusivamente em banco de teste (`gpe_test`) protegido pela trava programática `validarBancoDeTeste()`.
- [x] Suíte de segurança (`segurancaAppSec.test.js`) com asserções estritas (`20/20 PASS`).
- [x] Suíte completa de testes (`9 suítes, 118/118 testes`) 100% aprovada.
- [x] Relatório final `RELATORIO_CORRECOES_VULN01_TC39_FASE3.md` gerado no repositório.


