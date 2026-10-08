# 🏫 GPE — Gestão Pedagógica Escolar

[![CI Status](https://github.com/yaanmarra/Repositorio-GPE/actions/workflows/ci.yml/badge.svg)](https://github.com/yaanmarra/Repositorio-GPE/actions)
![Node.js Version](https://img.shields.io/badge/Node.js-18%2B%20%7C%2020%2B%20%7C%2022%2B-brightgreen?logo=node.js)
![Express](https://img.shields.io/badge/Express-5.x-black?logo=express)
![MySQL](https://img.shields.io/badge/MySQL-8.0-blue?logo=mysql)
![Jest](https://img.shields.io/badge/Tested%20with-Jest-C21325?logo=jest)
![License](https://img.shields.io/badge/license-ISC-blue)

O **GPE (Gestão Pedagógica Escolar)** é uma solução completa de controle de presença escolar, gestão de turmas e comunicação com famílias, projetada com foco em alta confiabilidade, segurança e arquitetura resiliente.

O sistema conta com um **backend RESTful** em Node.js/Express, persistência relacional em **MySQL**, worker assíncrono para notificações via e-mail utilizando o padrão **Transactional Outbox**, e interfaces responsivas dedicadas para cada perfil de usuário.

---

## 🎯 Perfis de Usuário & Funcionalidades

| Perfil | Principais Capacidades |
| :--- | :--- |
| 👨‍💼 **Gestor** | Gestão de turmas, alunos, professores, vinculações e visão analítica de frequência. |
| 👨‍🏫 **Professor** | Lançamento e edição de chamadas/presenças em tempo real para suas turmas atribuídas. |
| 👨‍👩‍👧 **Responsável** | Acompanhamento da frequência dos dependentes com alertas de faltas enviados por e-mail. |
| 🧑‍🎓 **Aluno** | Consulta de histórico de presenças e indicadores de frequência por disciplina. |

---

## 🏗️ Arquitetura & Destaques de Engenharia

* **Autenticação Robusta**: Fluxo seguro via tokens JWT com par Access Token + Refresh Token (cookies `HttpOnly`), mitigando ataques XSS e CSRF.
* **Transactional Outbox Pattern**: As notificações de faltas são registradas na tabela `email_jobs` na mesma transação da presença, garantindo que nenhum e-mail seja perdido caso ocorra falha de rede ou queda do processo.
* **Worker de Fila com Backoff Exponencial & Jitter**: Processamento assíncrono resiliente a falhas temporárias do servidor SMTP, com classificação de erros (`TEMPORARIO` vs `PERMANENTE`) e proteção contra efeito manada (*thundering herd*).
* **Auditoria & Logs Estruturados**: Logging com `pino` e rastreabilidade de requisições.
* **Proteção de Camada HTTP**: Rate limiting via `express-rate-limit`, CORS configurável e sanitização de entradas.
* **Documentação Viva**: Especificação OpenAPI/Swagger interativa em `/api-docs`.

---

## 📁 Estrutura do Repositório

```text
├── .github/
│   └── workflows/
│       └── ci.yml               # Pipeline de CI (Testes unitários + MySQL no GitHub Actions)
├── api/
│   ├── src/
│   │   ├── config/              # Conexão MySQL, JWT e configurações de e-mail
│   │   ├── middlewares/         # Autenticação JWT, controle de perfis (RBAC) e erro global
│   │   ├── routes/              # Rotas REST da API
│   │   ├── services/            # Regras de negócio e disparo de emails
│   │   ├── utils/               # Logger, validadores e padronização de respostas
│   │   └── workers/             # Worker da fila assíncrona de e-mails
│   ├── tests/                   # Suíte de testes Jest & Supertest
│   ├── .env.example             # Modelo das variáveis de ambiente necessárias
│   ├── package.json
│   └── server.js                # Ponto de entrada da API Express
├── database/
│   ├── gpe.sql                  # Dump da estrutura inicial do banco de dados
│   ├── migration_entrega1.sql   # Migração da entrega 1
│   └── migration_fase2_email_jobs.sql # Estrutura da tabela de jobs de e-mail (Outbox)
├── frontend/
│   ├── css/                     # Estilos compartilhados e temas específicos por tela
│   ├── js/                      # Lógica de integração com a API via Fetch
│   ├── aluno.html               # Portal do Aluno
│   ├── gestor.html              # Painel Administrativo do Gestor
│   ├── index.html               # Tela de Login e Boas-Vindas
│   ├── pais.html                # Painel de Acompanhamento dos Pais
│   └── professor.html           # Painel de Lançamento de Presenças
├── .gitignore
└── README.md
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
git clone https://github.com/yaanmarra/Repositorio-GPE.git
cd Repositorio-GPE
```

---

### 2. Configurar o Banco de Dados MySQL

Crie o banco de dados e aplique os esquemas:

```bash
mysql -u root -p < database/gpe.sql
mysql -u root -p gpe < database/migration_fase2_email_jobs.sql
```

---

### 3. Configurar as Variáveis de Ambiente

Acesse a pasta `api/` e copie o arquivo de modelo:

```bash
cd api
cp .env.example .env
```

Edite o arquivo `.env` preenchendo as credenciais locais:

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
```

---

### 4. Instalar Dependências e Popular Dados Iniciais

Ainda no diretório `api/`:

```bash
# Instala as bibliotecas
npm install

# Popula o banco com dados de teste para desenvolvimento
npm run seed
```

---

### 5. Iniciar o Servidor

```bash
# Modo desenvolvimento (com reinicialização automática)
npm run dev

# Ou modo produção
npm start
```

A API estará rodando em: `http://localhost:3000`  
Documentação Swagger disponível em: `http://localhost:3000/api-docs`

---

### 6. Executar o Frontend

Como o frontend é composto por páginas estáticas (HTML/CSS/JS):
1. Utilize a extensão **Live Server** do VS Code abrindo a pasta `frontend/`, **OU**
2. Inicie um servidor HTTP simples via npx:
   ```bash
   npx serve frontend -p 5500
   ```
3. Acesse `http://localhost:5500` no seu navegador.

---

## 🧪 Testes Automatizados

O projeto possui testes unitários e de integração com **Jest** e **Supertest**:

```bash
# Executa todos os testes
npm test

# Executa testes específicos do serviço de e-mail (unitário + worker)
npm run test:email
```

---

## ⚙️ Integração Contínua (GitHub Actions)

A cada `git push` ou `Pull Request` enviado para as branches `main` ou `master`, o workflow do **GitHub Actions** em [`.github/workflows/ci.yml`](.github/workflows/ci.yml) executa automaticamente:

1. **Matriz de Testes Unitários**: Valida o código em Node.js 18, 20 e 22.
2. **Testes de Integração com Banco Real**: Sobe um container oficial do MySQL 8.0, importa o esquema e executa os testes de ponta a ponta da API via Supertest.

---

## 🤝 Fluxo de Contribuição

1. Crie uma branch para a sua funcionalidade:
   ```bash
   git checkout -b feat/minha-nova-feature
   ```
2. Realize os commits utilizando a convenção **Conventional Commits**:
   ```bash
   git commit -m "feat: adiciona validacao de faltas duplicadas"
   ```
3. Envie para o GitHub:
   ```bash
   git push origin feat/minha-nova-feature
   ```
4. Abra um **Pull Request** no GitHub para revisão e merge.

---

## 📄 Licença

Este projeto está licenciado sob a licença **ISC**.
