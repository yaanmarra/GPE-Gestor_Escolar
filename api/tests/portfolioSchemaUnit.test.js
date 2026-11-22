const { garantirSchemaPortfolio } = require('../src/config/portfolioSchema');

test.each([0, 1])('restaura a configuração de integridade anterior (%i)', async fk => {
  const db = {
    query: jest.fn(async sql => sql.startsWith('SELECT @@') ? [[{ fk }]] : [[]]),
    release: jest.fn(),
    destroy: jest.fn(),
  };
  await garantirSchemaPortfolio({ getConnection: async () => db });
  expect(db.query).toHaveBeenLastCalledWith('SET SESSION FOREIGN_KEY_CHECKS = ?', [fk]);
  expect(db.release).toHaveBeenCalledTimes(1);
});

test('descarta a conexão quando a restauração falha', async () => {
  const db = {
    query: jest.fn(async sql => {
      if (sql.includes('= ?')) throw new Error('falha simulada');
      return sql.startsWith('SELECT @@') ? [[{ fk: 1 }]] : [[]];
    }),
    release: jest.fn(),
    destroy: jest.fn(),
  };
  await expect(garantirSchemaPortfolio({ getConnection: async () => db })).rejects.toThrow();
  expect(db.destroy).toHaveBeenCalledTimes(1);
  expect(db.release).not.toHaveBeenCalled();
});
