import { cpSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const FUNCTIONS_SOURCES = 'functions/src';
const INSTALLED = 'node_modules';

export function materializeFunctionsSources(root) {
  const sources = join(root, FUNCTIONS_SOURCES);
  for (const entry of readdirSync(sources, { withFileTypes: true }).filter(entry => entry.isSymbolicLink())) {
    const link = join(sources, entry.name);
    const source = realpathSync(link);
    rmSync(link);
    cpSync(source, link, {
      recursive: true, dereference: true,
      filter: path => !relative(source, path).split(sep).includes(INSTALLED),
    });
  }
}
