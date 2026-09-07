const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const NAME = /^[a-z][a-z0-9-]{0,62}$/;

export function validateDesktopImage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('desktop image artifact is required');
  if (['project', 'name', 'id', 'sourceSha', 'inputFingerprint'].some(key => typeof value[key] !== 'string')) throw new Error('desktop image fields must be strings');
  if (!NAME.test(value.project) || !NAME.test(value.name) || !/^\d+$/.test(value.id)) throw new Error('desktop image identity is invalid');
  if (!SHA.test(value.sourceSha) || !HASH.test(value.inputFingerprint)) throw new Error('desktop image provenance is invalid');
  if (value.acceptance !== 'resize-reboot-v1') throw new Error('desktop image acceptance is missing');
  return { project: value.project, name: value.name, id: value.id, sourceSha: value.sourceSha, inputFingerprint: value.inputFingerprint, acceptance: value.acceptance };
}

export function assertDesktopImageIdentity(artifact, image) {
  const validated = validateDesktopImage(artifact);
  if (image?.status !== 'READY' || image.name !== validated.name || image.id !== validated.id || image.labels?.source !== validated.sourceSha) throw new Error('desktop image no longer matches the tested artifact');
  return validated;
}
