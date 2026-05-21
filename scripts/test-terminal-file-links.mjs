import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTerminalNavigationTargets,
  matchTerminalFileLinks,
} from '../dist/shared/terminalFileLinks.js';
import { buildReadableFilePathCandidates } from '../dist/main/file-path-resolution.js';

test('matchTerminalFileLinks keeps full absolute posix path with multi-dot extension', () => {
  const input = '/www/supportbox/supportbox/var/review/2026-05-06-0953-pze-sb-1329-ai-translate.diagram.md';
  assert.deepEqual(matchTerminalFileLinks(input), [input]);
});

test('matchTerminalFileLinks keeps full absolute mnt path', () => {
  const input = '/mnt/c/www/bridgegit/tmp/bridgegit-mermaid-simple.md';
  assert.deepEqual(matchTerminalFileLinks(input), [input]);
});

test('matchTerminalFileLinks keeps full relative multi-dot path', () => {
  const input = 'var/review/2026-05-06-0953-pze-sb-1329-ai-translate.diagram.md';
  assert.deepEqual(matchTerminalFileLinks(input), [input]);
});

test('matchTerminalFileLinks keeps full UNC path', () => {
  const input = '\\\\wsl.localhost\\Ubuntu\\www\\supportbox\\supportbox\\var\\review\\2026-05-06-0953-pze-sb-1329-ai-translate.diagram.md';
  assert.deepEqual(matchTerminalFileLinks(input), [input]);
});

test('matchTerminalFileLinks keeps line and column suffix on Windows path', () => {
  const input = 'C:\\www\\bridgegit\\tmp\\bridgegit-mermaid-simple.md:12:3';
  assert.deepEqual(matchTerminalFileLinks(input), [input]);
});

test('buildTerminalNavigationTargets resolves relative note path against cwd', () => {
  const input = 'var/review/2026-05-06-0953-pze-sb-1329-ai-translate.diagram.md';
  assert.deepEqual(
    buildTerminalNavigationTargets(input, {
      cwd: '/www/supportbox/supportbox',
      projectRoot: '/www/supportbox/supportbox',
    }),
    [
      {
        filePath: '/www/supportbox/supportbox/var/review/2026-05-06-0953-pze-sb-1329-ai-translate.diagram.md',
        line: undefined,
        column: undefined,
      },
    ],
  );
});

test('buildTerminalNavigationTargets resolves absolute note path unchanged', () => {
  const input = '/mnt/c/www/bridgegit/tmp/bridgegit-mermaid-simple.md';
  assert.deepEqual(
    buildTerminalNavigationTargets(input, {
      cwd: '/mnt/c/www/bridgegit',
      projectRoot: '/mnt/c/www/bridgegit',
    }),
    [
      {
        filePath: input,
        line: undefined,
        column: undefined,
      },
    ],
  );
});

test('buildTerminalNavigationTargets expands tilde using inferred home path', () => {
  const input = '~/notes/todo.md';
  assert.deepEqual(
    buildTerminalNavigationTargets(input, {
      cwd: '/home/otik/project',
      projectRoot: '/home/otik/project',
    }),
    [
      {
        filePath: '/home/otik/notes/todo.md',
        line: undefined,
        column: undefined,
      },
    ],
  );
});

test('buildReadableFilePathCandidates keeps WSL path variants on Windows-style UNC paths', () => {
  const input = '\\\\wsl.localhost\\Ubuntu\\www\\supportbox\\supportbox\\var\\review\\diagram.md';
  const candidates = buildReadableFilePathCandidates(input);

  assert.ok(candidates.includes(input));
  assert.ok(candidates.includes('/www/supportbox/supportbox/var/review/diagram.md'));
});

test('buildReadableFilePathCandidates maps Windows drive paths to /mnt when not on win32', () => {
  const input = 'C:\\www\\bridgegit\\tmp\\bridgegit-mermaid-simple.md';
  const candidates = buildReadableFilePathCandidates(input);

  assert.ok(candidates.includes(input));
  assert.ok(candidates.includes('/mnt/c/www/bridgegit/tmp/bridgegit-mermaid-simple.md'));
});
