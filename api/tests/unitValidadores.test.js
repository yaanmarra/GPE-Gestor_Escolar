// tests/unitValidadores.test.js — Testes unitários para validadores e funções JWT
const assert = require('node:assert/strict');
const {
  validarEmail,
  validarSenha,
  validarTipo,
  validarCamposObrigatorios,
} = require('../src/utils/validadores');

const {
  gerarAccessToken,
  gerarRefreshToken,
  verificarAccessToken,
  verificarRefreshToken,
} = require('../src/config/jwt');

describe('ETAPA 2 — Testes Unitários: Validadores do Sistema', () => {
  describe('Validação de E-mail (validarEmail)', () => {
    it('deve aceitar e-mails válidos padrão', () => {
      assert.equal(validarEmail('usuario@escola.com.br'), true);
      assert.equal(validarEmail('professor.silva@escola.edu'), true);
      assert.equal(validarEmail('aluno_123@gmail.com'), true);
    });

    it('deve rejeitar e-mails malformados ou inválidos', () => {
      assert.equal(validarEmail('sem-arroba.com'), false);
      assert.equal(validarEmail('@sem-usuario.com'), false);
      assert.equal(validarEmail('usuario@sem-dominio'), false);
      assert.equal(validarEmail(''), false);
      assert.equal(validarEmail(null), false);
      assert.equal(validarEmail(undefined), false);
      assert.equal(validarEmail(12345), false);
    });
  });

  describe('Validação de Senha (validarSenha)', () => {
    it('deve aceitar senhas com 6 ou mais caracteres', () => {
      assert.equal(validarSenha('123456'), true);
      assert.equal(validarSenha('senhaForte@2026'), true);
    });

    it('deve rejeitar senhas com menos de 6 caracteres ou inválidas', () => {
      assert.equal(validarSenha('12345'), false);
      assert.equal(validarSenha('   '), false);
      assert.equal(validarSenha(''), false);
      assert.equal(validarSenha(null), false);
      assert.equal(validarSenha(undefined), false);
    });
  });

  describe('Validação de Tipos de Perfil (validarTipo)', () => {
    it('deve aceitar os 4 perfis permitidos pelo RBAC', () => {
      assert.equal(validarTipo('aluno'), true);
      assert.equal(validarTipo('pai'), true);
      assert.equal(validarTipo('professor'), true);
      assert.equal(validarTipo('gestor'), true);
    });

    it('deve rejeitar papéis não autorizados ou desconhecidos', () => {
      assert.equal(validarTipo('admin'), false);
      assert.equal(validarTipo('coordenador'), false);
      assert.equal(validarTipo('root'), false);
      assert.equal(validarTipo(''), false);
      assert.equal(validarTipo(null), false);
    });
  });

  describe('Validação de Campos Obrigatórios (validarCamposObrigatorios)', () => {
    it('deve validar positivamente quando todos os campos estiverem preenchidos', () => {
      const body = { nome: 'João', email: 'joao@teste.com', senha: 'secret', tipo: 'aluno' };
      const res = validarCamposObrigatorios(['nome', 'email', 'senha', 'tipo'], body);
      assert.equal(res.valido, true);
      assert.equal(res.faltando.length, 0);
    });

    it('deve identificar campos ausentes ou com string vazia', () => {
      const body = { nome: 'João', email: '   ', tipo: null };
      const res = validarCamposObrigatorios(['nome', 'email', 'senha', 'tipo'], body);
      assert.equal(res.valido, false);
      assert.deepEqual(res.faltando, ['email', 'senha', 'tipo']);
    });
  });

  describe('Funções Criptográficas de Token JWT (jwt.js)', () => {
    it('deve gerar e verificar Access Token corretamente com payload preservado', () => {
      const payload = { id: 42, nome: 'Usuário Teste', tipo: 'professor' };
      const token = gerarAccessToken(payload);
      assert.ok(typeof token === 'string' && token.length > 20);

      const decodificado = verificarAccessToken(token);
      assert.equal(decodificado.id, 42);
      assert.equal(decodificado.nome, 'Usuário Teste');
      assert.equal(decodificado.tipo, 'professor');
    });

    it('deve gerar e verificar Refresh Token com payload preservado', () => {
      const payload = { id: 42 };
      const token = gerarRefreshToken(payload);
      assert.ok(typeof token === 'string' && token.length > 20);

      const decodificado = verificarRefreshToken(token);
      assert.equal(decodificado.id, 42);
    });

    it('deve rejeitar tokens forjados ou assinados incorretamente', () => {
      assert.throws(() => {
        verificarAccessToken('token.falso.invalido');
      });
      assert.throws(() => {
        verificarRefreshToken('token.falso.invalido');
      });
    });
  });
});
