const db = require('./db');

(async () => {
  try {
    const tables = await db.query(`
      SELECT name, to_regclass('public.' || name) IS NOT NULL AS exists
      FROM (VALUES
        ('ballots'),
        ('voter_participation'),
        ('schema_migrations'),
        ('votes'),
        ('blockchain')
      ) AS t(name)
    `);

    console.log('\n=== TABELAS ===');
    console.table(tables.rows);

    const migrations = await db.query(
      'SELECT version, name, applied_at FROM schema_migrations ORDER BY version'
    );

    console.log('\n=== MIGRACOES ===');
    console.table(migrations.rows);

    const constraints = await db.query(`
      SELECT c.relname AS tabela, con.conname AS restricao,
             con.contype AS tipo
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN (
          'ballots', 'voter_participation', 'users',
          'turmas', 'election_status', 'blockchain'
        )
      ORDER BY c.relname, con.conname
    `);

    console.log('\n=== RESTRICOES ===');
    console.table(constraints.rows);

    const counts = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM votes) AS votos_legados,
        (SELECT COUNT(*) FROM blockchain) AS blocos,
        (SELECT COUNT(*) FROM ballots) AS cedulas,
        (SELECT COUNT(*) FROM voter_participation) AS participacoes
    `);

    console.log('\n=== CONTAGEM DE REGISTROS ===');
    console.table(counts.rows);

    const indexes = await db.query(`
      SELECT tablename, indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN (
          'ballots', 'voter_participation', 'users',
          'candidates', 'blockchain'
        )
      ORDER BY tablename, indexname
    `);

    console.log('\n=== INDICES ===');
    console.table(indexes.rows);

  } catch (error) {
    console.error('Erro na verificacao:', error.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();

