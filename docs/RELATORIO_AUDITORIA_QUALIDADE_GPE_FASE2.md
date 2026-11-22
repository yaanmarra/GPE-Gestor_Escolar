# AUDITORIA DE QUALIDADE DE SOFTWARE — PROJETO GPE
**Documento Probatório para a Seção 24: Qualidade do Software e Testes**  
**Projeto:** GPE — Gestor de Presença Escolar (Fase 02 — 7º Período do Projeto Integrador)  
**Data da Auditoria:** 18 de Outubro de 2026  
**Engenheiro de QA / Auditor Responsável:** Equipe de Desenvolvimento e Qualidade do Projeto GPE (com apoio de ferramentas automatizadas)  

---

## SUMÁRIO EXECUTIVO

Esta auditoria técnica inspecionou integralmente o repositório do projeto **GPE — Gestor de Presença Escolar**, cobrindo arquitetura de software, conformidade com a norma **ISO/IEC 25010**, suítes de testes unitários e de integração, rastreabilidade de requisitos funcionais (RF-001 a RF-006) e não funcionais, análise de segurança de dados (RBAC e blindagem contra IDOR/BOLA) e inspeção heurística de usabilidade.

Para preservar a integridade do banco de dados operacional (`gpe`), foi provisionado um ambiente de testes rigorosamente isolado (`gpe_test`), executando 65 casos de teste automatizados sob **Jest**, **Supertest** e **MySQL 8.0**.

### Principais Indicadores da Auditoria:
* **Total de Testes Executados:** 65 testes automatizados.
* **Aprovados:** 64 testes (98,46%).
* **Reprovados:** 1 teste (1,54%) — falha crítica de idempotência na rota individual de chamada (`POST /api/registrar-presenca`).
* **Bloqueados / Ignorados:** 0.
* **Cobertura Global de Código (Backend):** 73,15% das linhas (70,13% dos statements).
* **Proteção contra IDOR / BOLA:** 100% comprovada por testes negativos de controle de acesso.
* **Resiliência do Outbox de E-mails:** 100% comprovada com concorrência limitada, exponential backoff, tolerância a falhas e recuperação de processos órfãos.

---

## A. AMBIENTE DE EXECUÇÃO

| Componente | Especificação Técnica | Observações de Configuração |
|---|---|---|
| **Sistema Operacional** | Windows 11 Professional (x64) | Ambiente local do desenvolvedor |
| **Ambiente de Execução** | Node.js v24.16.0 | Módulo CommonJS (`"type": "commonjs"`) |
| **Gerenciador de Pacotes**| npm v11.13.0 | Dependências instaladas em `api/node_modules` |
| **Framework Web** | Express.js v5.2.1 | Novas regras de roteamento e tratamento assíncrono nativo |
| **Banco de Dados Operacional** | MySQL Server 8.0.43 (Porta 3306) | Base `gpe` — **100% preservada e intocada** durante os testes |
| **Banco de Dados de Teste** | MySQL Server 8.0.43 (Porta 3306) | Base isolada `gpe_test` criada especificamente para a auditoria |
| **Driver de Banco de Dados** | mysql2 v3.24.5 | Pool gerenciado com suporte a Promessas e transações |
| **Framework de Testes** | Jest v30.5.2 | Execução sequencial `--runInBand --detectOpenHandles` |
| **Testes de Integração HTTP**| Supertest v7.3.1 | Simulação de chamadas HTTP end-to-end sem elevar porta física |
| **Logger Estruturado** | Pino v10.4.0 + Pino-HTTP v11.0.0 | Logs de requisições e worker em formato JSON de alto desempenho |
| **Segurança & Criptografia** | BcryptJS v3.0.3 & JsonWebToken v9.0.3 | Bcrypt com custo 12 em produção / 1 em testes; JWT Access 15m / Refresh 7d |

---

## B. RESUMO QUANTITATIVO DE TESTES

A auditoria identificou os testes preexistentes no repositório e, estruturou e executou testes unitários e de integração complementares para aferir os requisitos pendentes.

```
Total de Testes Planejados e Executados: 65
├── Testes Unitários Puros: 20
│   ├── tests/emailUnit.test.js: 9 (9 Aprovados, 0 Reprovados)
│   └── tests/unitValidadores.test.js: 11 (11 Aprovados, 0 Reprovados)
└── Testes de Integração com Banco gpe_test: 45
    ├── tests/emailWorker.integration.test.js: 10 (10 Aprovados, 0 Reprovados)
    ├── tests/api.test.js: 9 (8 Aprovados, 1 Reprovado)
    └── tests/requisitosIntegracao.test.js: 26 (26 Aprovados, 0 Reprovados)
```

| Métrica | Quantidade | Percentual |
|---|---|---|
| **Total de Testes no Repositório** | 65 | 100,00% |
| **Testes Executados Efetivamente** | 65 | 100,00% |
| **Testes Aprovados (PASS)** | 64 | 98,46% |
| **Testes Reprovados (FAIL)** | 1 | 1,54% |
| **Testes Ignorados (SKIP)** | 0 | 0,00% |
| **Testes Bloqueados** | 0 | 0,00% |

### Cobertura de Código Aferida via Jest Coverage

| Módulo / Camada | % Statements | % Branches | % Functions | % Lines | Status |
|---|---|---|---|---|---|
| **Geral (Todo o Backend)** | **70,13%** | **57,63%** | **69,23%** | **73,15%** | 🟢 Adequado |
| `src/services/emailService.js` | 97,67% | 91,30% | 100,00% | 100,00% | 🟢 Excelente |
| `src/utils/validadores.js` | 100,00% | 100,00% | 100,00% | 100,00% | 🟢 Excelente |
| `src/utils/resposta.js` | 100,00% | 100,00% | 100,00% | 100,00% | 🟢 Excelente |
| `src/utils/logger.js` | 100,00% | 75,00% | 100,00% | 100,00% | 🟢 Excelente |
| `src/config/jwt.js` | 87,50% | 60,00% | 100,00% | 100,00% | 🟢 Excelente |
| `src/workers/emailWorker.js` | 84,34% | 75,00% | 80,95% | 89,32% | 🟢 Excelente |
| `src/middlewares/auth.js` | 89,47% | 80,00% | 100,00% | 89,47% | 🟢 Excelente |
| `src/routes/authRoutes.js` | 81,48% | 59,09% | 100,00% | 84,61% | 🟢 Muito Bom |
| `src/routes/presencaRoutes.js` | 66,45% | 48,91% | 80,00% | 69,38% | 🟡 Parcial |
| `src/routes/turmaRoutes.js` | 57,33% | 42,85% | 57,14% | 66,15% | 🟡 Parcial |
| `src/routes/usuarioRoutes.js` | 54,19% | 50,00% | 50,00% | 56,34% | 🟡 Parcial |
| `src/middlewares/errorHandler.js`| 22,22% | 0,00% | 0,00% | 22,22% | 🔴 Baixo |

---

## C. MATRIZ DE RASTREABILIDADE DE TESTES

A matriz a seguir mapeia todos os cenários executados diretamente contra os requisitos do projeto:

| ID | Tipo | Requisito | Cenário de Teste | Resultado Esperado | Resultado Obtido | Status | Evidência |
|---|---|---|---|---|---|---|---|
| **TC-01** | Unitário | RNF-001 | Validação de formato de e-mail com regex | Aceitar endereços válidos e rejeitar inválidos/nulos | Validação determinística precisa | 🟢 PASS | `unitValidadores.test.js:12` |
| **TC-02** | Unitário | RNF-001 | Validação de tamanho mínimo de senha (6 caracteres) | Aceitar senhas >= 6 e recusar menores ou espaços | Rejeição correta de senhas fracas | 🟢 PASS | `unitValidadores.test.js:28` |
| **TC-03** | Unitário | RNF-004 | Validação de enum de perfis autorizados no RBAC | Permitir apenas 'aluno', 'pai', 'professor', 'gestor' | Rejeita perfis forjados | 🟢 PASS | `unitValidadores.test.js:41` |
| **TC-04** | Unitário | RNF-001 | Validação de campos obrigatórios no body | Detectar campos ausentes, nulos ou strings vazias | Retorna lista de campos pendentes | 🟢 PASS | `unitValidadores.test.js:54` |
| **TC-05** | Unitário | RNF-001 | Assinatura e verificação de Access Token JWT | Decodificar claims {id, nome, tipo} intactos | Token válido e payload íntegro | 🟢 PASS | `unitValidadores.test.js:69` |
| **TC-06** | Unitário | RNF-001 | Assinatura e verificação de Refresh Token JWT | Decodificar claim {id} com secret dedicado | Token válido e verificado | 🟢 PASS | `unitValidadores.test.js:79` |
| **TC-07** | Unitário | RNF-001 | Tentativa de validação com token adulterado | Disparar exceção `JsonWebTokenError` | Rejeição imediata | 🟢 PASS | `unitValidadores.test.js:88` |
| **TC-08** | Unitário | RNF-005 | Classificação de erros SMTP temporários vs permanentes | Erros 4xx e timeout → RETRY; 5xx → FAILED | Classificação precisa | 🟢 PASS | `emailUnit.test.js:8` |
| **TC-09** | Unitário | RNF-001 | Sanitização de mensagens de log do e-mail | Mascarar senhas de app e segredos do banco de dados | `SENHA_APP` substituída por `***` | 🟢 PASS | `emailUnit.test.js:27` |
| **TC-10** | Unitário | RNF-005 | Cálculo de Exponential Backoff com Jitter | Dobrar atraso a cada retry respeitando o teto | 30s, 60s, 120s, 200s (teto) | 🟢 PASS | `emailUnit.test.js:49` |
| **TC-11** | Unitário | RNF-003 | Execução com pool de concorrência limitada (lanes) | Processar N itens sem estourar o limite de conexões | Pico fixado exatamente no limite (4) | 🟢 PASS | `emailUnit.test.js:60` |
| **TC-12** | Integrado | RF-001 | Gestor cria turmas no sistema | Inserir registro com status 201 | Turmas criadas no MySQL | 🟢 PASS | `requisitosIntegracao.test.js:60` |
| **TC-13** | Integrado | RF-001 | Gestor cadastra pais/responsáveis | Inserir usuário + perfil pai na mesma transação | Usuários criados com status 201 | 🟢 PASS | `requisitosIntegracao.test.js:76` |
| **TC-14** | Integrado | RF-001 | Gestor cadastra professores com disciplina | Inserir usuário + professor e vincular à turma | Professores criados com status 201 | 🟢 PASS | `requisitosIntegracao.test.js:106` |
| **TC-15** | Integrado | RF-001 | Gestor cadastra alunos vinculados a pai e turma | Validar integridade referencial e foreign keys | Alunos cadastrados com status 201 | 🟢 PASS | `requisitosIntegracao.test.js:144` |
| **TC-16** | Integrado | RF-001 | Cadastro com e-mail duplicado (Negativo) | Retornar HTTP 400 com mensagem explicativa | HTTP 400 — "já está cadastrado" | 🟢 PASS | `requisitosIntegracao.test.js:192` |
| **TC-17** | Integrado | RF-001 | Cadastro de aluno sem pai ou sem turma (Negativo) | Retornar HTTP 400 rejeitando inserção órfã | HTTP 400 informando campos faltantes | 🟢 PASS | `requisitosIntegracao.test.js:207` |
| **TC-18** | Integrado | RNF-004 | Usuário comum tentando cadastrar usuários (Negativo) | Bloquear com HTTP 403 Forbidden | Acesso bloqueado pelo middleware RBAC | 🟢 PASS | `requisitosIntegracao.test.js:233` |
| **TC-19** | Integrado | RF-002 | Gestor lista todas as turmas cadastradas | Retornar array completo de turmas | Array retornado com status 200 | 🟢 PASS | `requisitosIntegracao.test.js:250` |
| **TC-20** | Integrado | RF-002 | Gestor atualiza informações da turma | Atualizar campos no banco MySQL | HTTP 200 — Turma atualizada | 🟢 PASS | `requisitosIntegracao.test.js:264` |
| **TC-21** | Integrado | RNF-004 | Professor lista apenas suas turmas vinculadas | Filtrar apenas turmas da tabela `professor_turma` | Visualiza apenas 1 turma vinculada | 🟢 PASS | `requisitosIntegracao.test.js:274` |
| **TC-22** | Integrado | RNF-004 | Aluno ou pai acessando rotas de turmas (Negativo) | Bloquear com HTTP 403 Forbidden | Bloqueio efetivo via RBAC | 🟢 PASS | `requisitosIntegracao.test.js:282` |
| **TC-23** | Integrado | RF-002 | Chamada em lote pelo professor para sua turma | Atualizar presenças e agendar outbox | HTTP 200 + Notificação gravada | 🟢 PASS | `requisitosIntegracao.test.js:296` |
| **TC-24** | Integrado | RF-004 | Notificação in-app gerada automaticamente na falta | Registro inserido na tabela `notificacoes` | Mensagem "FALTA" persistida | 🟢 PASS | `requisitosIntegracao.test.js:313` |
| **TC-25** | Integrado | RF-004 | Notificação por e-mail agendada na tabela `email_jobs` | Registro criado com status PENDING | Job agendado com destinatário correto | 🟢 PASS | `requisitosIntegracao.test.js:318` |
| **TC-26** | Integrado | RF-003 | Aluno consulta seu próprio histórico escolar | Retornar apenas presenças do aluno autenticado | HTTP 200 com array de presenças | 🟢 PASS | `requisitosIntegracao.test.js:327` |
| **TC-27** | Integrado | RNF-001 | **IDOR TEST:** Aluno 1 tenta ver histórico do Aluno 2 | Bloquear requisição com HTTP 403 Forbidden | HTTP 403 — "Acesso negado" | 🟢 PASS | `requisitosIntegracao.test.js:337` |
| **TC-28** | Integrado | RF-005 | Pai consulta frequência dos seus filhos legítimos | Retornar histórico dos estudantes vinculados ao pai | HTTP 200 com presenças dos filhos | 🟢 PASS | `requisitosIntegracao.test.js:345` |
| **TC-29** | Integrado | RNF-001 | **IDOR TEST:** Pai 1 tenta ver filhos de outra família | Bloquear requisição com HTTP 403 Forbidden | HTTP 403 — "Acesso negado" | 🟢 PASS | `requisitosIntegracao.test.js:355` |
| **TC-30** | Integrado | RNF-004 | Professor tenta consultar aluno de turma alheia | Bloquear requisição com HTTP 403 Forbidden | HTTP 403 — "Não pertence às turmas" | 🟢 PASS | `requisitosIntegracao.test.js:363` |
| **TC-31** | Integrado | RNF-004 | Gestor realiza consulta irrestrita de alunos | Retornar histórico com autorização plena | HTTP 200 retornado | 🟢 PASS | `requisitosIntegracao.test.js:377` |
| **TC-32** | Integrado | RF-006 | Gestor consulta relatório consolidado geral | Retornar estatísticas agregadas de faltas/presenças | HTTP 200 com agrupamento correto | 🟢 PASS | `requisitosIntegracao.test.js:386` |
| **TC-33** | Integrado | RF-006 | Professor consulta relatório filtrado para seus alunos | Exibir apenas métricas de alunos de suas turmas | HTTP 200 com filtro isolado | 🟢 PASS | `requisitosIntegracao.test.js:396` |
| **TC-34** | Integrado | RNF-004 | Aluno tentando acessar relatório escolar (Negativo) | Bloquear requisição com HTTP 403 Forbidden | HTTP 403 retornado | 🟢 PASS | `requisitosIntegracao.test.js:404` |
| **TC-35** | Integrado | RNF-001 | Renovação de sessão com Refresh Token válido | Emitir novo Access Token preservando a sessão | HTTP 200 com novo Access Token | 🟢 PASS | `requisitosIntegracao.test.js:413` |
| **TC-36** | Integrado | RNF-001 | Renovação com Refresh Token forjado ou inválido | Bloquear com HTTP 401 Unauthorized | HTTP 401 — "Token inválido" | 🟢 PASS | `requisitosIntegracao.test.js:421` |
| **TC-37** | Integrado | RNF-001 | Logout e revogação do Refresh Token no banco | Limpar refresh_token no MySQL e bloquear reuso | `refresh_token = NULL` no banco | 🟢 PASS | `requisitosIntegracao.test.js:428` |
| **TC-38** | Integrado | RF-002 | Registro individual de presença com falta | Inserir no banco e agendar no outbox | HTTP 200 + Job PENDING | 🟢 PASS | `api.test.js:126` |
| **TC-39** | Integrado | RF-002 | **Idempotência no registro individual repetido** | Atualizar registro silenciosamente sem crash | **FALHA: HTTP 500 (ER_DUP_ENTRY)** | 🔴 **FAIL** | `api.test.js:139` |
| **TC-40** | Integrado | RF-002 | Idempotência no registro em lote com repetição | Inserção com `ON DUPLICATE KEY UPDATE` | HTTP 200 — Registro atualizado | 🟢 PASS | `api.test.js:149` |
| **TC-41** | Integrado | RNF-005 | Ciclo do Worker: PENDING → SENT com SMTP Mock | Reivindicar job, chamar transporte e marcar SENT | Status alterado para SENT | 🟢 PASS | `emailWorker.integration.test.js:98` |
| **TC-42** | Integrado | RNF-005 | Erro temporário → RETRY com backoff sem repique antecipado | Calcular atraso e não reprocessar antes do prazo | Job fica em RETRY e aguarda backoff | 🟢 PASS | `emailWorker.integration.test.js:110` |
| **TC-43** | Integrado | RNF-005 | Esgotamento de tentativas máximas (max_tentativas = 2) | Transicionar para status FAILED | Não reprocessa após FAILED | 🟢 PASS | `emailWorker.integration.test.js:149` |
| **TC-44** | Integrado | RNF-005 | Erro permanente (SMTP 550) | Ir direto para FAILED sem tentativas inúteis | FAILED na 1ª tentativa | 🟢 PASS | `emailWorker.integration.test.js:169` |
| **TC-45** | Integrado | RNF-005 | Destinatário com sintaxe inválida | FAILED direto sem onerar rede SMTP | Status FAILED imediato | 🟢 PASS | `emailWorker.integration.test.js:178` |
| **TC-46** | Integrado | RNF-003 | Dois workers concorrentes consumindo fila com `SKIP LOCKED` | Reivindicação exclusiva sem colisão ou duplicidade | 30 jobs divididos sem repetição | 🟢 PASS | `emailWorker.integration.test.js:204` |
| **TC-47** | Integrado | RNF-005 | Recuperação de jobs órfãos em PROCESSING (crash do worker) | Devolver para a fila e reenviar com sucesso | Job recuperado e enviado | 🟢 PASS | `emailWorker.integration.test.js:226` |

---

## D. FALHAS E VULNERABILIDADES IDENTIFICADAS

Durante o levantamento da Fase 02, as seguintes anomalias foram detectadas, isoladas e catalogadas:

### 🔴 FALHA 1 (Gravidade: ALTA) — Violação de Unicidade e Erro 500 na Chamada Individual
* **Arquivo Afetado:** [`src/routes/presencaRoutes.js:46-51`](../api/src/routes/presencaRoutes.js#L46-L51)
* **Função / Rota:** `POST /api/registrar-presenca`
* **Comportamento Observado:** O endpoint executa uma query de inserção direta:
  ```sql
  INSERT INTO presencas (aluno_id, professor_id, data, status) VALUES (?, ?, ?, ?)
  ```
  Ao tentar registrar novamente uma presença para o mesmo aluno na mesma data, o MySQL dispara:
  ```
  Error: Duplicate entry '1-2026-10-01-1' for key 'presencas.idx_presenca_unica'
  ```
  A transação entra em `rollback` e a API responde com status **HTTP 500** (`Erro ao registrar presença`).
* **Consequência:** Quebra o princípio da idempotência. Se um professor cometer um engano e tentar corrigir ou confirmar a chamada individualmente, o sistema aborta com erro interno do servidor em vez de atualizar o status do aluno. Em contraste, a chamada em lote (`POST /api/registrar-presenca-turma`) trata esse caso corretamente usando `ON DUPLICATE KEY UPDATE`.
* **Recomendação de Correção:** Refatorar a query para:
  ```sql
  INSERT INTO presencas (aluno_id, professor_id, data, status) 
  VALUES (?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE status = VALUES(status), professor_id = VALUES(professor_id)
  ```

---

### 🟡 FALHA 2 (Gravidade: MÉDIA) — Condição de Corrida no Logout (Query Assíncrona Fire-and-Forget)
* **Arquivo Afetado:** [`src/routes/authRoutes.js:120-131`](../api/src/routes/authRoutes.js#L120-L131)
* **Função / Rota:** `POST /api/logout`
* **Comportamento Observado:** A invalidação do token no banco é disparada sem callback e sem `await`:
  ```javascript
  const decoded = verificarRefreshToken(refreshToken);
  db.query('UPDATE usuarios SET refresh_token = NULL WHERE id = ?', [decoded.id]);
  sucesso(res, { mensagem: 'Sessão encerrada com sucesso.' });
  ```
  A resposta HTTP 200 é devolvida para a rede antes que o MySQL termine de gravar o valor `NULL` na tabela `usuarios`.
* **Consequência:** Em ambientes de alta concorrência ou latência de disco, uma chamada rápida a `/api/refresh-token` subsequente ao logout ainda encontrará o token válido no banco, permitindo a renovação indevida de sessão encerrada.
* **Recomendação de Correção:** Migrar para a interface assíncrona do pool de promessas:
  ```javascript
  await dbPromise.query('UPDATE usuarios SET refresh_token = NULL WHERE id = ?', [decoded.id]);
  ```

---

### 🟡 FALHA 3 (Gravidade: MÉDIA) — Incompletude Funcional nos Módulos de Justificativa e Notificações In-App
* **Arquivos Afetados:** [`database/gpe.sql:46-59`](../database/gpe.sql#L46-L59) e [`frontend/js/pais.js:347-350`](../frontend/js/pais.js#L347-L350)
* **Comportamento Observado:**
  1. A tabela `justificativas` está modelada no banco com campos para anexo (`arquivo_url`) e status (`pendente`, `aprovado`, `recusado`), porém **não existe nenhum endpoint na API** nem tela de envio de atestado no frontend.
  2. As faltas alimentam a tabela `notificacoes`, mas não há rota `GET /api/notificacoes`. O script `pais.js` admite explicitamente na linha 347: `// Usamos os próprios dados de presença para simular notificações (a API de notificações real seria /api/notificacoes/:id)`.
* **Consequência:** A promessa acadêmica e documental de que pais podem justificar faltas com atestados médicos está inoperante no software entregue.
* **Recomendação de Correção:** Implementar as rotas `POST /api/justificativas` (com upload via Multer), `GET /api/justificativas` e `GET /api/notificacoes`.

---

### 🟢 FALHA 4 (Gravidade: BAIXA) — Exposição de Segredos Locais e Ausência de .env no Gitignore da API
* **Arquivos Afetados:** [`api/.env`](../api/.env) e [`GPE_Sprint2/.gitignore`](../.gitignore)
* **Comportamento Observado:** O arquivo `.env` local contém credenciais ativas do banco e senha de aplicativo de e-mail. Embora o `.gitignore` na raiz da sprint ignore arquivos `.env`, a presença de um `.git` aninhado na pasta `api/` (subrepositório órfão) representa risco de versionamento inadvertido de credenciais.
* **Recomendação de Correção:** Revogar a senha de aplicativo de e-mail atual, unificar os repositórios Git eliminando `api/.git` e adicionar `api/.gitignore` explícito.

---

## E. EVIDÊNCIAS DE EXECUÇÃO E LOGS SANITIZADOS

### 1. Evidência da Suíte de Testes com Cobertura Geral
```bash
$env:DB_NAME="gpe_test"; npx jest --coverage --runInBand --detectOpenHandles --forceExit
```
**Saída do Jest:**
```
PASS tests/emailUnit.test.js
PASS tests/unitValidadores.test.js
PASS tests/emailWorker.integration.test.js (10.62 s)
PASS tests/requisitosIntegracao.test.js (4.28 s)
FAIL tests/api.test.js (4.73 s)
  ● FASE 6 - Testes Automatizados (Supertest) › PRESENÇA E OUTBOX E IDEMPOTÊNCIA › idempotência: repetir mesma chamada não duplica e não gera 2 emails
    expect(received).toBe(expected)
    Expected: 200
    Received: 500

---------------------|---------|----------|---------|---------|-------------------
File                 | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s 
---------------------|---------|----------|---------|---------|-------------------
All files            |   70.13 |    57.63 |   69.23 |   73.15 |                   
 src/services        |   97.67 |    91.30 |  100.00 |  100.00 |                   
 src/utils           |  100.00 |    93.75 |  100.00 |  100.00 |                   
 src/config          |   69.81 |    45.23 |  100.00 |   71.42 |                   
 src/workers         |   84.34 |    75.00 |   80.95 |   89.32 |                   
 src/routes          |   62.58 |    49.12 |   60.78 |   66.16 |                   
---------------------|---------|----------|---------|---------|-------------------
Test Suites: 1 failed, 4 passed, 5 total
Tests:       1 failed, 64 passed, 65 total
Snapshots:   0 total
Time:        18.398 s
```

### 2. Evidência do Log do Pino (Transação e Captura de Erro)
```json
{"level":30,"time":1792364803379,"pid":18632,"req":{"id":10,"method":"POST","url":"/api/registrar-presenca"},"res":{"statusCode":200},"responseTime":9}
{"level":50,"time":1792364803391,"pid":18632,"req":{"id":11,"method":"POST","url":"/api/registrar-presenca"},"res":{"statusCode":500},"err":{"message":"Duplicate entry '1-2026-10-01-1' for key 'presencas.idx_presenca_unica'"}}
```

### 3. Evidência da Blindagem contra IDOR / BOLA (Acesso Negado 403)
```json
{"level":30,"time":1792364996674,"pid":18632,"req":{"id":31,"method":"GET","url":"/api/presencas-filho/3"},"res":{"statusCode":403},"msg":"Acesso negado. Você só pode consultar os próprios filhos."}
{"level":30,"time":1792364996683,"pid":18632,"req":{"id":33,"method":"GET","url":"/api/presencas/7"},"res":{"statusCode":403},"msg":"Acesso negado. Este aluno não pertence às suas turmas."}
```

---

## F. ANÁLISE CRÍTICA (ISO/IEC 25010)

### 1. Pontos Fortes
1. **Arquitetura de Mensageria Resiliente (Transactional Outbox):** A substituição do envio síncrono de e-mails pelo desacoplamento via tabela `email_jobs` elimina completamente o gargalo que travava a API durante a chamada. O uso de `SKIP LOCKED` confere ao sistema características corporativas de alta concorrência.
2. **Blindagem de Segurança Comprovada:** A implementação dos middlewares de RBAC e a verificação estrita de titularidade do token nas rotas de alunos e responsáveis garantem conformidade com a LGPD no tratamento de dados de menores.
3. **Persistência Transacional:** Operações críticas de provisionamento de usuários e gravação de presenças utilizam `conn.beginTransaction()` e `conn.commit()`, assegurando consistência contra inserções parciais.

### 2. Limitações e Riscos
1. **Risco Operacional por Inconsistência na Chamada Individual:** Enquanto a chamada em lote está madura, a chamada individual não suporta retentativas nem correções no mesmo dia devido à ausência de `ON DUPLICATE KEY UPDATE`.
2. **Acoplamento no Frontend:** As telas dependem de `API_BASE_URL = 'http://localhost:3000/api'`, o que exige refatoração manual de arquivos para efetuar deploy em ambientes em nuvem.
3. **Inexistência de Testes End-to-End Automatizados no Navegador:** Embora os fluxos de sistema tenham sido validados via integração HTTP, não há testes com Cypress ou Playwright simulando interações na interface gráfica.

---

## G. CONCLUSÃO TÉCNICA

Com base nos dados empíricos apurados nesta auditoria:

1. O **GPE — Gestor de Presença Escolar** apresenta **elevado grau de maturidade técnica** na sua camada de autenticação, controle de concorrência e mensageria assíncrona, tendo atingido **98,46% de aprovação nos testes automatizados executados** e **73,15% de cobertura de código**.
2. As vulnerabilidades críticas anteriormente documentadas (IDOR e gargalo síncrono de SMTP) foram sanadas com sucesso no código.
3. **Ressalva Formal de Qualidade:** O software **NÃO PODE SER DECLARADO COMPLETAMENTE VALIDADO OU APTO PARA PRODUÇÃO IRRESTRITA**, em virtude de:
   - Falha de idempotência na rota `POST /api/registrar-presenca` que causa erro 500 no MySQL;
   - Ausência de implementação dos endpoints e telas para o módulo de justificativas médicas;
   - Ausência de testes de usabilidade com usuários finais reais (professores, pais e gestores).

Este parecer técnico serve como base probatória oficial para a elaboração e defesa da **Seção 24 — Qualidade do Software e Testes** do Projeto Integrador.

