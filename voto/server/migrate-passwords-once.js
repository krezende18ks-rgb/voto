const db = require('./db');
const bcrypt = require('bcrypt');

async function main() {
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(`
      SELECT id, password
      FROM users
      WHERE password NOT LIKE '$2%'
      ORDER BY id
      FOR UPDATE
    `);

    if (result.rows.length === 0) {
      await client.query('COMMIT');
      console.log('Nenhuma senha antiga precisa ser convertida.');
      return;
    }

    if (result.rows.length !== 5) {
      throw new Error(
        `Esperadas 5 senhas antigas, encontradas ${result.rows.length}. Migração cancelada para inspeção.`
      );
    }

    let converted = 0;

    for (const account of result.rows) {
      const originalPassword = String(account.password);
      const passwordHash = await bcrypt.hash(originalPassword, 12);

      const verified = await bcrypt.compare(originalPassword, passwordHash);

      if (!verified) {
        throw new Error(`Falha na verificação da conversão do usuário ${account.id}.`);
      }

      const update = await client.query(
        'UPDATE users SET password = $1 WHERE id = $2 AND password = $3',
        [passwordHash, account.id, account.password]
      );

      if (update.rowCount !== 1) {
        throw new Error(`Não foi possível atualizar o usuário ${account.id}.`);
      }

      converted++;
    }

    await client.query('COMMIT');
    console.log(`Migração concluída: ${converted} senhas convertidas para bcrypt.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch(error => {
    console.error('Migração cancelada:', error.message);
    process.exitCode = 1;
  })
  .finally(() => db.end());
