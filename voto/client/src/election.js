
export function normalizeComparable(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase('pt-BR');
}

export function isCandidateEligible(candidate, voter) {
  const candidateClass = normalizeComparable(candidate?.class);
  const candidateCourse = normalizeComparable(candidate?.course);
  const voterClass = normalizeComparable(voter?.class);
  const voterCourse = normalizeComparable(voter?.course);

  if (candidateCourse) {
    return candidateClass === voterClass &&
      candidateCourse === voterCourse;
  }

  return candidateClass === voterClass ||
    (!!voterCourse && candidateClass === voterCourse);
}

export function tallyResults(results = []) {
  return results.reduce((totals, ballot) => {
    if (ballot.position === 'leader' && ballot.candidateId) {
      totals.leader[ballot.candidateId] =
        (totals.leader[ballot.candidateId] || 0) +
        Number(ballot.total || 0);
    } else if (ballot.position === 'viceLeader' && ballot.candidateId) {
      totals.viceLeader[ballot.candidateId] =
        (totals.viceLeader[ballot.candidateId] || 0) +
        Number(ballot.total || 0);
    } else {
      if (ballot.leader) {
        totals.leader[ballot.leader] =
          (totals.leader[ballot.leader] || 0) + 1;
      }

      if (ballot.viceLeader) {
        totals.viceLeader[ballot.viceLeader] =
          (totals.viceLeader[ballot.viceLeader] || 0) + 1;
      }
    }

    return totals;
  }, { leader: {}, viceLeader: {} });
}
