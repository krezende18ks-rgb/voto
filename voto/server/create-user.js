const bcrypt = require('bcrypt');
const db = require('./db');

async function main() {
  const [email, password, name, role, matric = null, studentClass = null, course = null] = process.argv.slice(2);
  const allowedRoles = ['voter', 'teacher', 'coordinator', 'rector'];
  if (!email || !email.includes('@') || !password || !name || !allowedRoles.includes(role) || password.length < 8 || (role === 'voter' && (!matric || !studentClass || !course)) || (['teacher','coordinator'].includes(role) && !course)) {
    console.error('Uso: npm run user:create -- email senha nome perfil [matricula] [turma] [curso]');
    console.error('Perfis: voter, teacher, coordinator, rector. A senha deve ter ao menos 8 caracteres.');
    process.exitCode = 1;
    return;
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    await db.query(
      'INSERT INTO users(email,password,name,role,matric,class,course) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [email.trim().toLowerCase(), hash, name.trim(), role, matric, studentClass, course]
    );
    console.log(`Usuário ${email} criado com sucesso.`);
  } catch (error) {
    console.error('Não foi possível criar usuário:', error.code === '23505' ? 'E-mail já cadastrado.' : error.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}
main();
