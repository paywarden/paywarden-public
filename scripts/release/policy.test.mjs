import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireGreenBaseline, requireCandidatePair, requireVersion, requireAcceptance } from './policy.mjs';

const revision = 'a'.repeat(40);
const good = () => ({ git: { head: revision }, summary: { success: true, failed: 0, skipped: 0, files: 36 }, steps: [{ exitCode: 0 }] });
test('rejects skipped tests and mismatching source revisions before publishing', () => {
  assert.doesNotThrow(() => requireGreenBaseline(good(), revision, 36));
  const skipped = good(); skipped.summary.skipped = 1;
  assert.throws(() => requireGreenBaseline(skipped, revision, 36));
  assert.throws(() => requireGreenBaseline(good(), 'b'.repeat(40), 36));
});
test('rejects failed checks and duplicate test discovery', () => {
  const failed = good(); failed.steps[0].exitCode = 1;
  assert.throws(() => requireGreenBaseline(failed, revision, 36));
  assert.throws(() => requireGreenBaseline(good(), revision, 72));
});
test('requires both images at the same revision and immutable digests', () => {
  const pair = ['runtime', 'migrate'].map(target => ({ target, revision, digest: 'sha256:' + 'c'.repeat(64) }));
  assert.doesNotThrow(() => requireCandidatePair(pair, revision));
  assert.throws(() => requireCandidatePair([pair[0]], revision));
  assert.throws(() => requireCandidatePair([pair[0], { ...pair[1], revision: 'unknown' }], revision));
  assert.throws(() => requireCandidatePair([pair[0], { ...pair[1], digest: 'latest' }], revision));
});
test('rejects stale and malformed release tags', () => {
  assert.doesNotThrow(() => requireVersion('v1.0.0-rc.2', '1.0.0-rc.2'));
  assert.throws(() => requireVersion('v1.0.0-rc.1', '1.0.0-rc.2'));
  assert.throws(() => requireVersion('v1.0.0;echo x', '1.0.0;echo x'));
});
test('does not stage a candidate with incomplete fault acceptance or changed image bytes', () => {
  const report = { revision, auditPassed: true, baselinePassed: true, imageArchiveSha256: 'image-hash', candidateManifestSha256: 'candidate-hash',
    faults: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'].map(label => ({ label, status: 'PASS' })) };
  assert.doesNotThrow(() => requireAcceptance(report, revision, 'image-hash', 'candidate-hash'));
  assert.throws(() => requireAcceptance(report, revision, 'changed-image', 'candidate-hash'));
  assert.throws(() => requireAcceptance({ ...report, auditPassed: false }, revision, 'image-hash', 'candidate-hash'));
  assert.throws(() => requireAcceptance({ ...report, faults: report.faults.slice(1) }, revision, 'image-hash', 'candidate-hash'));
});
