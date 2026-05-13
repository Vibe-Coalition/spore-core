const HARD_TEMP_TTL = 'temp';
const CANDIDATE_LIFECYCLE = 'candidate';
const DURABLE_LIFECYCLE = 'durable';

function parseExtra(extra) {
  if (!extra) return {};
  if (typeof extra === 'object') return { ...extra };
  try {
    const parsed = JSON.parse(String(extra));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isHardTemp(extra) {
  return parseExtra(extra).ttl === HARD_TEMP_TTL;
}

function isCandidate(extra) {
  const obj = parseExtra(extra);
  return obj.ttl !== HARD_TEMP_TTL && obj.lifecycle === CANDIDATE_LIFECYCLE;
}

function makeHardTempExtra(extra = {}, source = 'unknown') {
  const obj = parseExtra(extra);
  obj.ttl = HARD_TEMP_TTL;
  obj.tempCreated = obj.tempCreated || new Date().toISOString();
  obj.tempSource = obj.tempSource || source;
  delete obj.lifecycle;
  delete obj.candidateCreated;
  delete obj.candidateReviewedAt;
  delete obj.candidateReason;
  delete obj.candidateSource;
  return obj;
}

function makeCandidateExtra(extra = {}, source = 'unknown', reason = 'new learned node') {
  const obj = parseExtra(extra);
  if (obj.ttl === HARD_TEMP_TTL) return obj;
  if (obj.lifecycle !== DURABLE_LIFECYCLE) {
    obj.lifecycle = CANDIDATE_LIFECYCLE;
    obj.candidateCreated = obj.candidateCreated || new Date().toISOString();
    obj.candidateReason = obj.candidateReason || reason;
    obj.candidateSource = obj.candidateSource || source;
  }
  return obj;
}

function promoteCandidateExtra(extra = {}, source = 'unknown', reason = 'promoted by lifecycle review') {
  const obj = parseExtra(extra);
  delete obj.ttl;
  delete obj.tempCreated;
  delete obj.tempSource;
  delete obj.candidateCreated;
  delete obj.candidateReviewedAt;
  delete obj.candidateReason;
  delete obj.candidateSource;
  obj.lifecycle = DURABLE_LIFECYCLE;
  obj.promotedAt = new Date().toISOString();
  obj.promotedBy = source;
  obj.promotedReason = reason;
  return obj;
}

function keepCandidateExtra(extra = {}, source = 'unknown') {
  const obj = parseExtra(extra);
  if (obj.ttl === HARD_TEMP_TTL) return obj;
  obj.lifecycle = CANDIDATE_LIFECYCLE;
  obj.candidateCreated = obj.candidateCreated || new Date().toISOString();
  obj.candidateReviewedAt = new Date().toISOString();
  obj.candidateReviewedBy = source;
  return obj;
}

module.exports = {
  HARD_TEMP_TTL,
  CANDIDATE_LIFECYCLE,
  DURABLE_LIFECYCLE,
  parseExtra,
  isHardTemp,
  isCandidate,
  makeHardTempExtra,
  makeCandidateExtra,
  promoteCandidateExtra,
  keepCandidateExtra,
};
