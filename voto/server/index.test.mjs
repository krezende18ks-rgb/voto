import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

process.env.AUTH_SECRET = 'test-secret-key-that-is-long-enough-for-unit-tests-123456';
process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/classvote_test';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const SECRET = process.env.AUTH_SECRET;

const users = {
  '1': { id: 1, email: 'aluno@teste.com', name: 'Aluno Teste', matric: 'MAT-ALUNO-001', role: 'voter', class: 'A', course: 'Engenharia' },
  '2': { id: 2, email: 'professor@teste.com', name: 'Professor Teste', matric: null, role: 'teacher', class: null, course: 'Engenharia' },
  '3': { id: 3, email: 'coordenador@teste.com', name: 'Coordenador Teste', matric: null, role: 'coordinator', class: null, course: 'Engenharia' },
  '4': { id: 4, email: 'reitor@teste.com', name: 'Reitor Teste', matric: null, role: 'rector', class: null, course: null },
  '5': { id: 5, email: 'aluno2@teste.com', name: 'Aluno Computação', matric: 'MAT-ALUNO-005', role: 'voter', class: 'B', course: 'Computação' },
  '6': { id: 6, email: 'coordenador2@teste.com', name: 'Segundo Coordenador', matric: null, role: 'coordinator', class: null, course: 'Engenharia' },
};

const state = {
  queries: [],
  validTurma: true,
  duplicate: false,
  elections: [],
  insertedElection: null,
  candidateDuplicate: false,
  candidates: [],
  ballots: [],
  participation: [],
  electionBlockchain: [],
};

const mockDb = {
  query: async (sql, params = []) => {
    state.queries.push({ sql, params });

    // Nova votação: consulta do eleitor.
    if (/SELECT id, name, matric, class, course\s+FROM users/i.test(sql)) {
      const user = users[String(params[0])];
      return {
        rows: user && user.role === 'voter' ? [{
          id: user.id,
          name: user.name,
          matric: user.matric,
          class: user.class,
          course: user.course,
        }] : [],
        rowCount: user && user.role === 'voter' ? 1 : 0,
      };
    }

    // Nova votação: eleição aberta da turma e curso.
    if (
      /SELECT id, class, course, status\s+FROM elections/i.test(sql) &&
      !/FOR UPDATE/i.test(sql)
    ) {
      const election = state.elections.find(row =>
        row.id === params[0] &&
        row.class === params[1] &&
        row.course === params[2] &&
        row.status === 'open'
      );
      return {
        rows: election ? [election] : [],
        rowCount: election ? 1 : 0,
      };
    }

    // Nova votação: candidatos e respectivos cargos.
    if (/SELECT id, position\s+FROM election_candidates/i.test(sql)) {
      const rows = state.candidates
        .filter(row =>
          row.election_id === params[0] &&
          [params[1], params[2]].includes(row.id)
        )
        .map(row => ({ id: row.id, position: row.position }));

      return { rows, rowCount: rows.length };
    }

    // Nova votação: gravação da cédula anônima.
    if (/INSERT INTO election_ballots/i.test(sql)) {
      const [id, election_id, leader_candidate_id, vice_candidate_id] = params;

      state.ballots.push({
        id,
        election_id,
        leader_candidate_id,
        vice_candidate_id,
      });

      return { rows: [], rowCount: 1 };
    }

    // Nova votação: participação identificada.
    if (/INSERT INTO election_participation/i.test(sql)) {
      const [
        id, election_id, voter_id, voter_name,
        voter_matric, voter_class, course
      ] = params;

      const duplicate = state.participation.some(row =>
        row.election_id === election_id &&
        (row.voter_id === voter_id || row.voter_matric === voter_matric)
      );

      if (duplicate) {
        const error = new Error('duplicate participation');
        error.code = '23505';
        throw error;
      }

      state.participation.push({
        id,
        election_id,
        voter_id,
        voter_name,
        voter_matric,
        voter_class,
        course,
      });

      return { rows: [], rowCount: 1 };
    }

    // Nova votação: consulta da blockchain completa para verificação.
    if (/FROM election_blockchain/i.test(sql) && /ORDER BY idx ASC/i.test(sql)) {
      const rows = state.electionBlockchain
        .filter(row => row.election_id === params[0])
        .sort((a, b) => a.idx - b.idx)
        .map(row => ({
          idx: row.idx,
          timestamp: row.timestamp,
          data: row.data,
          previousHash: row.previoushash,
          hash: row.hash,
        }));

      return { rows, rowCount: rows.length };
    }

    // Nova votação: consulta da última entrada da blockchain.
    if (/SELECT idx, hash\s+FROM election_blockchain/i.test(sql)) {
      const rows = state.electionBlockchain
        .filter(row => row.election_id === params[0])
        .sort((a, b) => b.idx - a.idx);

      return {
        rows: rows.length ? [{ idx: rows[0].idx, hash: rows[0].hash }] : [],
        rowCount: rows.length ? 1 : 0,
      };
    }

    // Nova votação: gravação da blockchain independente.
    if (/INSERT INTO election_blockchain/i.test(sql)) {
      if (state.failBlockchainInsert) {
        const error = new Error('Falha simulada na blockchain');
        error.code = 'TEST_BLOCKCHAIN_FAILURE';
        throw error;
      }
      const [election_id, idx, timestamp, data, previoushash, hash] = params;

      state.electionBlockchain.push({
        election_id,
        idx,
        timestamp,
        data: typeof data === 'string' ? JSON.parse(data) : data,
        previoushash,
        hash,
      });

      return { rows: [], rowCount: 1 };
    }


    if (/DELETE FROM users/i.test(sql)) {
      const [email, courseScope] = params;
      const target = Object.values(users).find(user =>
        user.email.toLowerCase() === String(email).toLowerCase()
      );

      const roleRestricted = /role\s+IN\s*\(\s*'voter'\s*,\s*'teacher'\s*\)/i.test(sql);

      const allowed = target && (
        courseScope === null ||
        (
          target.course === courseScope &&
          roleRestricted &&
          ['voter', 'teacher'].includes(target.role)
        )
      );

      return { rows: [], rowCount: allowed ? 1 : 0 };
    }
    if (/SELECT id,role,class,course FROM users WHERE id=\$1 LIMIT 1/i.test(sql)) {
      const user = users[String(params[0])];
      return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
    }

    if (/SELECT 1 FROM turmas WHERE name = \$1 AND course = \$2/i.test(sql)) {
      const rows = state.validTurma ? [{ '?column?': 1 }] : [];
      return { rows, rowCount: rows.length };
    }

    if (
      /FROM candidates/i.test(sql) &&
      /SELECT id, name, matric, phone, email, position/i.test(sql)
    ) {
      const rows = state.candidates
        .filter(row =>
          !row.election_id &&
          row.class === params[0] &&
          row.course === params[1]
        )
        .map(({ id, name, matric, phone, email, position }) => ({
          id, name, matric, phone, email, position
        }));
      return { rows, rowCount: rows.length };
    }

    if (/INSERT INTO candidates/i.test(sql)) {
      const [id, name, matric, phone, email, candidateClass, course, position] = params;
      const duplicate = state.candidates.some(row =>
        !row.election_id &&
        row.class === candidateClass &&
        row.course === course &&
        String(row.matric).trim().toLowerCase() === String(matric).trim().toLowerCase()
      );
      if (duplicate) {
        if (/ON CONFLICT DO NOTHING/i.test(sql)) {
          return { rows: [], rowCount: 0 };
        }
        const error = new Error('duplicate candidate');
        error.code = '23505';
        throw error;
      }

      const candidate = {
        id,
        name,
        matric,
        phone,
        email,
        class: candidateClass,
        course,
        position,
      };

      state.candidates.push(candidate);
      return { rows: [candidate], rowCount: 1 };
    }

    if (/INSERT INTO elections/i.test(sql)) {
      if (state.duplicate) {
        const error = new Error('duplicate key');
        error.code = '23505';
        throw error;
      }

      return {
        rows: state.insertedElection ? [state.insertedElection] : [],
        rowCount: 1,
      };
    }

    if (/INSERT INTO election_candidates/i.test(sql)) {
      let electionId, courseScope, candidateId, name, matric, phone, email, position;

      if (params.length === 7) {
        [candidateId, electionId, name, matric, phone, email, position] = params;
      } else {
        [electionId, courseScope, candidateId, name, matric, phone, email, position] = params;
      }

      const election = state.elections.find(row =>
        row.id === electionId &&
        row.status === 'draft' &&
        (!courseScope || row.course === courseScope)
      );

      if (!election) return { rows: [], rowCount: 0 };

      if (state.candidateDuplicate || state.candidates.some(row =>
        row.election_id === electionId &&
        String(row.matric).trim().toLowerCase() === String(matric).trim().toLowerCase()
      )) {
        if (/ON CONFLICT/i.test(sql)) return { rows: [], rowCount: 0 };
        const error = new Error('duplicate key');
        error.code = '23505';
        throw error;
      }

      const candidate = {
        id: candidateId,
        electionId,
        election_id: electionId,
        name,
        matric,
        phone,
        email,
        position,
      };
      state.candidates.push(candidate);
      return { rows: [candidate], rowCount: 1 };
    }

    if (/COUNT\(\*\) FILTER \(WHERE position = 'leader'\)/i.test(sql)) {
      const rows = state.candidates.filter(row => row.election_id === params[0]);
      return {
        rows: [{
          leaders: rows.filter(row => row.position === 'leader').length,
          vice_leaders: rows.filter(row => row.position === 'viceLeader').length,
        }],
        rowCount: 1,
      };
    }

    if (/FROM election_candidates/i.test(sql)) {
      const electionId = params[0];
      const rows = state.candidates
        .filter(row => row.election_id === electionId)
        .map(row => {
          if (/SELECT id, name, position/i.test(sql)) {
            return {
              id: row.id,
              name: row.name,
              position: row.position,
            };
          }

          return {
            id: row.id,
            name: row.name,
            matric: row.matric,
            phone: row.phone,
            email: row.email,
            position: row.position,
          };
        });

      return { rows, rowCount: rows.length };
    }
    if (/UPDATE elections/i.test(sql)) {
      const [electionId, courseScope] = params;
      const election = state.elections.find(row =>
        row.id === electionId &&
        (!courseScope || row.course === courseScope)
      );

      const starting = /SET status = 'open'/i.test(sql);
      const ending = /SET status = 'closed'/i.test(sql);
      const expectedStatus = starting ? 'draft' : 'open';

      if (!election || election.status !== expectedStatus) {
        return { rows: [], rowCount: 0 };
      }

      if (starting) {
        const conflict = state.elections.some(row =>
          row.id !== election.id &&
          row.class === election.class &&
          row.course === election.course &&
          row.status === 'open'
        );

        if (conflict) {
          const error = new Error('duplicate key');
          error.code = '23505';
          throw error;
        }

        election.status = 'open';
        election.startedAt = election.startedAt || '2026-11-22T12:00:00.000Z';
      } else if (ending) {
        election.status = 'closed';
        election.endedAt = election.endedAt || '2026-11-22T13:00:00.000Z';
      } else {
        throw new Error('UPDATE elections não reconhecido pelo mock.');
      }

      return {
        rows: [{
          ...election,
          createdBy: election.createdBy ?? 3,
          createdAt: election.createdAt ?? null,
        }],
        rowCount: 1,
      };
    }
    if (/FROM elections/i.test(sql)) {
      let rows = [...state.elections];

      if (/WHERE id = \$1/i.test(sql)) {
        rows = rows.filter(row => row.id === params[0]);

        if (/class = \$2/i.test(sql)) {
          rows = rows.filter(row => row.class === params[1]);
        }

        if (/course = \$3/i.test(sql)) {
          rows = rows.filter(row => row.course === params[2]);
        } else if (/course = \$2/i.test(sql) && params[1] != null) {
          rows = rows.filter(row => row.course === params[1]);
        }
      } else if (/class = \$1/i.test(sql) && /course = \$2/i.test(sql)) {
        rows = rows.filter(row =>
          row.class === params[0] && row.course === params[1]
        );
      } else if (/course = \$1/i.test(sql)) {
        rows = rows.filter(row => row.course === params[0]);
      }

      if (/status = 'open'/i.test(sql)) {
        rows = rows.filter(row => row.status === 'open');
      }

      return { rows, rowCount: rows.length };
    }

    throw new Error(`Consulta não prevista no mock: ${sql}`);
  },

  connect: async () => {
    let snapshot = null;

    return {
      query: async (sql, params = []) => {
        if (/^\s*BEGIN\s*$/i.test(sql)) {
          snapshot = {
            elections: structuredClone(state.elections),
            candidates: structuredClone(state.candidates),
            ballots: structuredClone(state.ballots),
            participation: structuredClone(state.participation),
            electionBlockchain: structuredClone(state.electionBlockchain),
          };
          return { rows: [], rowCount: null };
        }

        if (/^\s*COMMIT\s*$/i.test(sql)) {
          snapshot = null;
          return { rows: [], rowCount: null };
        }

        if (/^\s*ROLLBACK\s*$/i.test(sql)) {
          if (snapshot) {
            state.elections = snapshot.elections;
            state.candidates = snapshot.candidates;
            state.ballots = snapshot.ballots;
            state.participation = snapshot.participation;
            state.electionBlockchain = snapshot.electionBlockchain;
            snapshot = null;
          }
          return { rows: [], rowCount: null };
        }

        return mockDb.query(sql, params);
      },
      release: () => {},
    };
  },

  end: async () => {},
};

const dbPath = require.resolve('./db.js');
const mockModule = new Module(dbPath);
mockModule.filename = dbPath;
mockModule.loaded = true;
mockModule.exports = mockDb;
require.cache[dbPath] = mockModule;

const app = require('./index.js');

function tokenFor(userId) {
  const body = Buffer.from(JSON.stringify({
    sub: String(userId),
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');

  const signature = crypto
    .createHmac('sha256', SECRET)
    .update(body)
    .digest('base64url');

  return `${body}.${signature}`;
}

function auth(userId) {
  return { Authorization: `Bearer ${tokenFor(userId)}` };
}

beforeEach(() => {
  state.queries = [];
  state.ballots = [];
  state.participation = [];
  state.electionBlockchain = [];
  state.validTurma = true;
  state.duplicate = false;
  state.failBlockchainInsert = false;
  state.elections = [
    {
      id: 'election_test_1',
      class: 'A',
      course: 'Engenharia',
      period: '2026.2',
      status: 'open',
    },
  ];

  state.candidateDuplicate = false;
  state.candidates = [
    {
      id: 'candidate_test_1',
      election_id: 'election_test_1',
      name: 'Candidato de Teste',
      matric: 'MAT-001',
      phone: '91999999999',
      email: 'candidato@example.com',
      position: 'leader',
    },
    {
      id: 'candidate_test_vice',
      election_id: 'election_test_1',
      name: 'Candidato a Vice',
      matric: 'MAT-002',
      phone: '91988887777',
      email: 'vice@example.com',
      position: 'viceLeader',
    },
  ];

  // Candidatos gerais usados para preparar eleições ainda em rascunho.
  state.candidates.push(
    {
      id: 'cand_class_b_leader',
      name: 'Candidato B',
      matric: 'MAT-B-001',
      class: 'B',
      course: 'Engenharia',
      position: 'leader',
    },
    {
      id: 'cand_class_b_vice',
      name: 'Vice B',
      matric: 'MAT-B-002',
      class: 'B',
      course: 'Engenharia',
      position: 'viceLeader',
    },
    {
      id: 'cand_comp_leader',
      name: 'Candidato Computação',
      matric: 'MAT-COMP-001',
      class: 'B',
      course: 'Computação',
      position: 'leader',
    },
    {
      id: 'cand_comp_vice',
      name: 'Vice Computação',
      matric: 'MAT-COMP-002',
      class: 'B',
      course: 'Computação',
      position: 'viceLeader',
    }
  );

  state.elections.push({
    id: 'election_test_draft',
    class: 'A',
    course: 'Engenharia',
    period: '2027.1',
    status: 'draft',
  });
  state.elections.push({
    id: 'election_test_other_course',
    class: 'B',
    course: 'Computação',
    period: '2027.1',
    status: 'draft',
  });
  state.elections.push({
    id: 'election_test_class_b',
    class: 'B',
    course: 'Engenharia',
    period: '2027.1',
    status: 'draft',
  });
  state.insertedElection = {
    id: 'election_test_new',
    class: 'A',
    course: 'Engenharia',
    period: '2026.2',
    status: 'draft',
    createdBy: 4,
  };
});

describe('API ClassVote - segurança básica', () => {
  it('expõe health check sem autenticação', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('não confia em x-user-role enviado pelo navegador', async () => {
    const response = await request(app)
      .get('/users')
      .set('x-user-role', 'rector');

    expect(response.status).toBe(401);
  });

  it('bloqueia leitura de votos sem token', async () => {
    const response = await request(app).get('/votes');
    expect(response.status).toBe(401);
  });

  it('valida campos obrigatórios do login antes de consultar o banco', async () => {
    const response = await request(app)
      .post('/login')
      .send({ email: '', password: '' });

    expect(response.status).toBe(400);
  });
});

describe('API ClassVote - cadastro legado de candidatos', () => {
  const candidato = {
    id: 'cand_teste_100',
    name: 'Candidato Professor',
    matric: 'MAT-100',
    phone: '91999999999',
    email: 'candidato@teste.com',
    class: 'A',
    course: 'Engenharia',
    position: 'leader',
  };

  it('permite ao professor cadastrar candidato no próprio curso', async () => {
    const response = await request(app)
      .post('/candidates')
      .set(auth(2))
      .send(candidato);

    expect(response.status).toBe(201);
    expect(response.body.id).toBe(candidato.id);

    const insert = state.queries.find(item =>
      /INSERT INTO candidates/i.test(item.sql)
    );

    expect(insert).toBeDefined();
    expect(insert.params[6]).toBe('Engenharia');
  });

  it('impede professor de cadastrar candidato em outro curso', async () => {
    const response = await request(app)
      .post('/candidates')
      .set(auth(2))
      .send({ ...candidato, course: 'Computação', class: 'B' });

    expect(response.status).toBe(403);
    expect(state.queries.some(item =>
      /INSERT INTO candidates/i.test(item.sql)
    )).toBe(false);
  });

  it('permite ao coordenador cadastrar candidato no próprio curso', async () => {
    const response = await request(app)
      .post('/candidates')
      .set(auth(3))
      .send({ ...candidato, id: 'cand_coord_100' });

    expect(response.status).toBe(201);
  });

  it('bloqueia matrícula duplicada no mesmo curso e turma, ignorando maiúsculas e espaços', async () => {
    state.candidates.push({
      id: 'cand_existente',
      name: 'Candidato Existente',
      matric: 'MAT-DUP-001',
      class: 'A',
      course: 'Engenharia',
      position: 'leader',
    });

    const response = await request(app)
      .post('/candidates')
      .set(auth(3))
      .send({
        ...candidato,
        id: 'cand_duplicado',
        matric: ' mat-dup-001 ',
        class: 'A',
        course: 'Engenharia',
      });

    expect(response.status).toBe(409);
    expect(state.candidates.filter(row =>
      !row.election_id &&
      row.class === 'A' &&
      row.course === 'Engenharia' &&
      String(row.matric).trim().toLowerCase() === 'mat-dup-001'
    )).toHaveLength(1);
  });

  it('permite ao reitor cadastrar candidato em outro curso', async () => {
    const response = await request(app)
      .post('/candidates')
      .set(auth(4))
      .send({
        ...candidato,
        id: 'cand_reitor_100',
        course: 'Computação',
        class: 'B',
      });

    expect(response.status).toBe(201);
  });

  it('rejeita turma que não pertence ao curso informado', async () => {
    state.validTurma = false;

    const response = await request(app)
      .post('/candidates')
      .set(auth(2))
      .send({ ...candidato, id: 'cand_turma_invalida' });

    expect(response.status).toBe(400);
    expect(state.queries.some(item =>
      /INSERT INTO candidates/i.test(item.sql)
    )).toBe(false);
  });
});

describe('API ClassVote - candidatos por eleição', () => {
  it('permite ao aluno consultar candidatos da própria eleição aberta', async () => {
    const response = await request(app)
      .get('/elections/election_test_1/candidates')
      .set(auth(1));

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);

    const leader = response.body.find(candidate => candidate.position === 'leader');
    const vice = response.body.find(candidate => candidate.position === 'viceLeader');

    expect(leader).toBeDefined();
    expect(leader.name).toBe('Candidato de Teste');

    expect(vice).toBeDefined();
    expect(vice.name).toBe('Candidato a Vice');

    const query = state.queries.find(item =>
      /FROM election_candidates/i.test(item.sql)
    );

    expect(query).toBeDefined();
    expect(query.sql).toMatch(/SELECT id, name, position/i);
    expect(response.body[0]).not.toHaveProperty('matric');
    expect(response.body[0]).not.toHaveProperty('phone');
    expect(response.body[0]).not.toHaveProperty('email');
  });

  it('impede aluno de consultar candidatos de outra turma', async () => {
    const response = await request(app)
      .get('/elections/election_test_1/candidates')
      .set(auth(5));

    expect(response.status).toBe(404);
  });

  it('permite ao coordenador cadastrar candidato em eleição do próprio curso', async () => {
    const response = await request(app)
      .post('/elections/election_test_draft/candidates')
      .set(auth(3))
      .send({
        name: 'Novo Candidato',
        matric: 'MAT-002',
        phone: '91988887777',
        email: 'novo@example.com',
        position: 'leader',
      });

    expect(response.status).toBe(201);
    expect(response.body.candidate.name).toBe('Novo Candidato');
    expect(response.body.candidate.electionId).toBe('election_test_draft');
    expect(response.body.candidate.id).toMatch(/^candidate_/);

    const insert = state.queries.find(item =>
      /INSERT INTO election_candidates/i.test(item.sql)
    );

    expect(insert).toBeDefined();
    expect(insert.params[0]).toBe('election_test_draft');
    expect(insert.params[1]).toBe('Engenharia');
    expect(insert.params[4]).toBe('MAT-002');
  });

  it('impede coordenador de cadastrar candidato em outro curso', async () => {
    const response = await request(app)
      .post('/elections/election_test_other_course/candidates')
      .set(auth(3))
      .send({
        name: 'Candidato Externo',
        matric: 'MAT-003',
        position: 'leader',
      });

    expect(response.status).toBe(404);
  });

  it('permite ao reitor cadastrar candidato em eleição em rascunho', async () => {
    const response = await request(app)
      .post('/elections/election_test_draft/candidates')
      .set(auth(4))
      .send({
        name: 'Candidato do Reitor',
        matric: 'MAT-004',
        position: 'viceLeader',
      });

    expect(response.status).toBe(201);
  });

  it('bloqueia cadastro de candidato em eleição aberta', async () => {
    const response = await request(app)
      .post('/elections/election_test_1/candidates')
      .set(auth(3))
      .send({
        name: 'Candidato Tardio',
        matric: 'MAT-005',
        position: 'leader',
      });

    expect(response.status).toBe(404);
  });

  it('rejeita dados obrigatórios inválidos', async () => {
    const response = await request(app)
      .post('/elections/election_test_draft/candidates')
      .set(auth(3))
      .send({
        name: ' ',
        matric: '',
        position: 'cargo-invalido',
      });

    expect(response.status).toBe(400);

    expect(
      state.queries.some(item => /INSERT INTO election_candidates/i.test(item.sql))
    ).toBe(false);
  });

  it('retorna 409 para matrícula duplicada', async () => {
    state.candidateDuplicate = true;

    const response = await request(app)
      .post('/elections/election_test_draft/candidates')
      .set(auth(3))
      .send({
        name: 'Candidato Duplicado',
        matric: 'MAT-001',
        position: 'leader',
      });

    expect(response.status).toBe(409);
  });

  it('bloqueia consulta de candidatos sem autenticação', async () => {
    const response = await request(app)
      .get('/elections/election_test_1/candidates');

    expect(response.status).toBe(401);
  });

  it('bloqueia cadastro de candidatos sem autenticação', async () => {
    const response = await request(app)
      .post('/elections/election_test_draft/candidates')
      .send({
        name: 'Sem Autorização',
        matric: 'MAT-006',
        position: 'leader',
      });

    expect(response.status).toBe(401);
  });
});
describe('API ClassVote - eleições por turma', () => {
  it('lista somente eleições abertas da turma e curso do aluno', async () => {
    const response = await request(app)
      .get('/elections')
      .set(auth(1));

    expect(response.status).toBe(200);

    const query = state.queries.find(item => /FROM elections/i.test(item.sql));

    expect(query).toBeDefined();
    expect(query.sql).toContain("status = 'open'");
    expect(query.params).toEqual(['A', 'Engenharia']);
  });

  it('restringe a consulta do professor ao próprio curso', async () => {
    const response = await request(app)
      .get('/elections')
      .set(auth(2));

    expect(response.status).toBe(200);

    const query = state.queries.find(item => /FROM elections/i.test(item.sql));

    expect(query).toBeDefined();
    expect(query.sql).toContain('course = $1');
    expect(query.params).toEqual(['Engenharia']);
  });

  it('não permite ao aluno consultar eleição de outra turma', async () => {
    const response = await request(app)
      .get('/elections/election_test_1')
      .set(auth(5));

    expect(response.status).toBe(404);
  });

  it('não permite ao coordenador criar eleição em outro curso', async () => {
    const response = await request(app)
      .post('/elections')
      .set(auth(3))
      .send({
        class: 'B',
        course: 'Computação',
        period: '2026.2',
      });

    expect(response.status).toBe(403);

    expect(
      state.queries.some(item => /INSERT INTO elections/i.test(item.sql))
    ).toBe(false);
  });

  it('permite ao reitor criar eleição para turma válida', async () => {
    const response = await request(app)
      .post('/elections')
      .set(auth(4))
      .send({
        class: 'A',
        course: 'Engenharia',
        period: '2026.2',
      });

    expect(response.status).toBe(201);
    expect(response.body.election.status).toBe('draft');
    expect(response.body.election.id).toMatch(/^election_/);

    const insert = state.queries.find(item => /INSERT INTO elections/i.test(item.sql));

    expect(insert).toBeDefined();
    expect(insert.params[1]).toBe('A');
    expect(insert.params[2]).toBe('Engenharia');
    expect(insert.params[3]).toBe('2026.2');
    expect(insert.params[4]).toBe(4);
  });

  it('rejeita criação quando a turma não existe no curso', async () => {
    state.validTurma = false;

    const response = await request(app)
      .post('/elections')
      .set(auth(4))
      .send({
        class: 'Z',
        course: 'Engenharia',
        period: '2026.2',
      });

    expect(response.status).toBe(400);
    expect(
      state.queries.some(item => /INSERT INTO elections/i.test(item.sql))
    ).toBe(false);
  });

  it('retorna 409 quando já existe eleição para turma, curso e período', async () => {
    state.duplicate = true;

    const response = await request(app)
      .post('/elections')
      .set(auth(4))
      .send({
        class: 'A',
        course: 'Engenharia',
        period: '2026.2',
      });

    expect(response.status).toBe(409);
  });

  it('permite ao coordenador iniciar eleição de outra turma do mesmo curso', async () => {
    const response = await request(app)
      .post('/elections/election_test_class_b/start')
      .set(auth(3));

    expect(response.status).toBe(200);
    expect(response.body.election.status).toBe('open');

    expect(
      state.elections.find(row => row.id === 'election_test_class_b').status
    ).toBe('open');

    expect(
      state.elections.find(row => row.id === 'election_test_1').status
    ).toBe('open');
  });

  it('não permite ao professor iniciar uma eleição', async () => {
    const response = await request(app)
      .post('/elections/election_test_draft/start')
      .set(auth(2));

    expect(response.status).toBe(403);
    expect(
      state.elections.find(row => row.id === 'election_test_draft').status
    ).toBe('draft');
  });

  it('permite ao coordenador encerrar uma eleição aberta do próprio curso', async () => {
    const response = await request(app)
      .post('/elections/election_test_1/end')
      .set(auth(3));

    expect(response.status).toBe(200);
    expect(response.body.election.status).toBe('closed');
    expect(response.body.election.endedAt).toBeTruthy();
  });

  it('permite ao professor encerrar uma eleição aberta do próprio curso', async () => {
    const response = await request(app)
      .post('/elections/election_test_1/end')
      .set(auth(2));

    expect(response.status).toBe(200);
    expect(response.body.election.status).toBe('closed');
    expect(response.body.election.endedAt).toBeTruthy();
  });

  it('não permite ao professor encerrar eleição de outro curso', async () => {
    const otherCourseElection = state.elections.find(
      row => row.id === 'election_test_other_course'
    );
    otherCourseElection.status = 'open';

    const response = await request(app)
      .post('/elections/election_test_other_course/end')
      .set(auth(2));

    expect(response.status).toBe(404);
    expect(otherCourseElection.status).toBe('open');
  });

  it('não permite ao coordenador iniciar eleição de outro curso', async () => {
    const response = await request(app)
      .post('/elections/election_test_other_course/start')
      .set(auth(3));

    expect(response.status).toBe(404);
    expect(
      state.elections.find(row => row.id === 'election_test_other_course').status
    ).toBe('draft');
  });

  it('não permite reabrir uma eleição encerrada', async () => {
    state.elections.find(row => row.id === 'election_test_1').status = 'closed';

    const response = await request(app)
      .post('/elections/election_test_1/start')
      .set(auth(3));

    expect(response.status).toBe(409);
  });

  it('não permite encerrar uma eleição que ainda não começou', async () => {
    const response = await request(app)
      .post('/elections/election_test_draft/end')
      .set(auth(3));

    expect(response.status).toBe(409);
  });

  it('permite ao reitor iniciar eleição de qualquer curso', async () => {
    const response = await request(app)
      .post('/elections/election_test_other_course/start')
      .set(auth(4));

    expect(response.status).toBe(200);
    expect(response.body.election.status).toBe('open');
  });

  it('não inicia eleição sem ao menos um líder e um vice-líder', async () => {
    const response = await request(app)
      .post('/elections/election_test_draft/start')
      .set(auth(3));

    expect(response.status).toBe(409);
    expect(state.elections.find(row => row.id === 'election_test_draft').status)
      .toBe('draft');
  });
  it('bloqueia consulta de eleições sem autenticação', async () => {
    const response = await request(app).get('/elections');
    expect(response.status).toBe(401);
  });
});

describe('API ClassVote - exclusão de usuários e permissões', () => {
  it('permite ao coordenador excluir aluno do próprio curso', async () => {
    const response = await request(app)
      .delete('/users/aluno@teste.com')
      .set(auth(3));

    expect(response.status).toBe(200);
  });

  it('permite ao coordenador excluir professor do próprio curso', async () => {
    const response = await request(app)
      .delete('/users/professor@teste.com')
      .set(auth(3));

    expect(response.status).toBe(200);
  });

  it('impede coordenador de excluir usuário de outro curso', async () => {
    const response = await request(app)
      .delete('/users/aluno2@teste.com')
      .set(auth(3));

    expect(response.status).toBe(404);
  });

  it('impede coordenador de excluir outro coordenador', async () => {
    const response = await request(app)
      .delete('/users/coordenador2@teste.com')
      .set(auth(3));

    expect(response.status).toBe(404);
  });

  it('impede coordenador de excluir o reitor', async () => {
    const response = await request(app)
      .delete('/users/reitor@teste.com')
      .set(auth(3));

    expect(response.status).toBe(404);
  });

  it('permite ao reitor excluir um coordenador', async () => {
    const response = await request(app)
      .delete('/users/coordenador@teste.com')
      .set(auth(4));

    expect(response.status).toBe(200);
  });
});

describe('API ClassVote - votação por eleição', () => {

  it('mantém uma blockchain independente para cada eleição', async () => {
    const electionId = 'election_test_other_course';

    state.elections.find(row => row.id === electionId).status = 'open';

    state.candidates.push(
      {
        id: 'candidate_comp_leader',
        election_id: electionId,
        name: 'Candidato Computação',
        matric: 'MAT-COMP-001',
        position: 'leader',
      },
      {
        id: 'candidate_comp_vice',
        election_id: electionId,
        name: 'Vice Computação',
        matric: 'MAT-COMP-002',
        position: 'viceLeader',
      }
    );

    const firstVote = await request(app)
      .post('/elections/election_test_1/votes')
      .set(auth(1))
      .send({
        leader: 'candidate_test_1',
        viceLeader: 'candidate_test_vice',
      });

    const secondVote = await request(app)
      .post(`/elections/${electionId}/votes`)
      .set(auth(5))
      .send({
        leader: 'candidate_comp_leader',
        viceLeader: 'candidate_comp_vice',
      });

    expect(firstVote.status).toBe(201);
    expect(secondVote.status).toBe(201);

    const chainA = state.electionBlockchain.filter(
      block => block.election_id === 'election_test_1'
    );

    const chainB = state.electionBlockchain.filter(
      block => block.election_id === electionId
    );

    expect(chainA).toHaveLength(1);
    expect(chainB).toHaveLength(1);

    expect(chainA[0].idx).toBe(0);
    expect(chainB[0].idx).toBe(0);

    expect(chainA[0].previoushash).toBe('0');
    expect(chainB[0].previoushash).toBe('0');

    expect(chainA[0].hash).not.toBe(chainB[0].hash);
  });

  it('registra voto anônimo e participação identificada separadamente', async () => {
    const response = await request(app)
      .post('/elections/election_test_1/votes')
      .set(auth(1))
      .send({
        leader: 'candidate_test_1',
        viceLeader: 'candidate_test_vice',
      });

    expect(response.status).toBe(201);
    expect(state.ballots).toHaveLength(1);
    expect(state.participation).toHaveLength(1);
    expect(state.electionBlockchain).toHaveLength(1);

    const ballot = state.ballots[0];
    const participation = state.participation[0];

    expect(Object.keys(ballot).sort()).toEqual([
      'election_id',
      'id',
      'leader_candidate_id',
      'vice_candidate_id',
    ]);

    expect(ballot.id).not.toBe(participation.id);
    expect(ballot).not.toHaveProperty('voter_id');
    expect(ballot).not.toHaveProperty('voter_matric');
    expect(ballot).not.toHaveProperty('timestamp');

    expect(participation.voter_id).toBe(1);
    expect(participation.voter_matric).toBe('MAT-ALUNO-001');

    expect(state.electionBlockchain[0].idx).toBe(0);
    expect(state.electionBlockchain[0].previoushash).toBe('0');
  });

  it('impede o mesmo eleitor de votar duas vezes na mesma eleição', async () => {
    const vote = {
      leader: 'candidate_test_1',
      viceLeader: 'candidate_test_vice',
    };

    const first = await request(app)
      .post('/elections/election_test_1/votes')
      .set(auth(1))
      .send(vote);

    const second = await request(app)
      .post('/elections/election_test_1/votes')
      .set(auth(1))
      .send(vote);

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);

    expect(state.ballots).toHaveLength(1);
    expect(state.participation).toHaveLength(1);
    expect(state.electionBlockchain).toHaveLength(1);
  });

  it('rejeita candidatos inválidos sem registrar voto', async () => {
    const response = await request(app)
      .post('/elections/election_test_1/votes')
      .set(auth(1))
      .send({
        leader: 'candidato_inexistente',
        viceLeader: 'candidate_test_vice',
      });

    expect(response.status).toBe(400);
    expect(state.ballots).toHaveLength(0);
    expect(state.participation).toHaveLength(0);
    expect(state.electionBlockchain).toHaveLength(0);
  });

  it('impede eleitor de votar em eleição de outra turma', async () => {
        state.elections.find(
      row => row.id === 'election_test_class_b'
    ).status = 'open';
    const response = await request(app)
      .post('/elections/election_test_class_b/votes')
      .set(auth(1))
      .send({
        leader: 'candidate_test_1',
        viceLeader: 'candidate_test_vice',
      });

    expect(response.status).toBe(404);
    expect(state.ballots).toHaveLength(0);
    expect(state.participation).toHaveLength(0);
    expect(state.electionBlockchain).toHaveLength(0);
  });
    it('desfaz cédula e participação quando ocorre falha na blockchain', async () => {
    state.failBlockchainInsert = true;

    const response = await request(app)
      .post('/elections/election_test_1/votes')
      .set(auth(1))
      .send({
        leader: 'candidate_test_1',
        viceLeader: 'candidate_test_vice',
      });

    expect(response.status).toBe(500);

    expect(state.ballots).toHaveLength(0);
    expect(state.participation).toHaveLength(0);
    expect(state.electionBlockchain).toHaveLength(0);
  });

  it('permite verificar integridade da blockchain da eleição', async () => {
    // Registra um voto primeiro
    await request(app)
      .post('/elections/election_test_1/votes')
      .set(auth(1))
      .send({
        leader: 'candidate_test_1',
        viceLeader: 'candidate_test_vice',
      });

    const response = await request(app)
      .get('/elections/election_test_1/blockchain/verify')
      .set(auth(3)); // Coordenador

    expect(response.status).toBe(200);
    expect(response.body.isValid).toBe(true);
    expect(response.body.totalBlocks).toBe(1);
  });

  it('permite ao aluno verificar integridade da blockchain da própria eleição', async () => {
    await request(app)
      .post('/elections/election_test_1/votes')
      .set(auth(1))
      .send({
        leader: 'candidate_test_1',
        viceLeader: 'candidate_test_vice',
      });

    const response = await request(app)
      .get('/elections/election_test_1/blockchain/verify')
      .set(auth(1)); // Aluno

    expect(response.status).toBe(200);
    expect(response.body.isValid).toBe(true);
  });

  it('impede aluno de verificar blockchain de eleição de outra turma', async () => {
    const response = await request(app)
      .get('/elections/election_test_1/blockchain/verify')
      .set(auth(5)); // Aluno de outra turma (B)

    expect(response.status).toBe(404);
  });

  it('detecta corrupção na blockchain da eleição', async () => {
    await request(app)
      .post('/elections/election_test_1/votes')
      .set(auth(1))
      .send({
        leader: 'candidate_test_1',
        viceLeader: 'candidate_test_vice',
      });

    // Corrompe o dado no mock state
    state.electionBlockchain[0].data.leader = 'fraude';

    const response = await request(app)
      .get('/elections/election_test_1/blockchain/verify')
      .set(auth(4)); // Reitor

    expect(response.status).toBe(200);
    expect(response.body.isValid).toBe(false);
    expect(response.body.error).toContain('Hash do bloco inválido');
  });
});
describe('API ClassVote - modo demonstração', () => {
  it('bloqueia operações de escrita, mas permite login e consultas', async () => {
    const previousDemoMode = process.env.DEMO_MODE;
    process.env.DEMO_MODE = 'true';

    try {
      // Health check público.
      const health = await request(app).get('/health');
      expect(health.status).toBe(200);

      // Consulta autenticada de eleições continua funcionando.
      const elections = await request(app)
        .get('/elections')
        .set(auth(1));

      expect(elections.status).toBe(200);
      expect(
        state.queries.some(item => /FROM elections/i.test(item.sql))
      ).toBe(true);

      // Login continua acessível.
      const login = await request(app)
        .post('/login')
        .send({});

      expect([400, 429]).toContain(login.status);

      // Criação de eleição bloqueada.
      const election = await request(app)
        .post('/elections')
        .set(auth(4))
        .send({});

      expect(election.status).toBe(403);

      // Registro de voto bloqueado.
      const vote = await request(app)
        .post('/elections/election_test_1/votes')
        .set(auth(1))
        .send({});

      expect(vote.status).toBe(403);

      // Exclusão de usuário bloqueada.
      const deletion = await request(app)
        .delete('/users/aluno@teste.com')
        .set(auth(4));

      expect(deletion.status).toBe(403);

      // Nenhuma consulta de escrita deve chegar ao banco.
      expect(
        state.queries.every(item => /^\s*SELECT\b/i.test(item.sql))
      ).toBe(true);

    } finally {
      if (previousDemoMode === undefined) {
        delete process.env.DEMO_MODE;
      } else {
        process.env.DEMO_MODE = previousDemoMode;
      }
    }
  });
});
