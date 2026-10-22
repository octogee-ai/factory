import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { recordBuilderNativeInitialState, builderNativeInitialStateMatches } from '../lib/builder-native-initial-state.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-native-initial-'));
  fs.mkdirSync(path.join(root, 'state'));
  fs.writeFileSync(path.join(root, 'state/openclaw.sqlite'), 'Native-created initial state');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
it('binds unchanged initialized host state to its exact pod', () => {
  recordBuilderNativeInitialState(root, 'pod-one');
  expect(builderNativeInitialStateMatches(root, 'pod-one')).toBe(true);
  expect(builderNativeInitialStateMatches(root, 'pod-two')).toBe(false);
  expect(builderNativeInitialStateMatches(root, undefined)).toBe(false);
});
it('refuses the baseline after any database mutation', () => {
  recordBuilderNativeInitialState(root, 'pod-one');
  fs.appendFileSync(path.join(root, 'state/openclaw.sqlite'), 'later writes');
  expect(builderNativeInitialStateMatches(root, 'pod-one')).toBe(false);
});
it.each(['openclaw.sqlite-wal', 'other-state'])('refuses extra state even if its database bytes are unchanged: %s', file => {
  recordBuilderNativeInitialState(root, 'pod-one');
  fs.writeFileSync(path.join(root, 'state', file), 'retained');
  expect(builderNativeInitialStateMatches(root, 'pod-one')).toBe(false);
});
it('refuses a linked database and preserves its target', () => {
  recordBuilderNativeInitialState(root, 'pod-one');
  fs.renameSync(path.join(root, 'state/openclaw.sqlite'), path.join(root, 'outside'));
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'state/openclaw.sqlite'));
  expect(builderNativeInitialStateMatches(root, 'pod-one')).toBe(false);
  expect(fs.readFileSync(path.join(root, 'outside'), 'utf8')).toBe('Native-created initial state');
});
it('does not infer an initialized baseline without a matching record', () => {
  expect(builderNativeInitialStateMatches(root, 'pod-one')).toBe(false);
  recordBuilderNativeInitialState(root, undefined);
  expect(builderNativeInitialStateMatches(root, 'pod-one')).toBe(false);
});

it('records the Native clean-close seal and refuses any later seal change', () => {
  fs.writeFileSync(path.join(root, 'state/openclaw.sqlite.seal'), 'Native clean-close seal');
  recordBuilderNativeInitialState(root, 'pod-one');
  expect(builderNativeInitialStateMatches(root, 'pod-one')).toBe(true);
  fs.appendFileSync(path.join(root, 'state/openclaw.sqlite.seal'), 'changed');
  expect(builderNativeInitialStateMatches(root, 'pod-one')).toBe(false);
});
it('binds the baseline to its original canonical state directory', () => {
  recordBuilderNativeInitialState(root, 'pod-one');
  const moved = root + '-moved';
  fs.renameSync(root, moved);
  fs.symlinkSync(moved, root);
  try { expect(builderNativeInitialStateMatches(root, 'pod-one')).toBe(false); }
  finally { fs.unlinkSync(root); fs.renameSync(moved, root); }
});
it.each(['openclaw.sqlite-wal', 'openclaw.sqlite-journal', 'openclaw-quarantine.sqlite'])('never records an unsafe fresh-state family: %s', file => {
  fs.writeFileSync(path.join(root, 'state', file), 'retained changes');
  expect(() => recordBuilderNativeInitialState(root, 'pod-one')).toThrow('closed and canonical');
});
it('records a closed database family including empty sidecars and shared memory', () => {
  for (const file of ['openclaw.sqlite-wal', 'openclaw.sqlite-journal']) fs.writeFileSync(path.join(root, 'state', file), '');
  fs.writeFileSync(path.join(root, 'state/openclaw.sqlite-shm'), 'shared memory');
  recordBuilderNativeInitialState(root, 'pod-one');
  expect(builderNativeInitialStateMatches(root, 'pod-one')).toBe(true);
  fs.appendFileSync(path.join(root, 'state/openclaw.sqlite-shm'), 'changed');
  expect(builderNativeInitialStateMatches(root, 'pod-one')).toBe(false);
});

it('binds fresh client credentials and refuses later identities before replacing unused state', () => {
  fs.mkdirSync(path.join(root, 'client'));
  fs.writeFileSync(path.join(root, 'client/credentials.sqlite'), 'Native-created client companion');
  recordBuilderNativeInitialState(root, 'pod-one');
  expect(builderNativeInitialStateMatches(root, 'pod-one')).toBe(true);
  fs.appendFileSync(path.join(root, 'client/credentials.sqlite'), 'paired device');
  expect(builderNativeInitialStateMatches(root, 'pod-one')).toBe(false);
});
it('refuses a client companion created after initial state was recorded', () => {
  recordBuilderNativeInitialState(root, 'pod-one');
  fs.mkdirSync(path.join(root, 'client'));
  fs.writeFileSync(path.join(root, 'client/credentials.sqlite'), 'later credentials');
  expect(builderNativeInitialStateMatches(root, 'pod-one')).toBe(false);
});

it('refuses a linked client directory and retains its credentials', () => {
  fs.mkdirSync(path.join(root, 'external-client'));
  fs.writeFileSync(path.join(root, 'external-client/credentials.sqlite'), 'retained credentials');
  fs.symlinkSync(path.join(root, 'external-client'), path.join(root, 'client'));
  expect(() => recordBuilderNativeInitialState(root, 'pod-one')).toThrow('closed and canonical');
  expect(fs.readFileSync(path.join(root, 'external-client/credentials.sqlite'), 'utf8')).toBe('retained credentials');
});
it('refuses a client companion with a nonempty transaction journal', () => {
  fs.mkdirSync(path.join(root, 'client'));
  fs.writeFileSync(path.join(root, 'client/credentials.sqlite'), 'Native-created client companion');
  fs.writeFileSync(path.join(root, 'client/credentials.sqlite-wal'), 'uncheckpointed credentials');
  expect(() => recordBuilderNativeInitialState(root, 'pod-one')).toThrow('closed and canonical');
});
