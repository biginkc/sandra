import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const candidatePath = fileURLToPath(new URL('../../deployment/inbox/candidate.json', import.meta.url));
const pending = 'PENDING_EIMG_BUILD';

export function requireCandidateElectricImage() {
  const candidate = JSON.parse(readFileSync(candidatePath, 'utf8'));
  const service = candidate.services?.find((item) => item?.name === 'inbox-electric');
  const image = service?.image;
  if (
    typeof image !== 'string' ||
    image.includes(pending) ||
    service?.sourceCommit !== '0f404200402f918a4b1596bc5c8a53479a435349' ||
    typeof service?.attestation !== 'string' ||
    service.attestation === pending
  ) {
    throw new Error('EIMG_BUILD_PENDING: candidate Electric digest, source commit, and attestation must be ready before an owned runtime proof');
  }
  if (!image.startsWith('ghcr.io/biginkc/inbox-electric:1.8.1-0f40420@sha256:')) {
    throw new Error(`Unexpected EIMG-7 Electric image: ${image}`);
  }
  return image;
}
