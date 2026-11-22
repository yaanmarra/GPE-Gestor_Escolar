# 🏫 GPE — Gestor de Presença Escolar

[![CI Status](https://github.com/yaanmarra/GPE-Gestor_Escolar/actions/workflows/ci.yml/badge.svg)](https://github.com/yaanmarra/GPE-Gestor_Escolar/actions)
![Node.js Version](https://img.shields.io/badge/Node.js-18%2B%20%7C%2020%2B%20%7C%2022%2B-brightgreen?logo=node.js)
![Express](https://img.shields.io/badge/Express-5.x-black?logo=express)
![MySQL](https://img.shields.io/badge/MySQL-8.0-blue?logo=mysql)
![Jest](https://img.shields.io/badge/Tested%20with-Jest-C21325?logo=jest)
![License](https://img.shields.io/badge/license-ISC-blue)

O **GPE (Gestor de Presença Escolar)** é uma solução web para controle de frequência escolar, gestão de turmas, inteligência preventiva contra evasão e comunicação multicanal (e-mail e WhatsApp) com famílias, projetada com foco em confiabilidade, segurança e arquitetura resiliente.

O sistema conta com um **backend RESTful** em Node.js/Express, persistência relacional em **MySQL 8**, workers assíncronos para notificações via **Transactional Outbox** (`email_jobs` e `whatsapp_jobs`), motor de conformidade legal (LDB 75%, Bolsa Família, Pé-de-Meia 80%, Conselho Tutelar e Score ABC) e interfaces responsivas dedicadas para cada perfil de usuário.

---

## 🎯 Perfis de Usuário & Funcionalidades

| Perfil | Principais Capacidades |
| :--- | :--- |
| 👨‍💼 **Gestor** | Gestão de turmas, alunos, professores, vinculações, visão analítica de frequência e monitoramento da sessão/fila de WhatsApp (QR Code WAHA e jobs). |
| 👨‍🏫 **Professor** | Lançamento e retificação idempotente de chamadas (individual ou em lote) estritamente para suas turmas vinculadas. |
| 👨‍👩‍👧 **Responsável** | Acompanhamento da frequência dos dependentes, alertas de faltas por e-mail/WhatsApp e gestão de consentimento LGPD (*opt-in* / *opt-out*). |
| 🧑‍🎓 **Aluno** | Consulta do próprio histórico de presenças e indicadores de frequência. |

---

## 🏗️ Arquitetura & Destaques de Engenharia

* **Autenticação & Autorização (JWT + RBAC/ABAC)**: Fluxo com par **Access Token** (`15m`) + **Refresh Token** (`7d`), enviado no cabeçalho `Authorization: Bearer <token>` (com renovação automática no frontend via `auth.js`, revogação síncrona no `POST /api/logout` e senhas protegidas por `bcryptjs` custo 12). As rotas de escrita de presença validam o vínculo `professor_turma` e o pertencimento dos alunos à turma em transação atômica. *(Nota de segurança: atualmente o frontend armazena os tokens em `localStorage`; a migração do Refresh Token para cookies `HttpOnly`/`Secure`/`SameSite` com proteção CSRF está registrada no backlog de segurança.)*
* **Transactional Outbox Pattern (E-mail & WhatsApp)**: As notificações de falta são registradas em `email_jobs` e `whatsapp_jobs` dentro da mesma transação MySQL da chamada escolar, garantindo atomicidade e cancelamento automático de avisos pendentes caso o professor retifique a falta antes do envio.
* **Workers Resilientes com `SKIP LOCKED` e Backoff Exponencial**: Processamento concorrente seguro via `SELECT ... FOR UPDATE SKIP LOCKED`, recuperação de jobs órfãos em `PROCESSING`, classificação de erros (`temporario` vs `permanente`), janela de retificação de 15 minutos e horário de silêncio (`21:00–07:00`) no WhatsApp.
* **Adaptadores Multicanal de WhatsApp (Strategy/Adapter)**: Suporte configurável via `WHATSAPP_PROVIDER` para `waha`, `meta`, `evolution` e `fake`, com normalização E.164, mascaramento de telefone em logs e validação criptográfica de webhooks (HMAC SHA-256 / SHA-512) + *opt-out* automático por palavras-chave (`SAIR`, `PARAR`, `STOP`).
* **Motor de Permanência Escolar (`frequenciaService.js`)**: Indicadores de conformidade legal (LDB 75%, Bolsa Família 75%, Pé-de-Meia 80%, gatilho Conselho Tutelar) e Score Explicável ABC expostos em `/api/frequencia/radar` e `/api/frequencia/diagnostico/:aluno_id`.
* **Observabilidade & Hardening HTTP**: Logging estruturado com `pino` (redação automática de segredos), `express-rate-limit`, CORS configurável e healthchecks `/api/health/live` e `/api/health/ready`.
* **Documentação Interativa (OpenAPI 3.0)**: Interface Swagger UI servida em **`/docs`** (`api/swagger.json`).

---

## 📁 Estrutura do Repositório

```text
GPE-Gestor_Escolar/
├── .github/
│   └── workflows/
│       └── ci.yml                               # CI: testes unitários (Node 18/20/22) + integração (MySQL 8.0)
├── README.md                                    # Guia de instalação, 5 scripts SQL, Swagger /docs e testes
├── docs/                                        # Relatórios versionados de qualidade, AppSec, regressão e diagramas
│   ├── RELATORIO_AUDITORIA_QUALIDADE_GPE_FASE2.md
│   ├── RELATORIO_AUDITORIA_SEGURANCA_GPE_FASE2.md
│   ├── RELATORIO_AUDITORIA_GPE_FASE3.md
│   ├── RELATORIO_CORRECOES_VULN01_TC39_FASE3.md
│   └── diagramas/                               # PNGs dos diagramas (Casos de Uso, Classes, DER e Arquitetura)
│       ├── 01_casos_de_uso.png
│       ├── 02_diagrama_classes.png
│       ├── 03_der_banco_dados.png
│       └── 04_arquitetura_sistema.png
├── database/                                    # Esquema consolidado de 24 tabelas MySQL 8.0 InnoDB
│   ├── gpe.sql                                  # 9 tabelas do núcleo operacional
│   ├── migration_entrega1.sql                   # Índices, FKs, refresh_token, turma_id e idx_presenca_unica
│   ├── migration_fase2_email_jobs.sql           # Fila Transactional Outbox de e-mail (email_jobs)
│   ├── migration_entrega4_whatsapp.sql          # whatsapp_jobs, notificacao_preferencias e LGPD em pais
│   └── migration_entrega5_portfolio.sql         # 12 tabelas de portfólio + slot_aula em presencas
├── frontend/                                    # Aplicação web estática por perfil (HTML5/CSS3/JS)
│   ├── index.html                               # Tela de Login
│   ├── gestor.html                              # Painel do Gestor + Monitoramento WhatsApp
│   ├── professor.html                           # Painel Docente e Chamada Rápida
│   ├── pais.html                                # Portal da Família + Preferências LGPD WhatsApp
│   ├── aluno.html                               # Portal do Aluno
│   ├── css/                                     # gpe-shared.css e estilos dedicados por painel
│   └── js/                                      # config.js, auth.js, login.js, gestor.js, professor.js, pais.js, aluno.js
├── api/                                         # Backend REST Node.js / Express 5
│   ├── server.js                                # Ponto de entrada da API Express (Swagger em /docs)
│   ├── swagger.json                             # Especificação OpenAPI 3.0.3 (39 operações HTTP em 34 rotas)
│   ├── package.json
│   ├── .env.example                             # Modelo completo das variáveis de ambiente
│   ├── src/
│   │   ├── config/                              # database.js, jwt.js, emailConfig.js, whatsappConfig.js, portfolioSchema.js
│   │   ├── middlewares/                         # auth.js (JWT/RBAC), errorHandler.js
│   │   ├── routes/                              # auth, usuario, turma, presenca, whatsapp, health (39 ops / 34 rotas)
│   │   ├── services/                            # emailService, notificacaoService, frequenciaService, whatsappTemplates
│   │   ├── providers/whatsapp/                  # wahaProvider, metaCloudProvider, evolutionProvider, fakeProvider, index
│   │   ├── workers/                             # emailWorker.js, whatsappWorker.js (SKIP LOCKED)
│   │   ├── scripts/                             # seedDev.js, seedDemo.js, verVinculos.js e utilitários
│   │   └── utils/                               # validadores, resposta, logger, telefone
│   └── tests/                                   # 10 suítes versionadas (124 testes — 100% aprovados em gpe_test)
│       ├── api.test.js
│       ├── requisitosIntegracao.test.js
│       ├── segurancaAppSec.test.js
│       ├── emailWorker.integration.test.js
│       ├── whatsappWorker.integration.test.js
│       ├── emailUnit.test.js
│       ├── whatsappUnit.test.js
│       ├── unitValidadores.test.js
│       ├── frequenciaUnit.test.js
│       └── portfolioSchemaUnit.test.js
├── .gitattributes
└── .gitignore
```

---

## 🚀 Como Executar Localmente

### Pré-requisitos
* **Node.js** (v18.0.0 ou superior)
* **MySQL Server** (v8.0 ou superior)
* Gerenciador de pacotes **npm**

---

### 1. Clonar o Repositório

```bash
git clone https://github.com/yaanmarra/GPE-Gestor_Escolar.git
cd GPE-Gestor_Escolar
```

---

### 2. Configurar o Banco de Dados MySQL

Crie o banco `gpe` e aplique o esquema base seguido de **todas as migrações na ordem abaixo**:

```bash
mysql -u root -p < database/gpe.sql
mysql -u root -p gpe < database/migration_entrega1.sql
mysql -u root -p gpe < database/migration_fase2_email_jobs.sql
mysql -u root -p gpe < database/migration_entrega4_whatsapp.sql
mysql -u root -p gpe < database/migration_entrega5_portfolio.sql
```

*(Para executar os testes de integração localmente, crie também o banco isolado `gpe_test` e aplique os mesmos scripts substituindo `gpe` por `gpe_test`.)*

---

### 3. Configurar as Variáveis de Ambiente

Acesse a pasta `api/` e copie o arquivo de modelo:

```bash
cd api
cp .env.example .env
```

Edite o arquivo `.env` com suas credenciais locais (veja todas as opções de worker e WhatsApp em [`api/.env.example`](api/.env.example)):

```ini
PORT=3000
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=sua_senha_aqui
DB_NAME=gpe

# Credenciais de envio de e-mail (Gmail App Password)
EMAIL_REMETENTE=seu_email@gmail.com
SENHA_APP=sua_senha_de_aplicativo_16_digitos

# Segredos criptográficos JWT
JWT_SECRET=coloque_aqui_uma_chave_longa_e_segura
JWT_EXPIRES_IN=15m
REFRESH_SECRET=outra_chave_longa_diferente_para_refresh
REFRESH_EXPIRES_IN=7d

CORS_ORIGIN=http://localhost:5500

# WhatsApp (opcional; padrão desabilitado)
WHATSAPP_ENABLED=false
WHATSAPP_PROVIDER=fake
```

---

### 4. Instalar Dependências e Popular Dados Iniciais

Ainda no diretório `api/`:

```bash
# Instala as bibliotecas
npm install

# Popula o banco com usuários iniciais de desenvolvimento
npm run seed

# (Opcional) Popula massa completa de demonstração (turmas, alunos ABC, histórico, etc.)
npm run seed:demo
```

---

### 5. Iniciar o Servidor (e Workers)

```bash
# Modo desenvolvimento (com reinicialização automática)
npm run dev

# Ou modo produção
npm start

# (Opcional) Executar workers em processos separados (com *_WORKER_INLINE=false)
npm run worker
npm run worker:whatsapp
```

* API disponível em: `http://localhost:3000`
* Documentação Swagger disponível em: **`http://localhost:3000/docs`**
* Healthchecks: `http://localhost:3000/api/health/live` e `http://localhost:3000/api/health/ready`

---

### 6. Executar o Frontend

Como o frontend é composto por páginas estáticas (HTML/CSS/JS):
1. Utilize a extensão **Live Server** do VS Code abrindo a pasta `frontend/`, **OU**
2. Inicie um servidor HTTP simples via `npx`:
   ```bash
   npx serve frontend -p 5500
   ```
3. Acesse `http://localhost:5500` no navegador.

---

## 🧪 Testes Automatizados

O projeto possui **10 suítes** (**124 testes** — 46 unitários e 78 de integração, workers e segurança AppSec) com **Jest** e **Supertest**. As suítes de integração operam exclusivamente no banco isolado `gpe_test`, protegido pela trava programática `validarBancoDeTeste()` (que aborta imediatamente caso a conexão aponte para `gpe`).

```bash
# Executa todas as suítes (unitárias + integração + segurança AppSec)
npm test

# Executa com relatório de cobertura
npx jest --coverage --runInBand --detectOpenHandles --forceExit

# Suítes específicas por módulo
npm run test:email
npm run test:whatsapp
npm run test:frequencia
```

Os relatórios técnicos de auditoria e os diagramas arquiteturais estão versionados em [`docs/`](docs/):
* [`RELATORIO_AUDITORIA_QUALIDADE_GPE_FASE2.md`](docs/RELATORIO_AUDITORIA_QUALIDADE_GPE_FASE2.md)
* [`RELATORIO_AUDITORIA_SEGURANCA_GPE_FASE2.md`](docs/RELATORIO_AUDITORIA_SEGURANCA_GPE_FASE2.md)
* [`RELATORIO_AUDITORIA_GPE_FASE3.md`](docs/RELATORIO_AUDITORIA_GPE_FASE3.md)
* [`RELATORIO_CORRECOES_VULN01_TC39_FASE3.md`](docs/RELATORIO_CORRECOES_VULN01_TC39_FASE3.md)
* Diagramas em [`docs/diagramas/`](docs/diagramas/) (Casos de Uso, Classes, DER e Arquitetura)

---

## ⚙️ Integração Contínua (GitHub Actions)

A cada `git push` ou `Pull Request` para `main` ou `master`, o workflow em [`.github/workflows/ci.yml`](.github/workflows/ci.yml) executa automaticamente:

1. **Matriz de Testes Unitários (`test-unit`)**: Executa todas as 5 suítes unitárias puras em Node.js **18**, **20** e **22**.
2. **Testes de Integração & Segurança (`test-integration`)**: Sobe um container oficial do **MySQL 8.0**, aplica os 5 scripts SQL (`gpe.sql`, `migration_entrega1.sql`, `migration_fase2_email_jobs.sql`, `migration_entrega4_whatsapp.sql` e `migration_entrega5_portfolio.sql`), valida a idempotência via `portfolioSchema`, executa `seedDev.js` e roda toda a bateria com `npm test`.

---

## 🤝 Fluxo de Contribuição

1. Crie uma branch descritiva a partir da `main`:
   ```bash
   git checkout -b feat/minha-nova-feature
   ```
2. Realize commits atômicos seguindo **Conventional Commits**:
   ```bash
   git commit -m "fix(presenca): valida vinculo professor-turma-aluno e grava turma_id"
   ```
3. Envie para o GitHub:
   ```bash
   git push origin feat/minha-nova-feature
   ```
4. Abra um **Pull Request** no GitHub para revisão por outro integrante e merge após o CI ficar verde.

---

## 📄 Licença

Este projeto está licenciado sob a licença **ISC**.
