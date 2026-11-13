import { cpSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const BUILD_OUTPUTS = ['node_modules', 'dist'];

export function materializeFunctionsShared(root) {
  const link = join(root, 'functions/src/_shared');
  if (!lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) return;
  const source = realpathSync(link);
  rmSync(link);
  cpSync(source, link, {
    recursive: true, dereference: true,
    filter: path => !relative(source, path).split(sep).some(segment => BUILD_OUTPUTS.includes(segment)),
  });
}
