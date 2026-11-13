import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { materializeFunctionsShared } from '../ci/functions-source.mjs';

let root: string;
const write = (file: string, content: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'functions-shared-')));
  write('platform/shared/types/user.ts', 'export type User = { uid: string };\n');
  write('platform/shared/node_modules/left-pad/index.js', '');
  write('platform/shared/dist/types/user.js', '');
  mkdirSync(join(root, 'functions/src'), { recursive: true });
  symlinkSync('../../platform/shared', join(root, 'functions/src/_shared'));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

it('replaces the functions shared symlink with a copy of the sources it points at', () => {
  materializeFunctionsShared(root);
  const shared = join(root, 'functions/src/_shared');
  expect(lstatSync(shared).isDirectory()).toBe(true);
  expect(readFileSync(join(shared, 'types/user.ts'), 'utf8')).toBe('export type User = { uid: string };\n');
  expect(existsSync(join(shared, 'node_modules'))).toBe(false);
  expect(existsSync(join(shared, 'dist'))).toBe(false);
  expect(existsSync(join(root, 'platform/shared/types/user.ts'))).toBe(true);
});

it('copies the sources when the checkout itself sits under a dist directory', () => {
  const nested = join(root, 'dist', 'checkout');
  mkdirSync(nested, { recursive: true });
  for (const entry of ['platform', 'functions']) renameSync(join(root, entry), join(nested, entry));
  materializeFunctionsShared(nested);
  expect(existsSync(join(nested, 'functions/src/_shared/types/user.ts'))).toBe(true);
});

it('leaves an already materialized shared directory alone', () => {
  rmSync(join(root, 'functions/src/_shared'));
  write('functions/src/_shared/types/user.ts', 'materialized\n');
  materializeFunctionsShared(root);
  expect(readFileSync(join(root, 'functions/src/_shared/types/user.ts'), 'utf8')).toBe('materialized\n');
});
