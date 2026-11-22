
-- ClassVote - Migration 001
-- Separa a cédula secreta do registro de participação.
-- Não remove nem altera a tabela legada votes.
-- Não apaga nem reconstrói dados da blockchain.

-- 1. Cédulas: armazenam somente as escolhas e dados amplos da turma.
CREATE TABLE IF NOT EXISTS ballots (
    id TEXT PRIMARY KEY,
    leader TEXT NOT NULL,
    vice_leader TEXT NOT NULL,
    voter_class TEXT,
    course TEXT,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ballots_different_candidates
        CHECK (leader <> vice_leader)
);

-- 2. Participação: registra quem votou, sem armazenar sua escolha.
CREATE TABLE IF NOT EXISTS voter_participation (
    id TEXT PRIMARY KEY,
    voter_id INTEGER NOT NULL UNIQUE
        REFERENCES users(id) ON DELETE RESTRICT,
    voter_name TEXT NOT NULL,
    voter_matric TEXT NOT NULL,
    voter_class TEXT NOT NULL,
    course TEXT,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT voter_participation_identity_unique
        UNIQUE (voter_matric, voter_class, course)
);

-- 3. Restringe os perfis permitidos.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.users'::regclass
          AND conname = 'users_role_check'
    ) THEN
        ALTER TABLE users
        ADD CONSTRAINT users_role_check
        CHECK (role IN ('voter', 'teacher', 'coordinator', 'rector'));
    END IF;
END
$$;

-- 4. Garante unicidade de e-mails ignorando maiúsculas/minúsculas.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower
    ON users (lower(email));

-- 5. Relaciona as turmas aos cursos.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.turmas'::regclass
          AND conname = 'turmas_course_fkey'
    ) THEN
        ALTER TABLE turmas
        ADD CONSTRAINT turmas_course_fkey
        FOREIGN KEY (course)
        REFERENCES courses(name)
        ON UPDATE CASCADE;
    END IF;
END
$$;

-- 6. Restringe as chaves de situação da eleição.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.election_status'::regclass
          AND conname = 'election_status_key_check'
    ) THEN
        ALTER TABLE election_status
        ADD CONSTRAINT election_status_key_check
        CHECK (key IN ('started', 'ended'));
    END IF;
END
$$;

-- 7. Garante unicidade dos hashes da blockchain.
CREATE UNIQUE INDEX IF NOT EXISTS idx_blockchain_hash_unique
    ON blockchain (hash);

-- 8. Índices para consultas frequentes.
CREATE INDEX IF NOT EXISTS idx_users_class_course
    ON users (class, course);

CREATE INDEX IF NOT EXISTS idx_candidates_class_course
    ON candidates (class, course);

CREATE INDEX IF NOT EXISTS idx_participation_class_course
    ON voter_participation (voter_class, course);

CREATE INDEX IF NOT EXISTS idx_ballots_course_class
    ON ballots (course, voter_class);

CREATE INDEX IF NOT EXISTS idx_ballots_timestamp
    ON ballots (timestamp);
