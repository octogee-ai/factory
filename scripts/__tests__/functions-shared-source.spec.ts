import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { materializeFunctionsSources } from '../ci/functions-source.mjs';

let root: string;
const write = (file: string, content: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'functions-shared-')));
  write('platform/shared/types/user.ts', 'export type User = { uid: string };\n');
  write('platform/shared/node_modules/left-pad/index.js', '');
  write('platform/shared/dist/types/user.js', 'export {};\n');
  write('product/shared/types/billing.ts', 'export type Plan = "free";\n');
  write('product/shared/node_modules/@octogee/shared/package.json', '{}');
  write('product/shared/dist/types/billing.js', 'export {};\n');
  write('functions/src/index.ts', 'export {};\n');
  symlinkSync('../../platform/shared', join(root, 'functions/src/_shared'));
  symlinkSync('../../product/shared', join(root, 'functions/src/_product_shared'));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

it('replaces each functions source symlink with a copy of the package it points at, built output included', () => {
  materializeFunctionsSources(root);
  const shared = join(root, 'functions/src/_shared');
  const productShared = join(root, 'functions/src/_product_shared');
  expect(lstatSync(shared).isDirectory()).toBe(true);
  expect(lstatSync(productShared).isDirectory()).toBe(true);
  expect(readFileSync(join(shared, 'types/user.ts'), 'utf8')).toBe('export type User = { uid: string };\n');
  expect(readFileSync(join(productShared, 'types/billing.ts'), 'utf8')).toBe('export type Plan = "free";\n');
  expect(existsSync(join(shared, 'dist/types/user.js'))).toBe(true);
  expect(existsSync(join(productShared, 'dist/types/billing.js'))).toBe(true);
  expect(existsSync(join(shared, 'node_modules'))).toBe(false);
  expect(existsSync(join(productShared, 'node_modules'))).toBe(false);
  expect(readFileSync(join(root, 'functions/src/index.ts'), 'utf8')).toBe('export {};\n');
  expect(existsSync(join(root, 'platform/shared/types/user.ts'))).toBe(true);
  expect(existsSync(join(root, 'product/shared/types/billing.ts'))).toBe(true);
});

it('copies the sources when the checkout itself sits under a node_modules directory', () => {
  const nested = join(root, 'node_modules', 'checkout');
  mkdirSync(nested, { recursive: true });
  for (const entry of ['platform', 'product', 'functions']) renameSync(join(root, entry), join(nested, entry));
  materializeFunctionsSources(nested);
  expect(existsSync(join(nested, 'functions/src/_shared/types/user.ts'))).toBe(true);
  expect(existsSync(join(nested, 'functions/src/_product_shared/types/billing.ts'))).toBe(true);
});

it('leaves an already materialized source directory alone', () => {
  rmSync(join(root, 'functions/src/_shared'));
  write('functions/src/_shared/types/user.ts', 'materialized\n');
  materializeFunctionsSources(root);
  expect(readFileSync(join(root, 'functions/src/_shared/types/user.ts'), 'utf8')).toBe('materialized\n');
  expect(lstatSync(join(root, 'functions/src/_product_shared')).isDirectory()).toBe(true);
});
