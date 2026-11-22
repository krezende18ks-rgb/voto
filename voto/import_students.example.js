// Modelo neutro para importar alunos no PostgreSQL.
// Preencha a lista apenas com dados que você tem autorização para tratar.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
require('dotenv').config({ path: path.join(__dirname, 'server/.env') });
const bcrypt = require('bcrypt');
const db = require('./server/db');

const students = [
  // { name: 'Nome do aluno', matric: 'MATRICULA', email: 'aluno@exemplo.com', password: 'senha-forte', class: 'A', course: 'Engenharia' }
];

async function importStudents() {
  for (const student of students) {
    if (!student.name || !student.matric || !student.email || !student.password || !student.class || !student.course) {
      throw new Error('Cada aluno precisa de nome, matrícula, e-mail, senha, turma e curso.');
    }
    const hashedPassword = await bcrypt.hash(student.password, 12);
    await db.query(
      `INSERT INTO users (name, matric, email, password, role, class, course)
       VALUES ($1, $2, $3, $4, 'voter', $5, $6)
       ON CONFLICT DO UPDATE SET
         name=EXCLUDED.name, matric=EXCLUDED.matric, email=EXCLUDED.email,
         class=EXCLUDED.class, course=EXCLUDED.course, password=EXCLUDED.password`,
      [student.name.trim(), student.matric.trim(), student.email.trim().toLowerCase(), hashedPassword, student.class.trim(), student.course.trim()]
    );
  }
  console.log('Importação concluída.');
}

importStudents()
  .catch((error) => { console.error('Falha na importação:', error.message); process.exitCode = 1; })
  .finally(async () => db.end());
