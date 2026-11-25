-- Migration 004: impede matrícula duplicada por turma/curso e por eleição.
-- Não apaga registros conflitantes automaticamente: eleições antigas podem ter
-- cédulas que referenciam election_candidates. Revise duplicidades antes de aplicar.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM candidates
    GROUP BY class, COALESCE(course, ''), lower(btrim(matric))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Há matrículas duplicadas em candidates para a mesma turma/curso. Revise antes da migration 004.'
      USING HINT = 'Consulte duplicidades agrupando por turma, curso e matrícula normalizada.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM election_candidates
    GROUP BY election_id, lower(btrim(matric))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Há matrículas duplicadas em election_candidates dentro da mesma eleição. Revise antes da migration 004.'
      USING HINT = 'Não remova candidatos históricos sem verificar referências em election_ballots.';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_unique_class_course_matric
  ON candidates (class, COALESCE(course, ''), lower(btrim(matric)));

CREATE UNIQUE INDEX IF NOT EXISTS idx_election_candidates_unique_matric_normalized
  ON election_candidates (election_id, lower(btrim(matric)));
