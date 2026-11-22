-- ClassVote - Migration 002
-- Eleicoes independentes por turma, curso e periodo.
-- As tabelas legadas permanecem intactas.

CREATE TABLE elections (
    id TEXT PRIMARY KEY,
    class TEXT NOT NULL,
    course TEXT NOT NULL,
    period TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    created_by INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,

    CONSTRAINT elections_status_check
        CHECK (status IN ('draft', 'open', 'closed')),

    CONSTRAINT elections_period_not_empty
        CHECK (length(trim(period)) > 0),

    CONSTRAINT elections_class_course_period_unique
        UNIQUE (class, course, period),

    CONSTRAINT elections_class_course_fk
        FOREIGN KEY (class, course)
        REFERENCES turmas (name, course)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT elections_created_by_fk
        FOREIGN KEY (created_by)
        REFERENCES users (id)
        ON DELETE RESTRICT
);

-- Uma única eleição aberta por turma e curso.
-- Eleições encerradas permanecem disponíveis como histórico.
CREATE UNIQUE INDEX elections_one_open_per_class
    ON elections (class, course)
    WHERE status = 'open';

CREATE INDEX elections_course_status_idx
    ON elections (course, status);

CREATE INDEX elections_class_course_idx
    ON elections (class, course);


CREATE TABLE election_candidates (
    id TEXT PRIMARY KEY,
    election_id TEXT NOT NULL,
    name TEXT NOT NULL,
    matric TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    position TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT election_candidates_position_check
        CHECK (position IN ('leader', 'viceLeader')),

    CONSTRAINT election_candidates_name_not_empty
        CHECK (length(trim(name)) > 0),

    CONSTRAINT election_candidates_election_id_unique
        UNIQUE (election_id, id),

    CONSTRAINT election_candidates_matric_unique
        UNIQUE (election_id, matric),

    CONSTRAINT election_candidates_election_fk
        FOREIGN KEY (election_id)
        REFERENCES elections (id)
        ON DELETE RESTRICT
);

CREATE INDEX election_candidates_election_position_idx
    ON election_candidates (election_id, position);


-- Não armazena identificação do eleitor junto à escolha.
CREATE TABLE election_ballots (
    id TEXT PRIMARY KEY,
    election_id TEXT NOT NULL,
    leader_candidate_id TEXT NOT NULL,
    vice_candidate_id TEXT NOT NULL,

    CONSTRAINT election_ballots_different_candidates
        CHECK (leader_candidate_id <> vice_candidate_id),

    CONSTRAINT election_ballots_election_id_unique
        UNIQUE (election_id, id),

    CONSTRAINT election_ballots_election_fk
        FOREIGN KEY (election_id)
        REFERENCES elections (id)
        ON DELETE RESTRICT,

    CONSTRAINT election_ballots_leader_fk
        FOREIGN KEY (election_id, leader_candidate_id)
        REFERENCES election_candidates (election_id, id)
        ON DELETE RESTRICT,

    CONSTRAINT election_ballots_vice_fk
        FOREIGN KEY (election_id, vice_candidate_id)
        REFERENCES election_candidates (election_id, id)
        ON DELETE RESTRICT
);

CREATE INDEX election_ballots_election_idx
    ON election_ballots (election_id);


-- Participação identificada, separada dos votos anônimos.
CREATE TABLE election_participation (
    id TEXT PRIMARY KEY,
    election_id TEXT NOT NULL,
    voter_id INTEGER NOT NULL,
    voter_name TEXT NOT NULL,
    voter_matric TEXT NOT NULL,
    voter_class TEXT NOT NULL,
    course TEXT NOT NULL,

    CONSTRAINT election_participation_once_per_user
        UNIQUE (election_id, voter_id),

    CONSTRAINT election_participation_matric_unique
        UNIQUE (election_id, voter_matric),

    CONSTRAINT election_participation_election_fk
        FOREIGN KEY (election_id)
        REFERENCES elections (id)
        ON DELETE RESTRICT,

    CONSTRAINT election_participation_user_fk
        FOREIGN KEY (voter_id)
        REFERENCES users (id)
        ON DELETE RESTRICT
);

CREATE INDEX election_participation_election_idx
    ON election_participation (election_id);

CREATE INDEX election_participation_course_class_idx
    ON election_participation (course, voter_class);


-- Blockchain independente para cada eleição.
CREATE TABLE election_blockchain (
    election_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    data JSONB NOT NULL,
    previoushash TEXT NOT NULL,
    hash TEXT NOT NULL,

    CONSTRAINT election_blockchain_pk
        PRIMARY KEY (election_id, idx),

    CONSTRAINT election_blockchain_hash_unique
        UNIQUE (election_id, hash),

    CONSTRAINT election_blockchain_idx_check
        CHECK (idx >= 0),

    CONSTRAINT election_blockchain_election_fk
        FOREIGN KEY (election_id)
        REFERENCES elections (id)
        ON DELETE RESTRICT
);

CREATE INDEX election_blockchain_election_idx
    ON election_blockchain (election_id, idx);
