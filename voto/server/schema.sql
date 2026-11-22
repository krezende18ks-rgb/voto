-- ClassVote PostgreSQL schema
-- Execute com: npm run db:init

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('voter', 'teacher', 'coordinator', 'rector')),
  matric TEXT,
  class TEXT,
  course TEXT
);

CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  matric TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  class TEXT NOT NULL,
  course TEXT,
  position TEXT NOT NULL CHECK (position IN ('leader', 'viceLeader'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email));

CREATE TABLE IF NOT EXISTS courses (name TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS turmas (
  name TEXT NOT NULL,
  course TEXT NOT NULL REFERENCES courses(name) ON UPDATE CASCADE,
  PRIMARY KEY (name, course)
);
CREATE TABLE IF NOT EXISTS election_status (
  key TEXT PRIMARY KEY CHECK (key IN ('started', 'ended')),
  value BOOLEAN NOT NULL DEFAULT FALSE
);
INSERT INTO election_status(key,value) VALUES ('started',FALSE),('ended',FALSE) ON CONFLICT DO NOTHING;

-- Dados de presença/participação: identifica quem votou, mas não guarda sua escolha.
CREATE TABLE IF NOT EXISTS voter_participation (
  id TEXT PRIMARY KEY,
  voter_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  voter_name TEXT NOT NULL,
  voter_matric TEXT NOT NULL,
  voter_class TEXT NOT NULL,
  course TEXT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (voter_matric, voter_class, course)
);

-- Cédula secreta: guarda somente a escolha e metadados amplos da turma/curso.
-- Não há voter_id, matrícula, nome, e-mail, IP ou identificador de participação.
CREATE TABLE IF NOT EXISTS ballots (
  id TEXT PRIMARY KEY,
  leader TEXT NOT NULL,
  vice_leader TEXT NOT NULL,
  voter_class TEXT,
  course TEXT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (leader <> vice_leader)
);

CREATE TABLE IF NOT EXISTS blockchain (
  idx INTEGER PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL,
  previoushash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_users_class_course ON users(class, course);
CREATE INDEX IF NOT EXISTS idx_candidates_class_course ON candidates(class, course);
CREATE INDEX IF NOT EXISTS idx_participation_class_course ON voter_participation(voter_class, course);
CREATE UNIQUE INDEX IF NOT EXISTS idx_participation_identity ON voter_participation(voter_matric, voter_class, course);
CREATE INDEX IF NOT EXISTS idx_ballots_course_class ON ballots(course, voter_class);
CREATE INDEX IF NOT EXISTS idx_ballots_timestamp ON ballots(timestamp);

INSERT INTO courses(name) VALUES ('Engenharia'),('Direito') ON CONFLICT DO NOTHING;
INSERT INTO turmas(name,course) VALUES ('A','Engenharia'),('B','Engenharia'),('C','Direito') ON CONFLICT DO NOTHING;

-- Não são criadas contas de demonstração com senha padrão.
-- Crie usuários com `npm run user:create` para gerar hashes bcrypt.
