import { describe, expect, it } from 'vitest';
import { normalizeComparable, isCandidateEligible, tallyResults } from './election.js';

describe('regras eleitorais', () => {
  it('normaliza acentos, caixa e espaços', () => {
    expect(normalizeComparable('  Engenharia  ')).toBe('engenharia');
    expect(normalizeComparable('Ciência da Computação')).toBe('ciencia da computacao');
  });

  it('aceita candidato da mesma turma e curso', () => {
    expect(isCandidateEligible({ class: 'A', course: 'Engenharia' }, { class: 'A', course: 'Engenharia' })).toBe(true);
  });

  it('mantém compatibilidade com candidatos antigos associados ao curso no campo turma', () => {
    expect(isCandidateEligible({ class: 'Engenharia', course: null }, { class: 'A', course: 'Engenharia' })).toBe(true);
  });

  it('rejeita candidato de outra turma ou curso', () => {
    expect(isCandidateEligible({ class: 'B', course: 'Engenharia' }, { class: 'A', course: 'Engenharia' })).toBe(false);
    expect(isCandidateEligible({ class: 'A', course: 'Direito' }, { class: 'A', course: 'Engenharia' })).toBe(false);
  });

  it('contabiliza resultados agregados por cargo', () => {
    expect(tallyResults([{ position: 'leader', candidateId: 'l1', total: 3 }, { position: 'viceLeader', candidateId: 'v1', total: 2 }])).toEqual({ leader: { l1: 3 }, viceLeader: { v1: 2 } });
  });
  it('rejeita candidato de outro curso quando o eleitor não possui curso', () => {
  expect(
    isCandidateEligible(
      { class: 'A', course: 'Engenharia' },
      { class: 'A', course: null }
    )
  ).toBe(false);
});

it('aceita candidato antigo do curso correspondente', () => {
  expect(
    isCandidateEligible(
      { class: 'Ciencia da computação', course: null },
      { class: 'turmas a', course: 'Ciencia da computação' }
    )
  ).toBe(true);
});

it('rejeita candidato antigo de outro curso', () => {
  expect(
    isCandidateEligible(
      { class: 'Direito', course: null },
      { class: 'turmas a', course: 'Ciencia da computação' }
    )
  ).toBe(false);
});

  it('contabiliza votos de líder e vice-líder separadamente', () => {
    expect(tallyResults([{ leader: 'l1', viceLeader: 'v1' }, { leader: 'l1', viceLeader: 'v2' }])).toEqual({
      leader: { l1: 2 }, viceLeader: { v1: 1, v2: 1 },
    });
  });
});
