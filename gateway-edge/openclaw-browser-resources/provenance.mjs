import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const GENERATOR_INPUTS = ['gateway-edge/openclaw-browser-resources/build.mjs', 'gateway-edge/openclaw-browser-resources/provenance.mjs'];

export function inputLabel(file, source, root) {
  const absolute = path.resolve(file);
  if (absolute.startsWith(`${source}${path.sep}`)) return `openclaw/${path.relative(source, absolute)}`;
  if (absolute.startsWith(`${root}${path.sep}`)) return path.relative(root, absolute);
  throw new Error(`Input is outside the OpenClaw checkout and this repository: ${file}`);
}

export function stableSource(text, inputs, source, root) {
  const comments = new Map();
  for (const input of Object.keys(inputs)) {
    if (!input.includes(':')) comments.set(`// ${input}`, `// ${inputLabel(input, source, root)}`);
  }
  return text.split('\n').map(line => comments.get(line) ?? line).join('\n');
}

export function generatorInputs(labels) {
  return [...new Set([...labels.filter(label => !label.startsWith('openclaw/')), ...GENERATOR_INPUTS])].sort();
}

export async function inputsDigest(root, files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    if (path.isAbsolute(file) || file.startsWith('openclaw/') || path.normalize(file).startsWith('..')) {
      throw new Error(`Not a generator input in this repository: ${file}`);
    }
    hash.update(`${file}\0`);
    hash.update(await readFile(path.join(root, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}
