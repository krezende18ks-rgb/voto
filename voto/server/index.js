const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('./db');

const normalizeComparable = (value) => String(value ?? '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .trim()
  .toLocaleLowerCase('pt-BR');

// Tokens HMAC-SHA256 assinados pelo servidor. O perfil nunca é aceito do cliente.
const AUTH_SECRET = process.env.AUTH_SECRET;
if (!AUTH_SECRET || AUTH_SECRET.length < 32) {
  throw new Error('AUTH_SECRET ausente ou fraco. Configure uma chave aleatória com pelo menos 32 caracteres em server/.env.');
}
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}
async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const [body, signature] = token.split('.');
  if (!body || !signature) return res.status(401).json({ error: 'Autenticação necessária.' });
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest();
  let supplied;
  try { supplied = Buffer.from(signature, 'base64url'); } catch { return res.status(401).json({ error: 'Sessão inválida.' }); }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(expected, supplied)) return res.status(401).json({ error: 'Sessão inválida.' });
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.sub || !Number.isFinite(payload.exp) || payload.exp < Math.floor(Date.now() / 1000)) return res.status(401).json({ error: 'Sessão expirada ou inválida.' });
    // Revalida conta e perfil no banco em toda requisição: exclusão/alteração de perfil revoga acesso.
    const account = await db.query('SELECT id,role,class,course FROM users WHERE id=$1 LIMIT 1', [payload.sub]);
    if (!account.rows.length) return res.status(401).json({ error: 'Conta não está mais ativa.' });
    req.auth = { sub: String(account.rows[0].id), role: account.rows[0].role, class: account.rows[0].class, course: account.rows[0].course };
    return next();
  } catch (error) {
    console.error('Falha ao validar sessão:', error.message);
    return res.status(500).json({ error: 'Não foi possível validar a sessão.' });
  }
}

const checkRole = (allowedRoles) => (req, res, next) => {
  if (!req.auth || !allowedRoles.includes(req.auth.role)) return res.status(403).json({ error: 'Você não tem permissão para esta operação.' });
  if (req.auth.role === 'coordinator' && !req.auth.course) return res.status(403).json({ error: 'A conta de coordenador precisa estar vinculada a um curso.' });
  next();
};
const requireCourseScope = (req, res, next) => {
  if (req.auth.role === 'voter' && (!req.auth.class || !req.auth.course)) return res.status(403).json({ error: 'A conta de eleitor precisa estar vinculada a turma e curso.' });
  if (['teacher','coordinator'].includes(req.auth.role) && !req.auth.course) return res.status(403).json({ error: 'Vincule esta conta a um curso antes de consultar esses dados.' });
  next();
};

// Rate limiter simples em memória contra brute-force / spam
const rateLimits = new Map();
const rateLimiter = (windowMs, maxRequests) => (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  if (rateLimits.size > 10000) { for (const [key, value] of rateLimits) if (now > value.resetTime) rateLimits.delete(key); }
  if (!rateLimits.has(ip)) {
    rateLimits.set(ip, { count: 1, resetTime: now + windowMs });
  } else {
    const data = rateLimits.get(ip);
    if (now > data.resetTime) {
      data.count = 1;
      data.resetTime = now + windowMs;
    } else {
      data.count++;
      if (data.count > maxRequests) {
        return res.status(429).json({ error: 'Muitas requisições. Tente novamente mais tarde.' });
      }
    }
  }
  next();
};


async function initializeDatabase() {
  // A estrutura do banco é controlada exclusivamente pelas migrações.
  // Esta função apenas verifica se o esquema necessário existe.

  const requiredTables = [
    'users',
    'candidates',
    'courses',
    'turmas',
    'election_status',
    'ballots',
    'voter_participation',
    'blockchain',
    'schema_migrations',
    'elections',
    'election_candidates',
    'election_ballots',
    'election_participation',
    'election_blockchain',
  ];

  const result = await db.query(`
    SELECT required.name
    FROM unnest($1::text[]) AS required(name)
    WHERE to_regclass('public.' || required.name) IS NULL
  `, [requiredTables]);

  if (result.rows.length > 0) {
    const missing = result.rows.map(row => row.name).join(', ');
    throw new Error(
      `Estrutura incompleta do banco. Tabelas ausentes: ${missing}. Execute as migrações antes de iniciar o servidor.`
    );
  }

  const requiredMigrations = ['001', '002', '003'];

  const migration = await db.query(
    'SELECT version FROM schema_migrations WHERE version = ANY($1::text[])',
    [requiredMigrations]
  );

  const appliedMigrations = new Set(
    migration.rows.map(row => row.version)
  );

  const missingMigrations = requiredMigrations.filter(
    version => !appliedMigrations.has(version)
  );

  if (missingMigrations.length > 0) {
    throw new Error(
      `Migrações ausentes: ${missingMigrations.join(', ')}. Execute as migrações antes de iniciar o servidor.`
    );
  }

  console.log('Estrutura do banco verificada. Migrações 001, 002 e 003 encontradas.');
}

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173').split(',').map(v => v.trim()).filter(Boolean);
app.use(cors({ origin(origin, callback) { if (!origin || allowedOrigins.includes(origin)) return callback(null, true); return callback(new Error('Origem não autorizada pelo CORS.')); }, methods: ['GET', 'POST', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '32kb' }));
// Modo demonstração: permite consultas e login, mas bloqueia alterações.
app.use((req, res, next) => {
  const demoMode = process.env.DEMO_MODE === 'true';
  const writeMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];

  if (
    demoMode &&
    writeMethods.includes(req.method) &&
    req.path !== '/login'
  ) {
    return res.status(403).json({
      error: 'Esta demonstração é somente para consulta. Operações de escrita estão desativadas.',
    });
  }

  next();
});

const distPath = path.join(__dirname, '../votação-dist');
app.use(express.static(distPath));
app.use((req, res, next) => {
  if (req.path === '/login' || req.path === '/health' || req.method === 'OPTIONS') return next();
  return authenticate(req, res, next);
});
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

function calculateHash(block) {
  return crypto.createHash('sha256').update(JSON.stringify(block)).digest('hex');
}

const USER_FIELDS = 'id, email, name, role, matric, class, course';
// ======================================================
// ELEIÇÕES INDEPENDENTES POR TURMA, CURSO E PERÍODO
// ======================================================

const ELECTION_FIELDS = `
  id,
  class,
  course,
  period,
  status,
  created_by AS "createdBy",
  created_at AS "createdAt",
  started_at AS "startedAt",
  ended_at AS "endedAt"
`;

// Lista eleições respeitando o escopo do usuário autenticado.
app.get(
  '/elections',
  checkRole(['voter', 'teacher', 'coordinator', 'rector']),
  requireCourseScope,
  async (req, res) => {
    try {
      let query;
      let params = [];

      if (req.auth.role === 'voter') {
        query = `
          SELECT ${ELECTION_FIELDS}
          FROM elections
          WHERE class = $1
            AND course = $2
            AND status = 'open'
          ORDER BY created_at DESC
        `;
        params = [req.auth.class, req.auth.course];
      } else if (['teacher', 'coordinator'].includes(req.auth.role)) {
        query = `
          SELECT ${ELECTION_FIELDS}
          FROM elections
          WHERE course = $1
          ORDER BY created_at DESC
        `;
        params = [req.auth.course];
      } else {
        query = `
          SELECT ${ELECTION_FIELDS}
          FROM elections
          ORDER BY created_at DESC
        `;
      }

      const result = await db.query(query, params);
      return res.json(result.rows);
    } catch (error) {
      console.error('Erro ao listar eleições:', error.message);
      return res.status(500).json({ error: 'Não foi possível consultar as eleições.' });
    }
  }
);

// Consulta uma eleição específica, sem permitir acesso fora do escopo.
app.get(
  '/elections/:id',
  checkRole(['voter', 'teacher', 'coordinator', 'rector']),
  requireCourseScope,
  async (req, res) => {
    try {
      let query;
      let params;

      if (req.auth.role === 'voter') {
        query = `
          SELECT ${ELECTION_FIELDS}
          FROM elections
          WHERE id = $1
            AND class = $2
            AND course = $3
            AND status = 'open'
          LIMIT 1
        `;
        params = [req.params.id, req.auth.class, req.auth.course];
      } else if (['teacher', 'coordinator'].includes(req.auth.role)) {
        query = `
          SELECT ${ELECTION_FIELDS}
          FROM elections
          WHERE id = $1
            AND course = $2
          LIMIT 1
        `;
        params = [req.params.id, req.auth.course];
      } else {
        query = `
          SELECT ${ELECTION_FIELDS}
          FROM elections
          WHERE id = $1
          LIMIT 1
        `;
        params = [req.params.id];
      }

      const result = await db.query(query, params);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Eleição não encontrada.' });
      }

      return res.json(result.rows[0]);
    } catch (error) {
      console.error('Erro ao consultar eleição:', error.message);
      return res.status(500).json({ error: 'Não foi possível consultar a eleição.' });
    }
  }
);

// Cria uma eleição em estado draft.
// O identificador é sempre gerado pelo servidor.
app.post(
  '/elections',
  checkRole(['coordinator', 'rector']),
  requireCourseScope,
  async (req, res) => {
    try {
      const body = req.body || {};

      const electionClass = typeof body.class === 'string'
        ? body.class.trim()
        : '';

      const course = typeof body.course === 'string'
        ? body.course.trim()
        : '';

      const period = typeof body.period === 'string'
        ? body.period.trim()
        : '';

      if (!electionClass || !course || !period) {
        return res.status(400).json({
          error: 'Informe turma, curso e período da eleição.'
        });
      }

      if (
        electionClass.length > 100 ||
        course.length > 150 ||
        period.length > 50
      ) {
        return res.status(400).json({
          error: 'Turma, curso ou período excede o tamanho permitido.'
        });
      }

      // Coordenador só pode criar eleições no próprio curso.
      if (req.auth.role === 'coordinator' && course !== req.auth.course) {
        return res.status(403).json({
          error: 'Você só pode criar eleições para o seu próprio curso.'
        });
      }

      // Confirma que a turma pertence exatamente ao curso informado.
      const turma = await db.query(
        'SELECT 1 FROM turmas WHERE name = $1 AND course = $2 LIMIT 1',
        [electionClass, course]
      );

      if (turma.rows.length === 0) {
        return res.status(400).json({
          error: 'A turma informada não existe ou não pertence ao curso selecionado.'
        });
      }

      const electionId = `election_${crypto.randomUUID()}`;
      const createdBy = Number(req.auth.sub);

      if (!Number.isSafeInteger(createdBy)) {
        return res.status(401).json({ error: 'Identificação da conta inválida.' });
      }

      const result = await db.query(
        `
          INSERT INTO elections (
            id,
            class,
            course,
            period,
            status,
            created_by
          )
          VALUES ($1, $2, $3, $4, 'draft', $5)
          RETURNING ${ELECTION_FIELDS}
        `,
        [electionId, electionClass, course, period, createdBy]
      );

      return res.status(201).json({
        message: 'Eleição criada com sucesso.',
        election: result.rows[0]
      });
    } catch (error) {
      if (error.code === '23505') {
        return res.status(409).json({
          error: 'Já existe uma eleição para essa turma, curso e período.'
        });
      }

      if (error.code === '23503') {
        return res.status(400).json({
          error: 'Turma, curso ou usuário responsável não possui vínculo válido.'
        });
      }

      console.error('Erro ao criar eleição:', error.message);
      return res.status(500).json({ error: 'Não foi possível criar a eleição.' });
    }
  }
);


// ======================================================

// Inicia uma eleição individual, sem alterar o estado global legado.
app.post(
  '/elections/:id/start',
  checkRole(['coordinator', 'rector']),
  requireCourseScope,
  async (req, res) => {
    const courseScope = req.auth.role === 'coordinator'
      ? req.auth.course
      : null;
    let client;

    try {
      client = await db.connect();
      await client.query('BEGIN');

      const electionResult = await client.query(
        `
          SELECT id, class, course, status
          FROM elections
          WHERE id = $1
            AND ($2::text IS NULL OR course = $2)
          FOR UPDATE
        `,
        [req.params.id, courseScope]
      );

      if (electionResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Eleição não encontrada.' });
      }

      const election = electionResult.rows[0];

      if (election.status === 'open') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Esta eleição já está aberta.' });
      }
      if (election.status === 'closed') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Uma eleição encerrada não pode ser reaberta.' });
      }
      if (election.status !== 'draft') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Status inválido para iniciar a eleição.' });
      }

      // Copia candidatos gerais para o retrato imutável da eleição.
      // A restrição UNIQUE (election_id, matric) evita duplicações.
      const candidatesResult = await client.query(
        `
          SELECT id, name, matric, phone, email, position
          FROM candidates
          WHERE class = $1
            AND course = $2
          ORDER BY position, name, id
        `,
        [election.class, election.course]
      );

      for (const candidate of candidatesResult.rows) {
        await client.query(
          `
            INSERT INTO election_candidates (
              id, election_id, name, matric, phone, email, position
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT DO NOTHING
          `,
          [
            `ec_${crypto.randomUUID()}`,
            election.id,
            candidate.name,
            String(candidate.matric).trim().toUpperCase(),
            candidate.phone || null,
            candidate.email || null,
            candidate.position
          ]
        );
      }

      const countResult = await client.query(
        `
          SELECT
            COUNT(*) FILTER (WHERE position = 'leader')::integer AS leaders,
            COUNT(*) FILTER (WHERE position = 'viceLeader')::integer AS vice_leaders
          FROM election_candidates
          WHERE election_id = $1
        `,
        [election.id]
      );

      if (
        !countResult.rows[0] ||
        countResult.rows[0].leaders < 1 ||
        countResult.rows[0].vice_leaders < 1
      ) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Para iniciar a eleição, cadastre ao menos um candidato a líder e um a vice-líder.'
        });
      }

      const result = await client.query(
        `
          UPDATE elections
          SET status = 'open',
              started_at = COALESCE(started_at, NOW())
          WHERE id = $1
            AND status = 'draft'
          RETURNING ${ELECTION_FIELDS}
        `,
        [election.id]
      );

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Não foi possível iniciar esta eleição.' });
      }

      await client.query('COMMIT');
      return res.json({
        message: 'Eleição iniciada com sucesso.',
        election: result.rows[0]
      });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505') {
        return res.status(409).json({
          error: 'Já existe uma eleição aberta para esta turma e curso.'
        });
      }
      console.error('Erro ao iniciar eleição:', error.message);
      return res.status(500).json({ error: 'Não foi possível iniciar a eleição.' });
    } finally {
      if (client) client.release();
    }
  }
);

// Encerra uma eleição individual, preservando seu histórico.
app.post(
  '/elections/:id/end',
  checkRole(['teacher', 'coordinator', 'rector']),
  requireCourseScope,
  async (req, res) => {
    const courseScope = ['teacher', 'coordinator'].includes(req.auth.role)
      ? req.auth.course
      : null;

    try {
      const result = await db.query(
        `
          UPDATE elections
          SET status = 'closed',
              ended_at = COALESCE(ended_at, NOW())
          WHERE id = $1
            AND status = 'open'
            AND ($2::text IS NULL OR course = $2)
          RETURNING ${ELECTION_FIELDS}
        `,
        [req.params.id, courseScope]
      );

      if (result.rows.length > 0) {
        return res.json({
          message: 'Eleição encerrada com sucesso.',
          election: result.rows[0]
        });
      }

      const current = await db.query(
        `
          SELECT status
          FROM elections
          WHERE id = $1
            AND ($2::text IS NULL OR course = $2)
          LIMIT 1
        `,
        [req.params.id, courseScope]
      );

      if (current.rows.length === 0) {
        return res.status(404).json({
          error: 'Eleição não encontrada.'
        });
      }

      if (current.rows[0].status === 'draft') {
        return res.status(409).json({
          error: 'Inicie a eleição antes de encerrá-la.'
        });
      }

      if (current.rows[0].status === 'closed') {
        return res.status(409).json({
          error: 'Esta eleição já foi encerrada.'
        });
      }

      return res.status(409).json({
        error: 'Não foi possível encerrar esta eleição.'
      });
    } catch (error) {
      console.error('Erro ao encerrar eleição:', error.message);
      return res.status(500).json({
        error: 'Não foi possível encerrar a eleição.'
      });
    }
  }
);

// CANDIDATOS DAS NOVAS ELEIÇÕES
// ======================================================

app.get(
  '/elections/:id/candidates',
  checkRole(['voter', 'teacher', 'coordinator', 'rector']),
  requireCourseScope,
  async (req, res) => {
    try {
      let electionSql;
      let electionParams;

      if (req.auth.role === 'voter') {
        electionSql = `
          SELECT id
          FROM elections
          WHERE id = $1
            AND class = $2
            AND course = $3
            AND status = 'open'
          LIMIT 1
        `;
        electionParams = [
          req.params.id,
          req.auth.class,
          req.auth.course
        ];
      } else if (['teacher', 'coordinator'].includes(req.auth.role)) {
        electionSql = `
          SELECT id
          FROM elections
          WHERE id = $1 AND course = $2
          LIMIT 1
        `;
        electionParams = [req.params.id, req.auth.course];
      } else {
        electionSql = `
          SELECT id FROM elections WHERE id = $1 LIMIT 1
        `;
        electionParams = [req.params.id];
      }

      const election = await db.query(electionSql, electionParams);

      if (election.rows.length === 0) {
        return res.status(404).json({ error: 'Eleição não encontrada.' });
      }

      // Alunos recebem apenas os dados necessários para votar.
      const fields = req.auth.role === 'voter'
        ? 'id, name, position'
        : 'id, name, matric, phone, email, position';

      const result = await db.query(
        `
          SELECT ${fields}
          FROM election_candidates
          WHERE election_id = $1
          ORDER BY position, name
        `,
        [req.params.id]
      );

      return res.json(result.rows);
    } catch (error) {
      console.error('Erro ao consultar candidatos:', error.message);
      return res.status(500).json({
        error: 'Não foi possível consultar os candidatos.'
      });
    }
  }
);

app.post(
  '/elections/:id/candidates',
  checkRole(['coordinator', 'rector']),
  requireCourseScope,
  async (req, res) => {
    try {
      const body = req.body || {};

      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const matric = typeof body.matric === 'string' ? body.matric.trim().toUpperCase() : '';
      const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
      const email = typeof body.email === 'string' ? body.email.trim() : '';
      const position = body.position;

      if (!name || !matric || !['leader', 'viceLeader'].includes(position)) {
        return res.status(400).json({
          error: 'Informe nome, matrícula e um cargo válido.'
        });
      }

      if (
        name.length > 150 ||
        matric.length > 50 ||
        phone.length > 30 ||
        email.length > 254
      ) {
        return res.status(400).json({
          error: 'Um ou mais campos excedem o tamanho permitido.'
        });
      }

      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({
          error: 'Informe um endereço de e-mail válido.'
        });
      }

      const candidateId = `candidate_${crypto.randomUUID()}`;
      const courseScope = req.auth.role === 'coordinator'
        ? req.auth.course
        : null;

      // O bloqueio da eleição protege o cadastro contra abertura concorrente.
      const result = await db.query(
        `
          WITH target AS (
            SELECT id
            FROM elections
            WHERE id = $1
              AND status = 'draft'
              AND ($2::text IS NULL OR course = $2)
            FOR UPDATE
          )
          INSERT INTO election_candidates (
            id, election_id, name, matric, phone, email, position
          )
          SELECT $3, target.id, $4, $5, $6, $7, $8
          FROM target
          RETURNING id, election_id AS "electionId",
                    name, matric, phone, email, position
        `,
        [
          req.params.id,
          courseScope,
          candidateId,
          name,
          matric,
          phone || null,
          email || null,
          position
        ]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Eleição não encontrada, fora do seu curso ou não está em rascunho.'
        });
      }

      return res.status(201).json({
        message: 'Candidato cadastrado com sucesso.',
        candidate: result.rows[0]
      });
    } catch (error) {
      if (error.code === '23505') {
        return res.status(409).json({
          error: 'Já existe um candidato com essa matrícula nesta eleição.'
        });
      }

      if (error.code === '23503') {
        return res.status(400).json({
          error: 'A eleição informada não possui vínculo válido.'
        });
      }

      console.error('Erro ao cadastrar candidato:', error.message);
      return res.status(500).json({
        error: 'Não foi possível cadastrar o candidato.'
      });
    }
  }
);
app.get(
  '/elections/:id/my-participation',
  checkRole(['voter']),
  async (req, res) => {
    try {
      const { rows } = await db.query(
        `SELECT EXISTS (
          SELECT 1
          FROM election_participation ep
          INNER JOIN elections e ON e.id = ep.election_id
          WHERE ep.election_id = $1
            AND ep.voter_id = $2
            AND e.class = $3
            AND e.course = $4
        ) AS voted`,
        [
          req.params.id,
          Number(req.auth.sub),
          req.auth.class,
          req.auth.course
        ]
      );

      res.json(rows[0]);
    } catch (error) {
      console.error('Erro ao consultar participação na eleição:', error.message);
      res.status(500).json({
        error: 'Erro ao consultar situação eleitoral.'
      });
    }
  }
);
app.post(
  '/elections/:id/votes',
  rateLimiter(60000, 20),
  checkRole(['voter']),
  async (req, res) => {
    const { leader, viceLeader } = req.body || {};

    if (
      typeof leader !== 'string' ||
      typeof viceLeader !== 'string' ||
      !leader ||
      !viceLeader ||
      leader === viceLeader
    ) {
      return res.status(400).json({
        error: 'Seleção de candidatos inválida.'
      });
    }

    const client = await db.connect();

    try {
      await client.query('BEGIN');

      // Identifica o eleitor sem associá-lo à cédula.
      const voterResult = await client.query(
        `SELECT id, name, matric, class, course
         FROM users
         WHERE id = $1 AND role = 'voter'
         FOR UPDATE`,
        [Number(req.auth.sub)]
      );

      if (!voterResult.rows.length) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Eleitor inválido.' });
      }

      const voter = voterResult.rows[0];

      if (!voter.matric || !voter.class || !voter.course) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          error: 'Cadastro do eleitor incompleto.'
        });
      }

      // Bloqueia a eleição durante o registro do voto.
      const electionResult = await client.query(
        `SELECT id, class, course, status
         FROM elections
         WHERE id = $1
           AND class = $2
           AND course = $3
           AND status = 'open'
         FOR UPDATE`,
        [req.params.id, voter.class, voter.course]
      );

      if (!electionResult.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          error: 'Eleição não encontrada ou não está aberta para sua turma.'
        });
      }

      // Confirma que os candidatos pertencem à eleição e ocupam os cargos corretos.
      const candidatesResult = await client.query(
        `SELECT id, position
         FROM election_candidates
         WHERE election_id = $1
           AND id IN ($2, $3)`,
        [req.params.id, leader, viceLeader]
      );

      const candidates = candidatesResult.rows;

      if (
        !candidates.some(c => c.id === leader && c.position === 'leader') ||
        !candidates.some(c => c.id === viceLeader && c.position === 'viceLeader')
      ) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Candidatos inválidos para esta eleição.'
        });
      }

      // IDs independentes: não existe vínculo entre cédula e participação.
      const ballotId = `ballot_${crypto.randomUUID()}`;
      const participationId = `participation_${crypto.randomUUID()}`;

      // Cédula anônima: somente eleição e escolhas.
      await client.query(
        `INSERT INTO election_ballots
          (id, election_id, leader_candidate_id, vice_candidate_id)
         VALUES ($1, $2, $3, $4)`,
        [ballotId, req.params.id, leader, viceLeader]
      );

      // Participação identificada, em tabela separada.
      await client.query(
        `INSERT INTO election_participation
          (id, election_id, voter_id, voter_name, voter_matric, voter_class, course)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          participationId,
          req.params.id,
          voter.id,
          voter.name,
          voter.matric,
          voter.class,
          voter.course
        ]
      );

      // Blockchain independente da eleição.
      const last = await client.query(
        `SELECT idx, hash
         FROM election_blockchain
         WHERE election_id = $1
         ORDER BY idx DESC
         LIMIT 1`,
        [req.params.id]
      );

      const idx = Number(last.rows[0]?.idx ?? -1) + 1;
      const previousHash = last.rows[0]?.hash || '0';
      const timestamp = new Date().toISOString();
      const data = { leader, viceLeader };

      const block = { idx, timestamp, data, previousHash };
      const hash = calculateHash(block);

      await client.query(
        `INSERT INTO election_blockchain
          (election_id, idx, timestamp, data, previoushash, hash)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          req.params.id,
          idx,
          timestamp,
          JSON.stringify(data),
          previousHash,
          hash
        ]
      );

      await client.query('COMMIT');

      return res.status(201).json({
        message: 'Voto registrado com sucesso.'
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});

      if (error.code === '23505') {
        return res.status(409).json({
          error: 'Este eleitor já registrou participação nesta eleição.'
        });
      }

      console.error('Erro ao registrar voto por eleição:', error.message);

      return res.status(500).json({
        error: 'Não foi possível registrar o voto.'
      });
    } finally {
      client.release();
    }
  }
);

app.post('/login', rateLimiter(60000, 10), async (req, res) => {
  try {
    const { email, password, role } = req.body || {};
    if (!email || !password || !role) return res.status(400).json({ error: 'Informe email, senha e perfil.' });

    // Busca usuário com a senha para verificar o hash
    const { rows } = await db.query(
      `SELECT ${USER_FIELDS}, password FROM users WHERE lower(email) = lower($1) AND role = $2 LIMIT 1`,
      [String(email).trim(), String(role)]
    );

    if (rows.length === 0 || !(await bcrypt.compare(String(password), rows[0].password))) {
      return res.status(401).json({ error: 'Email, senha ou perfil incorretos.' });
    }

    // Remove a senha antes de retornar
    const user = { ...rows[0] };
    delete user.password;

    const token = signToken({ sub: String(user.id), exp: Math.floor(Date.now() / 1000) + 60 * 60 * 8 });
    res.json({ user, token });
  } catch (err) {
    console.error('Falha no login:', err.message);
    res.status(500).json({ error: 'Não foi possível autenticar.' });
  }
});

// Não retornar hashes de senha ao navegador.
app.get('/users', checkRole(['teacher', 'coordinator', 'rector']), requireCourseScope, async (req, res) => {
  try {
    const sql = ['coordinator','teacher'].includes(req.auth.role) && req.auth.course ? `SELECT ${USER_FIELDS} FROM users WHERE course=$1 ORDER BY name` : `SELECT ${USER_FIELDS} FROM users ORDER BY name`;
    const { rows } = await db.query(sql, ['coordinator','teacher'].includes(req.auth.role) && req.auth.course ? [req.auth.course] : []);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Erro ao consultar usuários.' }); }
});

// --- ROTAS ADMINISTRATIVAS ---
app.post('/users', checkRole(['coordinator', 'rector']), async (req, res) => {
  try {
    const { email, password, name, role, matric, cClass, course } = req.body || {};
    if (typeof email !== 'string' || !email.includes('@') || typeof password !== 'string' || !password || typeof name !== 'string' || !name.trim() || !['voter','teacher','coordinator','rector'].includes(role) || password.length < 8) {
      return res.status(400).json({ error: 'Dados incompletos.' });
    }

    if (role === 'voter' && (!matric || !cClass || !course)) return res.status(400).json({ error: 'Eleitor precisa ter matrícula, turma e curso.' });
    if (['teacher','coordinator'].includes(role) && !course) return res.status(400).json({ error: 'Professor e coordenador precisam estar vinculados a um curso.' });
    if (req.auth.role === 'coordinator' && !['voter','teacher'].includes(role)) return res.status(403).json({ error: 'Coordenador não pode criar esse perfil.' });
    if (req.auth.role === 'coordinator' && String(course || '') !== String(req.auth.course || '')) return res.status(403).json({ error: 'Coordenador só pode cadastrar usuários do próprio curso.' });
    const hashedPassword = await bcrypt.hash(String(password), 12);

    await db.query(
      'INSERT INTO users (email, password, name, role, matric, class, course) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [email.trim().toLowerCase(), hashedPassword, name.trim(), role, matric ? matric.trim() : null, cClass ? cClass.trim() : null, course ? course.trim() : null]
    );
    res.status(201).json({ message: 'Usuário criado com sucesso.' });
  } catch (err) {
    console.error('Falha ao criar usuário:', err);
    res.status(400).json({ error: 'Não foi possível cadastrar o usuário (email já existe?).' });
  }
});

app.delete('/users/:email', checkRole(['coordinator', 'rector']), async (req, res) => {
  try {
    const { email } = req.params;
    const result = await db.query(`DELETE FROM users WHERE lower(email)=lower($1) AND ($2::text IS NULL OR (course=$2 AND role IN ('voter', 'teacher')))`, [email, req.auth.role === 'coordinator' ? req.auth.course : null]);
    if (!result.rowCount) return res.status(404).json({ error: 'Usuário não encontrado neste escopo.' });
    res.json({ deleted: email });
  } catch (err) {
    console.error('Falha ao remover usuário:', err);
    res.status(500).json({ error: 'Não foi possível remover o usuário.' });
  }
});

app.get('/users/by-class/:class', checkRole(['teacher', 'coordinator', 'rector']), requireCourseScope, async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT ${USER_FIELDS} FROM users WHERE class = $1 AND ($2::text IS NULL OR course=$2) ORDER BY name`, [req.params.class, ['coordinator','teacher'].includes(req.auth.role) ? req.auth.course : null]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Erro ao consultar usuários.' }); }
});

const CANDIDATE_FIELDS = 'id, name, matric, phone, email, class, course, position';
app.get('/candidates', checkRole(['voter', 'teacher', 'coordinator', 'rector']), requireCourseScope, async (req, res) => {
  try {
    const sql = req.auth.role === 'voter'
      ? `SELECT id, name, position FROM candidates WHERE class=$1 AND course=$2 ORDER BY class,position,name`
      : ['coordinator','teacher'].includes(req.auth.role) && req.auth.course
        ? `SELECT ${CANDIDATE_FIELDS} FROM candidates WHERE course=$1 ORDER BY class,position,name`
        : `SELECT ${CANDIDATE_FIELDS} FROM candidates ORDER BY class,position,name`;
    const params = req.auth.role === 'voter' ? [req.auth.class, req.auth.course] : ['coordinator','teacher'].includes(req.auth.role) && req.auth.course ? [req.auth.course] : [];
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Erro ao consultar candidatos.' }); }
});
app.get('/candidates/:class', checkRole(['voter', 'teacher', 'coordinator', 'rector']), requireCourseScope, async (req, res) => {
  try {
    if (req.auth.role === 'voter' && (!req.auth.class || !req.auth.course || req.params.class !== req.auth.class)) return res.status(403).json({ error: 'Acesso restrito à sua turma.' });
    let sql = `SELECT ${CANDIDATE_FIELDS} FROM candidates WHERE class=$1 ORDER BY position,name`;
    let params = [req.params.class];
    if (['coordinator','teacher'].includes(req.auth.role)) {
      sql = `SELECT ${CANDIDATE_FIELDS} FROM candidates WHERE class=$1 AND course=$2 ORDER BY position,name`;
      params = [req.params.class, req.auth.course];
    } else if (req.auth.role === 'voter') {
      sql = `SELECT ${CANDIDATE_FIELDS} FROM candidates WHERE (class=$1 AND (course=$2 OR course IS NULL)) OR (course IS NULL AND lower(class)=lower($2)) ORDER BY position,name`;
      params = [req.auth.class, req.auth.course];
    }
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Erro ao consultar candidatos.' }); }
});
app.post('/candidates', checkRole(['teacher', 'coordinator', 'rector']), async (req, res) => {
  try {
    const { id, name, matric, phone = '', email = '', class: cClass, course, position } = req.body || {};

    if (!id || !String(name || '').trim() || !String(matric || '').trim() || !String(cClass || '').trim() || !['leader', 'viceLeader'].includes(position)) {
      return res.status(400).json({ error: 'Dados do candidato inválidos.' });
    }

    const requestedCourse = String(course || '').trim();
    let candidateCourse = requestedCourse;

    if (['teacher', 'coordinator'].includes(req.auth.role)) {
      const ownCourse = String(req.auth.course || '').trim();

      if (!ownCourse) {
        return res.status(403).json({ error: 'Sua conta não está vinculada a um curso.' });
      }

      if (requestedCourse !== ownCourse) {
        return res.status(403).json({ error: 'Você só pode cadastrar candidatos do próprio curso.' });
      }

      candidateCourse = ownCourse;
    }

    if (!candidateCourse) {
      return res.status(400).json({ error: 'Selecione um curso para o candidato.' });
    }

    const turma = await db.query(
      'SELECT 1 FROM turmas WHERE name = $1 AND course = $2 LIMIT 1',
      [String(cClass).trim(), candidateCourse]
    );

    if (turma.rows.length === 0) {
      return res.status(400).json({ error: 'A turma informada não existe ou não pertence ao curso selecionado.' });
    }

    const inserted = await db.query(
      `INSERT INTO candidates
        (id, name, matric, phone, email, class, course, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        id,
        String(name).trim(),
        String(matric).trim().toUpperCase(),
        phone || null,
        email || null,
        String(cClass).trim(),
        candidateCourse,
        position
      ]
    );

    if (inserted.rows.length === 0) {
      return res.status(409).json({
        error: 'Já existe um candidato com essa matrícula nesta turma e curso.'
      });
    }

    return res.status(201).json({ id: inserted.rows[0].id });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'Já existe um candidato com essa matrícula nesta turma e curso.'
      });
    }
    console.error('Erro ao cadastrar candidato:', err.message);
    return res.status(500).json({ error: 'Não foi possível cadastrar o candidato.' });
  }
});

// /votes contém somente a lista de participação; escolhas ficam em /results sem identificação.
app.get('/votes', checkRole(['teacher', 'coordinator', 'rector']), requireCourseScope, async (req, res) => {
  try {
    const params = [];
    let sql = `SELECT id, voter_name AS "voterName", voter_matric AS "voterMatric", voter_class AS "voterClass", course FROM voter_participation ORDER BY timestamp`;
    if (['coordinator','teacher'].includes(req.auth.role) && req.auth.course) { sql = sql.replace(' ORDER BY', ' WHERE course = $1 ORDER BY'); params.push(req.auth.course); }
    const { rows } = await db.query(sql, params); res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Erro ao consultar participação.' }); }
});
app.get('/votes/:class', checkRole(['teacher', 'coordinator', 'rector']), requireCourseScope, async (req, res) => {
  try { const { rows } = await db.query(`SELECT id, voter_name AS "voterName", voter_matric AS "voterMatric", voter_class AS "voterClass", course FROM voter_participation WHERE voter_class=$1 AND ($2::text IS NULL OR course=$2) ORDER BY timestamp`, [req.params.class, ['coordinator','teacher'].includes(req.auth.role) ? req.auth.course : null]); res.json(rows); }
  catch { res.status(500).json({ error: 'Erro ao consultar participação.' }); }
});
app.get('/my-participation', checkRole(['voter']), async (req, res) => {
  try { const { rows } = await db.query('SELECT EXISTS(SELECT 1 FROM voter_participation WHERE voter_id=$1) AS voted', [Number(req.auth.sub)]); res.json(rows[0]); }
  catch { res.status(500).json({ error: 'Erro ao consultar situação eleitoral.' }); }
});
app.get('/results', checkRole(['teacher', 'coordinator', 'rector']), requireCourseScope, async (req, res) => {
  try {
    const scoped = ['coordinator','teacher'].includes(req.auth.role) && req.auth.course;
    const filter = scoped ? 'WHERE course=$1' : '';
    const params = scoped ? [req.auth.course] : [];
    const sql = `
      SELECT 'leader' AS position, leader AS "candidateId", voter_class AS "voterClass", course, COUNT(*)::int AS total
      FROM ballots ${filter} GROUP BY leader, voter_class, course
      UNION ALL
      SELECT 'viceLeader' AS position, vice_leader AS "candidateId", voter_class AS "voterClass", course, COUNT(*)::int AS total
      FROM ballots ${filter} GROUP BY vice_leader, voter_class, course
    `;
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch { res.status(500).json({ error: 'Erro ao consultar apuração.' }); }
});

// Consulta resultados de uma eleição específica, respeitando escopo.
app.get(
  '/elections/:id/results',
  checkRole(['teacher', 'coordinator', 'rector']),
  requireCourseScope,
  async (req, res) => {
    try {
      let electionSql = `
        SELECT id
        FROM elections
        WHERE id = $1
      `;
      const electionParams = [req.params.id];

      if (['teacher', 'coordinator'].includes(req.auth.role)) {
        electionSql += ' AND course = $2';
        electionParams.push(req.auth.course);
      }

      electionSql += ' LIMIT 1';
      const election = await db.query(electionSql, electionParams);

      if (election.rows.length === 0) {
        return res.status(404).json({ error: 'Eleição não encontrada.' });
      }

      const results = await db.query(
        `
        SELECT 'leader' AS position, leader_candidate_id AS "candidateId", COUNT(*)::int AS total
        FROM election_ballots
        WHERE election_id = $1
        GROUP BY leader_candidate_id
        UNION ALL
        SELECT 'viceLeader' AS position, vice_candidate_id AS "candidateId", COUNT(*)::int AS total
        FROM election_ballots
        WHERE election_id = $1
        GROUP BY vice_candidate_id
        `,
        [req.params.id]
      );

      return res.json(results.rows);
    } catch (error) {
      console.error('Erro ao consultar apuração da eleição:', error.message);
      return res.status(500).json({ error: 'Não foi possível consultar a apuração.' });
    }
  }
);

// Fornece dados consolidados para geração da Ata de Eleição.
app.get(
  '/elections/:id/ata-data',
  checkRole(['teacher', 'coordinator', 'rector']),
  requireCourseScope,
  async (req, res) => {
    try {
      const election = await db.query(
        `SELECT id, class, course, period, started_at, ended_at FROM elections WHERE id = $1 AND ($2::text IS NULL OR course = $2) LIMIT 1`,
        [req.params.id, ['coordinator','teacher'].includes(req.auth.role) ? req.auth.course : null]
      );
      if (election.rows.length === 0) return res.status(404).json({ error: 'Eleição não encontrada.' });

      const results = await db.query(
        `SELECT 'leader' AS pos, leader_candidate_id AS cid, COUNT(*)::int AS total FROM election_ballots WHERE election_id = $1 GROUP BY leader_candidate_id
         UNION ALL
         SELECT 'viceLeader' AS pos, vice_candidate_id AS cid, COUNT(*)::int AS total FROM election_ballots WHERE election_id = $1 GROUP BY vice_candidate_id`,
        [req.params.id]
      );

      const participation = await db.query(
        `SELECT voter_name AS name, voter_matric AS matric FROM election_participation WHERE election_id = $1 ORDER BY voter_name`,
        [req.params.id]
      );

      const candidates = await db.query(
        `SELECT id, name, matric, phone, email, position FROM election_candidates WHERE election_id = $1`,
        [req.params.id]
      );

      return res.json({
        election: election.rows[0],
        results: results.rows,
        participation: participation.rows,
        candidates: candidates.rows
      });
    } catch (error) {
      console.error('Erro ao gerar dados da ata:', error.message);
      return res.status(500).json({ error: 'Falha ao gerar dados para a ata.' });
    }
  }
);
app.post('/votes', rateLimiter(60000, 20), checkRole(['voter']), async (req, res) => {
  const { leader, viceLeader } = req.body || {};
  if (typeof leader !== 'string' || typeof viceLeader !== 'string' || !leader || !viceLeader || leader === viceLeader) return res.status(400).json({ error: 'Seleção de candidatos inválida.' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const status = await client.query(`SELECT key,value FROM election_status WHERE key IN ('started','ended') FOR SHARE`);
    const state = Object.fromEntries(status.rows.map(r => [r.key, r.value]));
    if (!state.started || state.ended) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'A votação não está aberta.' }); }
    const voterResult = await client.query("SELECT id,name,matric,class,course FROM users WHERE id=$1 AND role='voter' FOR UPDATE", [Number(req.auth.sub)]);
    if (!voterResult.rows.length) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Eleitor inválido.' }); }
    const voter = voterResult.rows[0];
    const candidatesResult = await client.query('SELECT id,position,class,course FROM candidates WHERE id IN ($1,$2)', [leader, viceLeader]);
    const eligible = candidatesResult.rows.filter(c => {
      const candidateClass = normalizeComparable(c.class);
      const candidateCourse = normalizeComparable(c.course);
      const voterClass = normalizeComparable(voter.class);
      const voterCourse = normalizeComparable(voter.course);
      return candidateCourse ? candidateClass === voterClass && candidateCourse === voterCourse : candidateClass === voterClass || (!!voterCourse && candidateClass === voterCourse);
    });
    if (!eligible.some(c => c.id === leader && c.position === 'leader') || !eligible.some(c => c.id === viceLeader && c.position === 'viceLeader')) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Candidatos não pertencem à turma/curso do eleitor.' }); }
    const ballotId = `ballot_${crypto.randomUUID()}`;
    const attendanceId = `attendance_${crypto.randomUUID()}`;
    const participationTimestamp = new Date().toISOString();
    const ballotTimestamp = new Date(Date.now() + crypto.randomInt(30_000, 180_000)).toISOString();
    await client.query('INSERT INTO ballots(id,leader,vice_leader,voter_class,course,timestamp) VALUES($1,$2,$3,$4,$5,$6)', [ballotId, leader, viceLeader, voter.class, voter.course, ballotTimestamp]);
    await client.query('INSERT INTO voter_participation(id,voter_id,voter_name,voter_matric,voter_class,course,timestamp) VALUES($1,$2,$3,$4,$5,$6,$7)', [attendanceId, voter.id, voter.name, voter.matric, voter.class, voter.course, participationTimestamp]);
    await client.query('SELECT pg_advisory_xact_lock(928374)');
    const last = await client.query('SELECT idx,hash FROM blockchain ORDER BY idx DESC LIMIT 1');
    const previousHash = last.rows[0]?.hash || '0';
    const idx = Number(last.rows[0]?.idx ?? -1) + 1;
    const data = { leader, viceLeader };
    const block = { idx, timestamp: ballotTimestamp, data, previousHash }; block.hash = calculateHash(block);
    await client.query('INSERT INTO blockchain(idx,timestamp,data,previoushash,hash) VALUES($1,$2,$3,$4,$5)', [idx,ballotTimestamp,JSON.stringify(data),previousHash,block.hash]);
    await client.query('COMMIT');
    res.status(201).json({ message: 'Voto registrado. A identidade do eleitor e a cédula são armazenadas separadamente.' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ error: 'Este eleitor já registrou participação.' });
    console.error('Falha ao registrar voto:', err.message); res.status(500).json({ error: 'Não foi possível registrar o voto.' });
  } finally { client.release(); }
});

app.get('/turmas', checkRole(['voter', 'teacher', 'coordinator', 'rector']), requireCourseScope, async (req, res) => {
  try {
    const { course } = req.query;
    let query = 'SELECT name, course FROM turmas ORDER BY course, name';
    let params = [];
    if (['coordinator','teacher'].includes(req.auth.role) && req.auth.course) { query = 'SELECT name, course FROM turmas WHERE course=$1 ORDER BY name'; params = [req.auth.course]; }
    if (course) {
      if (['coordinator','teacher'].includes(req.auth.role) && req.auth.course && course !== req.auth.course) return res.status(403).json({ error: 'Acesso restrito ao seu curso.' });
      query = 'SELECT name, course FROM turmas WHERE course = $1 ORDER BY name';
      params = [course];
    }
    const { rows } = await db.query(query, params);
    res.json(rows);
  }
  catch (err) { res.status(500).json({ error: 'Erro ao consultar turmas.' }); }
});
app.post('/turmas', checkRole(['coordinator', 'rector']), async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const course = String(req.body?.course || '').trim();
    if (!name || !course) return res.status(400).json({ error: 'Informe o nome da turma e o curso.' });
    if (req.auth.role === 'coordinator' && course !== req.auth.course) return res.status(403).json({ error: 'Coordenador só pode cadastrar turmas do próprio curso.' });
    await db.query('INSERT INTO turmas (name, course) VALUES ($1, $2) ON CONFLICT (name, course) DO NOTHING', [name, course]);
    res.status(201).json({ name, course });
  } catch (err) { res.status(400).json({ error: 'Não foi possível cadastrar a turma.' }); }
});
app.delete('/turmas', checkRole(['coordinator', 'rector']), async (req, res) => {
  try {
    const { name, course } = req.query;
    if (!name || !course) return res.status(400).json({ error: 'Informe nome e curso da turma.' });
    if (req.auth.role === 'coordinator' && course !== req.auth.course) return res.status(403).json({ error: 'Acesso restrito ao seu curso.' });
    await db.query('DELETE FROM turmas WHERE name = $1 AND course = $2', [name, course]);
    res.json({ deleted: { name, course } });
  }
  catch (err) { res.status(500).json({ error: 'Não foi possível remover a turma.' }); }
});

app.get('/courses', checkRole(['voter', 'teacher', 'coordinator', 'rector']), requireCourseScope, async (_req, res) => {
  try { const { rows } = await db.query('SELECT name FROM courses ORDER BY name'); res.json(rows.map((r) => r.name)); }
  catch (err) { res.status(500).json({ error: 'Erro ao consultar cursos.' }); }
});
app.post('/courses', checkRole(['rector']), async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Informe o nome do curso.' });
    await db.query('INSERT INTO courses (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
    res.status(201).json({ name });
  } catch (err) {
    console.error('Erro ao cadastrar curso:', err);
    res.status(400).json({ error: 'Não foi possível cadastrar o curso.' });
  }
});
app.delete('/courses/:name', checkRole(['rector']), async (req, res) => {
  try { await db.query('DELETE FROM courses WHERE name = $1', [req.params.name]); res.json({ deleted: req.params.name }); }
  catch (err) { res.status(500).json({ error: 'Não foi possível remover o curso.' }); }
});

app.get('/election-status', checkRole(['voter', 'teacher', 'coordinator', 'rector']), requireCourseScope, async (_req, res) => {
  try {
    const { rows } = await db.query('SELECT key, value, ended_at FROM election_status');
    const status = rows.reduce((acc, row) => {
      acc[row.key] = row.value;
      if (row.key === 'ended') acc.endedAt = row.ended_at;
      return acc;
    }, { endedAt: null });
    res.json(status);
  } catch (err) { res.status(500).json({ error: 'Erro ao consultar status da eleição.' }); }
});

app.post('/election-status', checkRole(['teacher', 'coordinator', 'rector']), requireCourseScope, async (req, res) => {
  const { key, value } = req.body || {};
  if (!['started', 'ended'].includes(key) || typeof value !== 'boolean') return res.status(400).json({ error: 'Dados inválidos.' });
  if (req.auth.role === 'teacher' && (key !== 'ended' || value !== true)) return res.status(403).json({ error: 'Professor só pode encerrar a votação.' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query("SELECT key,value FROM election_status WHERE key IN ('started','ended') FOR UPDATE");
    const state = Object.fromEntries(current.rows.map(r => [r.key, r.value]));
    if (key === 'started' && value && state.ended) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Uma eleição encerrada não pode ser reaberta.' }); }
    if (key === 'started' && value === false && state.started) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Não é permitido reverter o início da eleição.' }); }
    if (key === 'ended' && value === false && state.ended) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Não é permitido reabrir uma eleição encerrada.' }); }
    if (key === 'ended' && value && !state.started) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Inicie a eleição antes de encerrá-la.' }); }
    await client.query(
      `UPDATE election_status
       SET value = $1,
           ended_at = CASE
             WHEN $2 = 'ended' AND $1 = true THEN COALESCE(ended_at, NOW())
             ELSE ended_at
           END
       WHERE key = $2`,
      [value, key]
    );
    await client.query('COMMIT');
    res.json({ key, value });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'Erro ao atualizar status.' });
  } finally { client.release(); }
});

app.get(
  '/elections/:id/blockchain/verify',
  checkRole(['voter', 'teacher', 'coordinator', 'rector']),
  requireCourseScope,
  async (req, res) => {
    try {
      let electionSql = `
        SELECT id
        FROM elections
        WHERE id = $1
      `;
      const params = [req.params.id];

      if (['teacher', 'coordinator'].includes(req.auth.role)) {
        electionSql += ' AND course = $2';
        params.push(req.auth.course);
      }

      if (req.auth.role === 'voter') {
        electionSql += ' AND class = $2 AND course = $3';
        params.push(req.auth.class, req.auth.course);
      }

      electionSql += ' LIMIT 1';

      const election = await db.query(electionSql, params);

      if (!election.rows.length) {
        return res.status(404).json({
          error: 'Eleição não encontrada neste escopo.'
        });
      }

      const { rows } = await db.query(
        `SELECT idx, timestamp, data,
                previoushash AS "previousHash", hash
         FROM election_blockchain
         WHERE election_id = $1
         ORDER BY idx ASC`,
        [req.params.id]
      );

      let isValid = true;
      let errorBlock = null;
      let error = null;

      for (let i = 0; i < rows.length; i++) {
        const block = rows[i];

        if (Number(block.idx) !== i) {
          isValid = false;
          errorBlock = block.idx;
          error = 'Sequência de índices inválida.';
          break;
        }

        const parsedData = typeof block.data === 'string'
          ? JSON.parse(block.data)
          : block.data;

        const timestamp = new Date(block.timestamp).toISOString();

        const blockToHash = {
          idx: Number(block.idx),
          timestamp,
          data: parsedData,
          previousHash: block.previousHash
        };

        const calculatedHash = calculateHash(blockToHash);

        if (calculatedHash !== block.hash) {
          isValid = false;
          errorBlock = block.idx;
          error = 'Hash do bloco inválido.';
          break;
        }

        if (i === 0 && block.previousHash !== '0') {
          isValid = false;
          errorBlock = block.idx;
          error = 'Hash anterior do primeiro bloco inválido.';
          break;
        }

        if (i > 0 && block.previousHash !== rows[i - 1].hash) {
          isValid = false;
          errorBlock = block.idx;
          error = 'Encadeamento de hashes inválido.';
          break;
        }
      }

      return res.json({
        electionId: req.params.id,
        isValid,
        errorBlock,
        error,
        totalBlocks: rows.length
      });
    } catch (err) {
      console.error('Erro ao verificar blockchain da eleição:', err.message);

      return res.status(500).json({
        error: 'Erro ao verificar integridade da blockchain da eleição.'
      });
    }
  }
);


app.get('/blockchain', checkRole(['teacher', 'coordinator', 'rector']), requireCourseScope, async (_req, res) => {
  try {
    const { rows } = await db.query('SELECT idx, previoushash AS "previousHash", hash FROM blockchain ORDER BY idx');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Erro ao consultar a cadeia.' }); }
});

app.get('/blockchain/verify', checkRole(['teacher', 'coordinator', 'rector']), requireCourseScope, async (_req, res) => {
  try {
    const { rows } = await db.query('SELECT idx, timestamp, data, previoushash AS "previousHash", hash FROM blockchain ORDER BY idx');
    let isValid = true;
    let errorBlock = null;

    for (let i = 0; i < rows.length; i++) {
      const block = rows[i];
      if (Number(block.idx) !== i) { isValid = false; errorBlock = block.idx; break; }
      const parsedData = typeof block.data === 'string' ? JSON.parse(block.data) : block.data;

      const blockToHash = {
        idx: Number(block.idx),
        timestamp: block.timestamp,
        data: parsedData,
        previousHash: block.previousHash
      };
      const calculatedHash = crypto.createHash('sha256').update(JSON.stringify(blockToHash)).digest('hex');

      if (calculatedHash !== block.hash) {
        isValid = false;
        errorBlock = block.idx;
        break;
      }

      if (i === 0 && block.previousHash !== '0') {
        isValid = false;
        errorBlock = block.idx;
        break;
      }


      if (i > 0 && block.previousHash !== rows[i - 1].hash) {
        isValid = false;
        errorBlock = block.idx;
        break;
      }
    }

    res.json({ isValid, errorBlock, totalBlocks: rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao verificar integridade da blockchain.' });
  }
});

app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Rota não encontrada.' });
  res.sendFile(path.join(distPath, 'index.html'), (err) => { if (err) next(err); });
});

const PORT = Number(process.env.PORT || 3000);
if (require.main === module) {
  initializeDatabase().then(() => app.listen(PORT, '0.0.0.0', () => console.log(`Servidor disponível na porta ${PORT}`))).catch((err) => { console.error('Falha ao inicializar o banco:', err); process.exit(1); });
}
module.exports = app;
