import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionConfigSchema } from '../shared/protocol';
import { CallRejected } from './errors.js';
import {
  branchFieldOf,
  completionOptions,
  configString,
  currentBranchOf,
  effectiveConfig,
  isAbsoluteHostPath,
  sessionConfigFailure,
  sessionConfigOptions,
  sessionConfigPayload,
  targetFieldOf,
  workspaceProbeConfig,
} from './session-config.js';

const docsSchema: SessionConfigSchema = {
  type: 'object',
  properties: {
    target: { type: 'string', title: 'Target', enum: ['workspace', 'worktree'], enumLabels: ['Workspace', 'Worktree'] },
    baseBranch: {
      type: 'string', title: 'Base Branch', enum: ['main'], enumLabels: ['main'],
      enumDescriptions: ['Default branch'], enumDynamic: true,
    },
  },
  required: ['baseBranch'],
};

const vscodeSchema: SessionConfigSchema = {
  type: 'object',
  properties: {
    isolation: { type: 'string', title: 'Isolation', enum: ['folder', 'worktree'], enumLabels: ['Folder', 'Worktree'] },
    branch: { type: 'string', title: 'Branch', enum: ['main'], enumDynamic: true },
  },
};

test('target распознаётся в обоих наборах ключей и только при двух вариантах', () => {
  assert.deepEqual(targetFieldOf(docsSchema), {
    key: 'target', property: docsSchema.properties.target, workspaceValue: 'workspace', worktreeValue: 'worktree',
  });
  assert.deepEqual(targetFieldOf(vscodeSchema), {
    key: 'isolation', property: vscodeSchema.properties.isolation, workspaceValue: 'folder', worktreeValue: 'worktree',
  });
  // Не-git папка реального хоста: единственное readOnly-значение — это не выбор.
  const nonGit: SessionConfigSchema = {
    type: 'object',
    properties: { isolation: { type: 'string', title: 'Isolation', enum: ['folder'], readOnly: true } },
  };
  assert.equal(targetFieldOf(nonGit), undefined);
  assert.equal(targetFieldOf(undefined), undefined);
  assert.equal(targetFieldOf({ type: 'object', properties: {} }), undefined);
});

test('readOnly и required из схемы не теряются в разборе', () => {
  const schema: SessionConfigSchema = {
    type: 'object',
    properties: {
      isolation: { type: 'string', title: 'Isolation', enum: ['folder', 'worktree'], readOnly: true },
      branch: { type: 'string', title: 'Branch', readOnly: true },
    },
    required: ['branch'],
  };
  assert.equal(targetFieldOf(schema)?.property.readOnly, true);
  assert.equal(branchFieldOf(schema)?.property.readOnly, true);
  assert.deepEqual(schema.required, ['branch']);
});

test('поле ветки: baseBranch приоритетнее branch, dynamic из enumDynamic', () => {
  assert.equal(branchFieldOf(docsSchema)?.key, 'baseBranch');
  assert.equal(branchFieldOf(docsSchema)?.dynamic, true);
  assert.equal(branchFieldOf(vscodeSchema)?.key, 'branch');
  assert.equal(branchFieldOf(vscodeSchema)?.dynamic, true);
  assert.equal(branchFieldOf({ type: 'object', properties: { branch: { type: 'boolean', title: 'B' } } }), undefined);
  assert.equal(branchFieldOf(undefined), undefined);
});

test('значения enum разбираются с подписями и описаниями хоста', () => {
  assert.deepEqual(sessionConfigOptions(docsSchema.properties.baseBranch), [
    { value: 'main', label: 'main', description: 'Default branch' },
  ]);
  assert.deepEqual(sessionConfigOptions({
    type: 'string', title: 'T', enum: ['a', 7, null, 'b'], enumLabels: ['A', 'seven', 'nil', 'B'],
  }), [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]);
  assert.deepEqual(sessionConfigOptions({ type: 'string', title: 'T' }), []);
  assert.deepEqual(sessionConfigOptions(undefined), []);
  assert.deepEqual(completionOptions([
    { value: 'develop', label: 'develop', description: 'next' },
    { value: 'main', label: '' },
  ]), [{ value: 'develop', label: 'develop', description: 'next' }, { value: 'main', label: 'main' }]);
  assert.deepEqual(completionOptions(undefined), []);
});

test('текущая ветка берётся только из строки хоста; HEAD и пусто — неизвестна', () => {
  assert.equal(currentBranchOf(docsSchema, { target: 'workspace', baseBranch: 'feature/x' }), 'feature/x');
  assert.equal(currentBranchOf(vscodeSchema, { isolation: 'folder', branch: 'main' }), 'main');
  assert.equal(currentBranchOf(docsSchema, { baseBranch: 'HEAD' }), undefined);
  assert.equal(currentBranchOf(docsSchema, { baseBranch: '  ' }), undefined);
  assert.equal(currentBranchOf(docsSchema, { baseBranch: 42 }), undefined);
  assert.equal(currentBranchOf(docsSchema, {}), undefined);
  assert.equal(currentBranchOf(docsSchema, undefined), undefined);
  assert.equal(currentBranchOf(undefined, { branch: 'main' }), undefined);
  assert.equal(currentBranchOf({ type: 'object', properties: {} }, { branch: 'main' }), undefined);
});

test('probe запрашивает текущую папку и не подставляет ветку', () => {
  assert.deepEqual(workspaceProbeConfig(docsSchema), { target: 'workspace' });
  assert.deepEqual(workspaceProbeConfig(vscodeSchema), { isolation: 'folder' });
  assert.equal(workspaceProbeConfig({
    type: 'object', properties: { target: { type: 'string', title: 'Target', enum: ['workspace', 'worktree'] } },
  }), undefined);
  assert.equal(workspaceProbeConfig(undefined), undefined);
});

test('пользовательский выбор важнее defaults хоста', () => {
  assert.deepEqual(effectiveConfig({ target: 'workspace', baseBranch: 'main' }, { target: 'worktree' }), { target: 'worktree', baseBranch: 'main' });
  assert.deepEqual(effectiveConfig(undefined, { target: 'worktree' }), { target: 'worktree' });
  assert.equal(configString({ baseBranch: 'develop' }, 'baseBranch'), 'develop');
  assert.equal(configString({ baseBranch: 1 }, 'baseBranch'), undefined);
});

test('payload для createSession фильтруется схемой и не выдумывает значения', () => {
  assert.deepEqual(sessionConfigPayload(docsSchema, {
    target: 'worktree', baseBranch: '', stale: 'x', ignored: undefined,
  }), { target: 'worktree', baseBranch: '' });
  assert.deepEqual(sessionConfigPayload(docsSchema, { target: undefined, baseBranch: undefined }), undefined);
  assert.equal(sessionConfigPayload(undefined, { target: 'worktree' }), undefined);
  assert.equal(sessionConfigPayload({ type: 'object', properties: {} }, { target: 'worktree' }), undefined);
});

test('деградация: -32601 скрывает блок, остальные ошибки показываются текстом', () => {
  assert.deepEqual(sessionConfigFailure(new CallRejected({ message: 'Method not found: resolveSessionConfig', code: -32601 })), { hidden: true });
  assert.deepEqual(sessionConfigFailure(new CallRejected({ message: 'Хост занят', code: -32000 })), { hidden: false, text: 'Хост занят' });
  assert.deepEqual(sessionConfigFailure(new Error('сеть недоступна')), { hidden: false, text: 'сеть недоступна' });
  assert.deepEqual(sessionConfigFailure(new CallRejected({ message: 'Нет кода' })), { hidden: false, text: 'Нет кода' });
});

test('хост не вызывается для недописанного пути', () => {
  assert.equal(isAbsoluteHostPath('/Users/me/project'), true);
  assert.equal(isAbsoluteHostPath('  /srv/project  '), true);
  assert.equal(isAbsoluteHostPath('/'), true);
  assert.equal(isAbsoluteHostPath(''), false);
  assert.equal(isAbsoluteHostPath('Users/me'), false);
  assert.equal(isAbsoluteHostPath('file:///Users/me'), false);
});
