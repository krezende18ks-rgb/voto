const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.query(schema);
  console.log('Schema PostgreSQL aplicado com sucesso.');
}
main().catch((error) => {
  console.error('Falha ao aplicar schema:', error.message);
  process.exitCode = 1;
}).finally(async () => db.end());
