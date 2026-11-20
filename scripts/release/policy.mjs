export function requireGreenBaseline(manifest, revision, expectedFiles) {
  if (manifest.git.head !== revision || !manifest.summary?.success || manifest.summary.failed || manifest.summary.skipped ||
      manifest.summary.files !== expectedFiles || manifest.steps.some(step => step.exitCode !== 0)) throw new Error('Release validation is not green for the exact source revision');
}
export function requireCandidatePair(images, revision) {
  if (!/^[0-9a-f]{40}$/.test(revision) || images.length !== 2 || new Set(images.map(image => image.target)).size !== 2 ||
      !images.some(image => image.target === 'runtime') || !images.some(image => image.target === 'migrate') ||
      images.some(image => image.revision !== revision || !/^sha256:[0-9a-f]{64}$/.test(image.digest))) throw new Error('Candidate image pair is not verified');
}
export function requireVersion(version, packageVersion) {
  if (!/^v\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version) || version !== 'v' + packageVersion) throw new Error('Release tag does not match package version');
}
export function requireAcceptance(report, revision, imageHash, candidateHash) {
  if (report.revision !== revision || !report.auditPassed || !report.baselinePassed || report.imageArchiveSha256 !== imageHash ||
      report.candidateManifestSha256 !== candidateHash || report.faults?.length !== 6 ||
      new Set(report.faults.map(test => test.label)).size !== 6 ||
      ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'].some(label => !report.faults.some(test => test.label === label && test.status === 'PASS'))) throw new Error('Candidate acceptance evidence is incomplete');
}
