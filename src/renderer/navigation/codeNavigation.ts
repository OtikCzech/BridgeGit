import {
  javascriptLanguage,
  jsxLanguage,
  tsxLanguage,
  typescriptLanguage,
} from '@codemirror/lang-javascript';
import { phpLanguage } from '@codemirror/lang-php';
import type { SyntaxNode, Tree } from '@lezer/common';
import type { CodeNavigationTarget, GitTextSearchMatch } from '../../shared/bridgegit';
import { getWorkspaceFileExtension } from '../../shared/bridgegit';

export interface NavigableFileHandle {
  path: string;
  content: string;
  lastModifiedMs: number;
  size: number;
}

export interface CodeNavigationHit {
  from: number;
  to: number;
  target: CodeNavigationTarget;
}

export interface CodeNavigationResolution extends CodeNavigationHit {
  kind: 'path' | 'definition' | 'navigation';
  name?: string;
}

export interface CodeNavigationSymbol {
  name: string;
  from: number;
  to: number;
}

export interface ResolveCodeNavigationContext {
  filePath: string;
  projectRoot: string | null;
  content: string;
  offset: number;
  inspectFile: (filePath: string) => Promise<NavigableFileHandle | null>;
}

type ImportBinding =
  | {
      language: 'javascript';
      source: string;
      importedName: string | 'default' | '*';
    }
  | {
      language: 'python';
      moduleName: string;
      importedName: string | null;
    }
  | {
      language: 'php';
      fullyQualifiedName: string;
    };

interface IndexedNavigationFile {
  signature: string;
  localDefinitions: Map<string, IndexedDefinition>;
  exportedDefinitions: Map<string, CodeNavigationTarget>;
  importedBindings: Map<string, ImportBinding>;
  defaultExportTarget: CodeNavigationTarget | null;
}

interface IndexedDefinition {
  target: CodeNavigationTarget;
  from: number;
  to: number;
}

interface ParsedComposerAutoload {
  signature: string;
  namespacePaths: Array<{ prefix: string; paths: string[] }>;
}

interface JavaScriptSourceSegment {
  content: string;
  offset: number;
  language: 'javascript' | 'jsx' | 'typescript' | 'tsx';
}

interface ParsedJavaScriptSourceSegment extends JavaScriptSourceSegment {
  tree: Tree;
}

interface CachedJavaScriptSyntaxFile {
  signature: string;
  normalizedContent: string;
  segments: ParsedJavaScriptSourceSegment[];
}

interface CachedPhpSyntaxFile {
  signature: string;
  normalizedContent: string;
  tree: Tree;
}

interface CachedPythonSyntaxFile {
  signature: string;
  normalizedContent: string;
  excludedRanges: Array<{ from: number; to: number }>;
}

const FILE_PATH_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.vue',
  '.json', '.jsonc',
  '.css', '.scss', '.sass', '.less',
  '.html', '.htm',
  '.yaml', '.yml',
  '.php', '.sql',
  '.xml', '.svg',
  '.sh', '.bash', '.zsh',
  '.ps1', '.psm1',
  '.py',
  '.md', '.markdown', '.txt',
];

const JAVASCRIPT_EXTENSIONS = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'vue']);
const PYTHON_EXTENSIONS = new Set(['py']);
const PHP_EXTENSIONS = new Set(['php']);
const identifierPartPattern = /[A-Za-z0-9_$\u00A0-\uFFFF]/;
const identifierStartPattern = /[A-Za-z_$\u00A0-\uFFFF]/;
const fileIndexCache = new Map<string, IndexedNavigationFile>();
const resolvedFilePathCache = new Map<string, string | null>();
const composerAutoloadCache = new Map<string, ParsedComposerAutoload | null>();
const javaScriptSyntaxCache = new Map<string, CachedJavaScriptSyntaxFile>();
const phpSyntaxCache = new Map<string, CachedPhpSyntaxFile>();
const pythonSyntaxCache = new Map<string, CachedPythonSyntaxFile>();
const NON_REFERENCE_NODE_NAMES = new Set([
  'BlockComment',
  'LineComment',
  'RegExp',
  'String',
  'TemplateString',
]);
const REFERENCE_NODE_NAMES = new Set([
  'PropertyDefinition',
  'PropertyName',
  'TypeName',
  'VariableDefinition',
  'VariableName',
]);
const PHP_REFERENCE_NODE_NAMES = new Set([
  'Name',
]);
const JAVASCRIPT_TYPE_DECLARATION_NODE_NAMES = new Set([
  'EnumDeclaration',
  'InterfaceDeclaration',
  'NamespaceDeclaration',
  'TypeAliasDeclaration',
]);
const JAVASCRIPT_FUNCTION_PROPERTY_VALUE_NODE_NAMES = new Set([
  'ArrowFunction',
  'FunctionExpression',
]);

export async function resolveCodeNavigationResolutionAtOffset(
  context: ResolveCodeNavigationContext,
): Promise<CodeNavigationResolution | null> {
  const quotedPathHit = await resolveQuotedPathHit(context);

  if (quotedPathHit) {
    return quotedPathHit;
  }

  const identifier = extractIdentifierAtOffset(context.content, context.offset);

  if (!identifier) {
    return null;
  }

  const currentIndex = await getIndexedNavigationFile({
    filePath: context.filePath,
    projectRoot: context.projectRoot,
    content: context.content,
    inspectFile: context.inspectFile,
  });

  if (!currentIndex) {
    return null;
  }

  const localDefinition = currentIndex.localDefinitions.get(identifier.name);

  if (localDefinition && identifier.from === localDefinition.from && identifier.to === localDefinition.to) {
    return {
      kind: 'definition',
      name: identifier.name,
      from: identifier.from,
      to: identifier.to,
      target: localDefinition.target,
    };
  }

  if (localDefinition) {
    return {
      kind: 'navigation',
      name: identifier.name,
      from: identifier.from,
      to: identifier.to,
      target: localDefinition.target,
    };
  }

  const importBinding = currentIndex.importedBindings.get(identifier.name);

  if (!importBinding) {
    return null;
  }

  const resolvedTarget = await resolveImportedBindingTarget(importBinding, context, identifier.name);

  if (!resolvedTarget) {
    return null;
  }

  return {
    kind: 'navigation',
    name: identifier.name,
    from: identifier.from,
    to: identifier.to,
    target: resolvedTarget,
  };
}

export async function resolveCodeNavigationAtOffset(
  context: ResolveCodeNavigationContext,
): Promise<CodeNavigationHit | null> {
  const resolution = await resolveCodeNavigationResolutionAtOffset(context);

  if (!resolution) {
    return null;
  }

  return {
    from: resolution.from,
    to: resolution.to,
    target: resolution.target,
  };
}

async function resolveQuotedPathHit(context: ResolveCodeNavigationContext): Promise<CodeNavigationResolution | null> {
  const quotedPathMatch = extractQuotedPathAtOffset(context.content, context.offset);

  if (!quotedPathMatch) {
    return null;
  }

  const resolvedFilePath = await resolveFilePathFromSpecifier(
    context.filePath,
    context.projectRoot,
    quotedPathMatch.target,
    context.inspectFile,
  );

  if (!resolvedFilePath) {
    return null;
  }

  return {
    kind: 'path',
    from: quotedPathMatch.from,
    to: quotedPathMatch.to,
    target: { filePath: resolvedFilePath },
  };
}

function extractQuotedPathAtOffset(content: string, offset: number) {
  const lineBounds = getLineBounds(content, offset);
  const lineText = content.slice(lineBounds.from, lineBounds.to);
  const lineOffset = offset - lineBounds.from;
  const quotedPathPattern = /(["'`])([^"'`\n]+)\1/g;

  for (const match of lineText.matchAll(quotedPathPattern)) {
    const quotedValue = match[2];
    const matchIndex = match.index ?? -1;

    if (matchIndex < 0) {
      continue;
    }

    const from = lineBounds.from + matchIndex + 1;
    const to = from + quotedValue.length;

    if (offset < from || offset >= to) {
      continue;
    }

    if (
      quotedValue.startsWith('./')
      || quotedValue.startsWith('../')
      || quotedValue.startsWith('/')
    ) {
      return {
        target: quotedValue,
        from,
        to,
      };
    }
  }

  return null;
}

function extractIdentifierAtOffset(content: string, offset: number) {
  if (!content.length || offset < 0 || offset > content.length) {
    return null;
  }

  let start = offset;
  let end = offset;

  if (start === content.length) {
    start -= 1;
    end -= 1;
  }

  const currentCharacter = content[start];
  const previousCharacter = content[start - 1];

  if (!identifierPartPattern.test(currentCharacter ?? '') && identifierPartPattern.test(previousCharacter ?? '')) {
    start -= 1;
    end -= 1;
  }

  while (start > 0 && identifierPartPattern.test(content[start - 1] ?? '')) {
    start -= 1;
  }

  while (end < content.length && identifierPartPattern.test(content[end] ?? '')) {
    end += 1;
  }

  const name = content.slice(start, end);

  if (!name || !identifierStartPattern.test(name[0] ?? '')) {
    return null;
  }

  return { name, from: start, to: end };
}

export function getCodeNavigationSymbolAtOffset(content: string, offset: number): CodeNavigationSymbol | null {
  return extractIdentifierAtOffset(content, offset);
}

export async function filterCodeReferenceSearchMatches(options: {
  matches: GitTextSearchMatch[];
  inspectFile: (filePath: string) => Promise<NavigableFileHandle | null>;
}): Promise<GitTextSearchMatch[]> {
  if (!options.matches.length) {
    return [];
  }

  const matchesByFile = new Map<string, GitTextSearchMatch[]>();

  for (const match of options.matches) {
    const fileMatches = matchesByFile.get(match.filePath);

    if (fileMatches) {
      fileMatches.push(match);
      continue;
    }

    matchesByFile.set(match.filePath, [match]);
  }

  const filteredMatches: GitTextSearchMatch[] = [];

  for (const [filePath, fileMatches] of matchesByFile) {
    const extension = getWorkspaceFileExtension(filePath);

    if (JAVASCRIPT_EXTENSIONS.has(extension)) {
      const parsedFile = await getParsedJavaScriptSyntaxFile(filePath, options.inspectFile);

      if (!parsedFile) {
        filteredMatches.push(...fileMatches);
        continue;
      }

      for (const match of fileMatches) {
        if (isJavaScriptReferenceMatch(parsedFile, match)) {
          filteredMatches.push(match);
        }
      }

      continue;
    }

    if (PHP_EXTENSIONS.has(extension)) {
      const parsedFile = await getParsedPhpSyntaxFile(filePath, options.inspectFile);

      if (!parsedFile) {
        filteredMatches.push(...fileMatches);
        continue;
      }

      for (const match of fileMatches) {
        if (isPhpReferenceMatch(parsedFile, match)) {
          filteredMatches.push(match);
        }
      }

      continue;
    }

    if (PYTHON_EXTENSIONS.has(extension)) {
      const parsedFile = await getParsedPythonSyntaxFile(filePath, options.inspectFile);

      if (!parsedFile) {
        filteredMatches.push(...fileMatches);
        continue;
      }

      for (const match of fileMatches) {
        if (isPythonReferenceMatch(parsedFile, match)) {
          filteredMatches.push(match);
        }
      }

      continue;
    }

    {
      filteredMatches.push(...fileMatches);
    }
  }

  return filteredMatches;
}

function getLineBounds(content: string, offset: number) {
  const clampedOffset = Math.max(0, Math.min(offset, content.length));
  const lineStart = content.lastIndexOf('\n', Math.max(0, clampedOffset - 1));
  const nextLineBreak = content.indexOf('\n', clampedOffset);

  return {
    from: lineStart < 0 ? 0 : lineStart + 1,
    to: nextLineBreak < 0 ? content.length : nextLineBreak,
  };
}

function normalizePathForComparison(pathValue: string) {
  return pathValue.replace(/\\/g, '/').replace(/\/+$/, '');
}

function normalizeResolvedPath(pathValue: string) {
  const normalizedPath = pathValue.replace(/\\/g, '/');
  const hasDrivePrefix = /^[A-Za-z]:/.test(normalizedPath);
  const hasRootPrefix = normalizedPath.startsWith('/');
  const prefix = hasDrivePrefix
    ? normalizedPath.slice(0, 2)
    : (hasRootPrefix ? '/' : '');
  const relativePath = hasDrivePrefix
    ? normalizedPath.slice(2)
    : (hasRootPrefix ? normalizedPath.slice(1) : normalizedPath);
  const segments = relativePath.split('/').filter(Boolean);
  const normalizedSegments: string[] = [];

  for (const segment of segments) {
    if (segment === '.') {
      continue;
    }

    if (segment === '..') {
      const previousSegment = normalizedSegments.at(-1);

      if (previousSegment && previousSegment !== '..') {
        normalizedSegments.pop();
        continue;
      }

      if (!prefix) {
        normalizedSegments.push(segment);
      }

      continue;
    }

    normalizedSegments.push(segment);
  }

  const joinedPath = normalizedSegments.join('/');

  if (prefix === '/') {
    return `/${joinedPath}`;
  }

  if (hasDrivePrefix) {
    return joinedPath ? `${prefix}/${joinedPath}` : `${prefix}/`;
  }

  return joinedPath;
}

function getPathDirectory(pathValue: string) {
  const normalizedPath = pathValue.replace(/\\/g, '/');
  const lastSlashIndex = normalizedPath.lastIndexOf('/');

  if (lastSlashIndex < 0) {
    return normalizedPath;
  }

  if (lastSlashIndex === 0) {
    return '/';
  }

  return normalizedPath.slice(0, lastSlashIndex);
}

function joinResolvedPath(basePath: string, relativePath: string) {
  return normalizeResolvedPath(`${basePath.replace(/\\/g, '/')}/${relativePath.replace(/\\/g, '/')}`);
}

function getPathExtension(pathValue: string) {
  const pathLeaf = pathValue.split('/').at(-1) ?? pathValue;
  const extensionIndex = pathLeaf.lastIndexOf('.');

  if (extensionIndex <= 0) {
    return '';
  }

  return pathLeaf.slice(extensionIndex);
}

async function resolveImportedBindingTarget(
  importBinding: ImportBinding,
  context: ResolveCodeNavigationContext,
  identifierName: string,
): Promise<CodeNavigationTarget | null> {
  if (importBinding.language === 'javascript') {
    const targetFilePath = await resolveFilePathFromSpecifier(
      context.filePath,
      context.projectRoot,
      importBinding.source,
      context.inspectFile,
    );

    if (!targetFilePath) {
      return null;
    }

    const targetIndex = await getIndexedNavigationFile({
      filePath: targetFilePath,
      projectRoot: context.projectRoot,
      inspectFile: context.inspectFile,
    });

    if (!targetIndex) {
      return { filePath: targetFilePath };
    }

    if (importBinding.importedName === '*') {
      return { filePath: targetFilePath };
    }

    if (importBinding.importedName === 'default') {
      return targetIndex.defaultExportTarget ?? { filePath: targetFilePath };
    }

    return (
      targetIndex.exportedDefinitions.get(importBinding.importedName)
      ?? targetIndex.localDefinitions.get(importBinding.importedName)?.target
      ?? { filePath: targetFilePath }
    );
  }

  if (importBinding.language === 'python') {
    const targetFilePath = await resolvePythonModulePath(
      context.projectRoot,
      importBinding.moduleName,
      context.inspectFile,
    );

    if (!targetFilePath) {
      return null;
    }

    if (!importBinding.importedName) {
      return { filePath: targetFilePath };
    }

    const targetIndex = await getIndexedNavigationFile({
      filePath: targetFilePath,
      projectRoot: context.projectRoot,
      inspectFile: context.inspectFile,
    });

    if (!targetIndex) {
      return { filePath: targetFilePath };
    }

    return (
      targetIndex.localDefinitions.get(importBinding.importedName)?.target
      ?? targetIndex.exportedDefinitions.get(importBinding.importedName)
      ?? { filePath: targetFilePath }
    );
  }

  const phpTargetFilePath = await resolvePhpClassPath(
    context.projectRoot,
    importBinding.fullyQualifiedName,
    context.inspectFile,
  );

  if (!phpTargetFilePath) {
    return null;
  }

  const targetIndex = await getIndexedNavigationFile({
    filePath: phpTargetFilePath,
    projectRoot: context.projectRoot,
    inspectFile: context.inspectFile,
  });
  const className = importBinding.fullyQualifiedName.split('\\').at(-1) ?? identifierName;

  return (
    targetIndex?.localDefinitions.get(className)?.target
    ?? { filePath: phpTargetFilePath }
  );
}

async function resolveFilePathFromSpecifier(
  currentFilePath: string,
  projectRoot: string | null,
  specifier: string,
  inspectFile: (filePath: string) => Promise<NavigableFileHandle | null>,
): Promise<string | null> {
  const cacheKey = `${currentFilePath}::${projectRoot ?? ''}::${specifier}`;

  if (resolvedFilePathCache.has(cacheKey)) {
    return resolvedFilePathCache.get(cacheKey) ?? null;
  }

  const targetBasePath = specifier.startsWith('/')
    ? (projectRoot ? normalizeResolvedPath(projectRoot) : null)
    : normalizeResolvedPath(getPathDirectory(currentFilePath));

  if (!targetBasePath) {
    resolvedFilePathCache.set(cacheKey, null);
    return null;
  }

  const relativeSpecifier = specifier.startsWith('/') ? specifier.slice(1) : specifier;
  const resolvedSpecifierPath = joinResolvedPath(targetBasePath, relativeSpecifier);
  const pathExtension = getPathExtension(resolvedSpecifierPath);
  const candidates = new Set<string>([resolvedSpecifierPath]);

  if (!pathExtension) {
    for (const extension of FILE_PATH_EXTENSIONS) {
      candidates.add(`${resolvedSpecifierPath}${extension}`);
      candidates.add(joinResolvedPath(resolvedSpecifierPath, `index${extension}`));
    }
  }

  for (const candidate of candidates) {
    const inspectedFile = await inspectFile(candidate);

    if (inspectedFile) {
      resolvedFilePathCache.set(cacheKey, candidate);
      return candidate;
    }
  }

  resolvedFilePathCache.set(cacheKey, null);
  return null;
}

async function resolvePythonModulePath(
  projectRoot: string | null,
  moduleName: string,
  inspectFile: (filePath: string) => Promise<NavigableFileHandle | null>,
): Promise<string | null> {
  if (!projectRoot) {
    return null;
  }

  const normalizedRoot = normalizeResolvedPath(projectRoot);
  const modulePath = moduleName.replace(/\./g, '/');
  const candidates = [
    joinResolvedPath(normalizedRoot, `${modulePath}.py`),
    joinResolvedPath(normalizedRoot, `${modulePath}/__init__.py`),
  ];

  for (const candidate of candidates) {
    const inspectedFile = await inspectFile(candidate);

    if (inspectedFile) {
      return candidate;
    }
  }

  return null;
}

async function resolvePhpClassPath(
  projectRoot: string | null,
  fullyQualifiedName: string,
  inspectFile: (filePath: string) => Promise<NavigableFileHandle | null>,
): Promise<string | null> {
  if (!projectRoot) {
    return null;
  }

  const composerAutoload = await getComposerAutoload(projectRoot, inspectFile);

  if (!composerAutoload?.namespacePaths.length) {
    return null;
  }

  const normalizedName = fullyQualifiedName.replace(/^\\+/, '');
  const bestMatch = composerAutoload.namespacePaths
    .filter((entry) => normalizedName.startsWith(entry.prefix))
    .sort((left, right) => right.prefix.length - left.prefix.length)
    .at(0);

  if (!bestMatch) {
    return null;
  }

  const relativeClassPath = normalizedName.slice(bestMatch.prefix.length).replace(/\\/g, '/');

  for (const basePath of bestMatch.paths) {
    const candidate = joinResolvedPath(basePath, `${relativeClassPath}.php`);
    const inspectedFile = await inspectFile(candidate);

    if (inspectedFile) {
      return candidate;
    }
  }

  return null;
}

async function getComposerAutoload(
  projectRoot: string,
  inspectFile: (filePath: string) => Promise<NavigableFileHandle | null>,
): Promise<ParsedComposerAutoload | null> {
  const composerPath = joinResolvedPath(normalizeResolvedPath(projectRoot), 'composer.json');
  const composerFile = await inspectFile(composerPath);

  if (!composerFile) {
    composerAutoloadCache.set(projectRoot, null);
    return null;
  }

  const signature = buildDiskFileSignature(composerFile);
  const cachedAutoload = composerAutoloadCache.get(projectRoot);

  if (cachedAutoload?.signature === signature) {
    return cachedAutoload;
  }

  try {
    const parsedComposer = JSON.parse(composerFile.content) as {
      autoload?: { 'psr-4'?: Record<string, string | string[]> };
      'autoload-dev'?: { 'psr-4'?: Record<string, string | string[]> };
    };
    const namespacePaths: Array<{ prefix: string; paths: string[] }> = [];

    for (const source of [parsedComposer.autoload?.['psr-4'], parsedComposer['autoload-dev']?.['psr-4']]) {
      for (const [prefix, rawPaths] of Object.entries(source ?? {})) {
        const normalizedPaths = (Array.isArray(rawPaths) ? rawPaths : [rawPaths])
          .map((pathEntry) => joinResolvedPath(normalizeResolvedPath(projectRoot), pathEntry))
          .filter(Boolean);

        if (normalizedPaths.length) {
          namespacePaths.push({ prefix, paths: normalizedPaths });
        }
      }
    }

    const nextAutoload = {
      signature,
      namespacePaths,
    };
    composerAutoloadCache.set(projectRoot, nextAutoload);
    return nextAutoload;
  } catch {
    composerAutoloadCache.set(projectRoot, null);
    return null;
  }
}

function buildCurrentContentSignature(content: string) {
  let hash = 0;

  for (let index = 0; index < content.length; index += 1) {
    hash = ((hash << 5) - hash + content.charCodeAt(index)) | 0;
  }

  return `memory:${content.length}:${hash}`;
}

function buildDiskFileSignature(fileHandle: NavigableFileHandle) {
  return `${Math.round(fileHandle.lastModifiedMs)}:${fileHandle.size}`;
}

async function getParsedJavaScriptSyntaxFile(
  filePath: string,
  inspectFile: (filePath: string) => Promise<NavigableFileHandle | null>,
): Promise<CachedJavaScriptSyntaxFile | null> {
  const inspectedFile = await inspectFile(filePath);

  if (!inspectedFile) {
    return null;
  }

  const signature = buildDiskFileSignature(inspectedFile);
  const cachedFile = javaScriptSyntaxCache.get(filePath);

  if (cachedFile?.signature === signature) {
    return cachedFile;
  }

  const normalizedContent = inspectedFile.content.replace(/\r\n/g, '\n');
  const segments = getJavaScriptSourceSegments(filePath, normalizedContent)
    .map((segment) => ({
      ...segment,
      tree: resolveJavaScriptParser(segment.language).parser.parse(segment.content),
    }));
  const nextCacheEntry = {
    signature,
    normalizedContent,
    segments,
  };

  javaScriptSyntaxCache.set(filePath, nextCacheEntry);
  return nextCacheEntry;
}

async function getParsedPhpSyntaxFile(
  filePath: string,
  inspectFile: (filePath: string) => Promise<NavigableFileHandle | null>,
): Promise<CachedPhpSyntaxFile | null> {
  const inspectedFile = await inspectFile(filePath);

  if (!inspectedFile) {
    return null;
  }

  const signature = buildDiskFileSignature(inspectedFile);
  const cachedFile = phpSyntaxCache.get(filePath);

  if (cachedFile?.signature === signature) {
    return cachedFile;
  }

  const normalizedContent = inspectedFile.content.replace(/\r\n/g, '\n');
  const nextCacheEntry = {
    signature,
    normalizedContent,
    tree: phpLanguage.parser.parse(normalizedContent),
  };

  phpSyntaxCache.set(filePath, nextCacheEntry);
  return nextCacheEntry;
}

async function getParsedPythonSyntaxFile(
  filePath: string,
  inspectFile: (filePath: string) => Promise<NavigableFileHandle | null>,
): Promise<CachedPythonSyntaxFile | null> {
  const inspectedFile = await inspectFile(filePath);

  if (!inspectedFile) {
    return null;
  }

  const signature = buildDiskFileSignature(inspectedFile);
  const cachedFile = pythonSyntaxCache.get(filePath);

  if (cachedFile?.signature === signature) {
    return cachedFile;
  }

  const normalizedContent = inspectedFile.content.replace(/\r\n/g, '\n');
  const nextCacheEntry = {
    signature,
    normalizedContent,
    excludedRanges: collectPythonExcludedRanges(normalizedContent),
  };

  pythonSyntaxCache.set(filePath, nextCacheEntry);
  return nextCacheEntry;
}

function isJavaScriptReferenceMatch(parsedFile: CachedJavaScriptSyntaxFile, match: GitTextSearchMatch) {
  const matchOffset = getOffsetFromLineColumn(parsedFile.normalizedContent, match.line, match.column);

  if (matchOffset === null) {
    return true;
  }

  const segment = parsedFile.segments.find((entry) => (
    matchOffset >= entry.offset && matchOffset < entry.offset + entry.content.length
  ));

  if (!segment) {
    return false;
  }

  const relativeOffset = matchOffset - segment.offset;
  const cursor = segment.tree.cursorAt(relativeOffset, 1);
  let hasReferenceNode = false;

  do {
    if (NON_REFERENCE_NODE_NAMES.has(cursor.name)) {
      return false;
    }

    if (REFERENCE_NODE_NAMES.has(cursor.name)) {
      hasReferenceNode = true;
    }
  } while (cursor.parent());

  return hasReferenceNode;
}

function isPhpReferenceMatch(parsedFile: CachedPhpSyntaxFile, match: GitTextSearchMatch) {
  const matchOffset = getOffsetFromLineColumn(parsedFile.normalizedContent, match.line, match.column);

  if (matchOffset === null) {
    return true;
  }

  const cursor = parsedFile.tree.cursorAt(matchOffset, 1);
  let hasReferenceNode = false;

  do {
    if (NON_REFERENCE_NODE_NAMES.has(cursor.name)) {
      return false;
    }

    if (PHP_REFERENCE_NODE_NAMES.has(cursor.name)) {
      hasReferenceNode = true;
    }
  } while (cursor.parent());

  return hasReferenceNode;
}

function isPythonReferenceMatch(parsedFile: CachedPythonSyntaxFile, match: GitTextSearchMatch) {
  const matchOffset = getOffsetFromLineColumn(parsedFile.normalizedContent, match.line, match.column);

  if (matchOffset === null) {
    return true;
  }

  if (parsedFile.excludedRanges.some((range) => matchOffset >= range.from && matchOffset < range.to)) {
    return false;
  }

  const identifier = extractIdentifierAtOffset(parsedFile.normalizedContent, matchOffset);

  return Boolean(identifier && identifier.from === matchOffset);
}

function collectPythonExcludedRanges(content: string) {
  const ranges: Array<{ from: number; to: number }> = [];
  let index = 0;

  while (index < content.length) {
    const currentCharacter = content[index] ?? '';

    if (currentCharacter === '#') {
      const lineEnd = content.indexOf('\n', index);
      const to = lineEnd < 0 ? content.length : lineEnd;
      ranges.push({ from: index, to });
      index = to;
      continue;
    }

    if (currentCharacter === '\'' || currentCharacter === '"') {
      const quote = currentCharacter;
      const isTriple = content[index + 1] === quote && content[index + 2] === quote;
      let cursor = index + (isTriple ? 3 : 1);

      while (cursor < content.length) {
        if (isTriple) {
          if (content[cursor] === quote && content[cursor + 1] === quote && content[cursor + 2] === quote) {
            cursor += 3;
            break;
          }

          cursor += 1;
          continue;
        }

        if (content[cursor] === '\\') {
          cursor += 2;
          continue;
        }

        if (content[cursor] === quote) {
          cursor += 1;
          break;
        }

        cursor += 1;
      }

      ranges.push({ from: index, to: Math.min(cursor, content.length) });
      index = Math.max(cursor, index + 1);
      continue;
    }

    index += 1;
  }

  return ranges;
}

function getOffsetFromLineColumn(content: string, line: number, column: number) {
  if (line < 1 || column < 1) {
    return null;
  }

  let lineNumber = 1;
  let lineStart = 0;

  while (lineNumber < line) {
    const lineBreak = content.indexOf('\n', lineStart);

    if (lineBreak < 0) {
      return null;
    }

    lineStart = lineBreak + 1;
    lineNumber += 1;
  }

  return Math.min(content.length, lineStart + column - 1);
}

async function getIndexedNavigationFile(options: {
  filePath: string;
  projectRoot: string | null;
  content?: string;
  inspectFile: (filePath: string) => Promise<NavigableFileHandle | null>;
}): Promise<IndexedNavigationFile | null> {
  const inspectedFile = options.content === undefined
    ? await options.inspectFile(options.filePath)
    : null;
  const fileContent = options.content ?? inspectedFile?.content;

  if (fileContent === undefined) {
    return null;
  }

  const signature = options.content === undefined
    ? buildDiskFileSignature(inspectedFile as NavigableFileHandle)
    : buildCurrentContentSignature(fileContent);
  const cachedIndex = fileIndexCache.get(options.filePath);

  if (cachedIndex?.signature === signature) {
    return cachedIndex;
  }

  const extension = getWorkspaceFileExtension(options.filePath);
  const nextIndex = JAVASCRIPT_EXTENSIONS.has(extension)
    ? buildJavaScriptIndex(options.filePath, fileContent)
    : PYTHON_EXTENSIONS.has(extension)
      ? buildPythonIndex(options.filePath, fileContent)
      : PHP_EXTENSIONS.has(extension)
        ? buildPhpIndex(options.filePath, fileContent)
        : buildEmptyIndex();

  nextIndex.signature = signature;
  fileIndexCache.set(options.filePath, nextIndex);
  return nextIndex;
}

function buildEmptyIndex(): IndexedNavigationFile {
  return {
    signature: '',
    localDefinitions: new Map<string, IndexedDefinition>(),
    exportedDefinitions: new Map<string, CodeNavigationTarget>(),
    importedBindings: new Map<string, ImportBinding>(),
    defaultExportTarget: null,
  };
}

function buildJavaScriptIndex(filePath: string, content: string): IndexedNavigationFile {
  const index = buildEmptyIndex();

  recordRegexDefinitions(
    content,
    /(?:^|\n)\s*(export\s+default\s+|export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
    filePath,
    index,
    (match) => ({
      exported: Boolean(match[1]),
      defaultExport: Boolean(match[1]?.includes('default')),
      name: match[2],
      nameOffset: match[0].lastIndexOf(match[2]),
    }),
  );
  recordRegexDefinitions(
    content,
    /(?:^|\n)\s*(export\s+default\s+|export\s+)?class\s+([A-Za-z_$][\w$]*)\b/g,
    filePath,
    index,
    (match) => ({
      exported: Boolean(match[1]),
      defaultExport: Boolean(match[1]?.includes('default')),
      name: match[2],
      nameOffset: match[0].lastIndexOf(match[2]),
    }),
  );
  recordRegexDefinitions(
    content,
    /(?:^|\n)\s*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g,
    filePath,
    index,
    (match) => ({
      exported: Boolean(match[1]),
      defaultExport: false,
      name: match[2],
      nameOffset: match[0].lastIndexOf(match[2]),
    }),
  );

  for (const match of content.matchAll(/(?:^|\n)\s*export\s+default\b/g)) {
    const matchIndex = match.index ?? -1;

    if (matchIndex < 0) {
      continue;
    }

    index.defaultExportTarget = buildNavigationTarget(filePath, content, matchIndex + match[0].indexOf('export'));
  }

  for (const match of content.matchAll(/(?:^|\n)\s*export\s*\{\s*([^}]+)\s*\}/g)) {
    const matchIndex = match.index ?? -1;
    const rawSpecifiers = match[1] ?? '';

    if (matchIndex < 0 || !rawSpecifiers.trim()) {
      continue;
    }

    for (const specifier of rawSpecifiers.split(',')) {
      const normalizedSpecifier = specifier.trim().replace(/\btype\s+/g, '');

      if (!normalizedSpecifier) {
        continue;
      }

      const [localNamePart, exportedNamePart] = normalizedSpecifier.split(/\s+as\s+/i).map((value) => value.trim());
      const localName = localNamePart;
      const exportedName = exportedNamePart || localName;
      const fallbackOffset = matchIndex + match[0].indexOf(localName);
      const exportedTarget = index.localDefinitions.get(localName)?.target
        ?? buildNavigationTarget(filePath, content, Math.max(matchIndex, fallbackOffset));

      index.exportedDefinitions.set(exportedName, exportedTarget);

      if (localName === 'default') {
        index.defaultExportTarget = exportedTarget;
      }
    }
  }

  for (const match of content.matchAll(/(?:^|\n)\s*import\s+([\s\S]*?)\s+from\s+(['"`])([^'"`\n]+)\2/g)) {
    const importClause = (match[1] ?? '').trim();
    const importSource = match[3] ?? '';

    for (const [localName, binding] of parseJavaScriptImportClause(importClause, importSource)) {
      index.importedBindings.set(localName, binding);
    }
  }

  for (const match of content.matchAll(/(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*(['"`])([^'"`\n]+)\2\s*\)/g)) {
    const localName = match[1] ?? '';
    const importSource = match[3] ?? '';

    if (localName && importSource) {
      index.importedBindings.set(localName, {
        language: 'javascript',
        source: importSource,
        importedName: 'default',
      });
    }
  }

  recordJavaScriptParserDefinitions(filePath, content, index);

  return index;
}

function recordJavaScriptParserDefinitions(filePath: string, content: string, index: IndexedNavigationFile) {
  const sourceSegments = getJavaScriptSourceSegments(filePath, content);

  for (const segment of sourceSegments) {
    const parser = resolveJavaScriptParser(segment.language);
    const tree = parser.parser.parse(segment.content);
    const cursor = tree.cursor();

    do {
      if (JAVASCRIPT_TYPE_DECLARATION_NODE_NAMES.has(cursor.name)) {
        recordJavaScriptTypeDeclaration(filePath, content, index, segment, cursor.node);
        continue;
      }

      if (cursor.name !== 'PropertyDefinition') {
        continue;
      }

      const node = cursor.node;
      const propertyDefinition = resolveJavaScriptPropertyDefinition(node);

      if (!propertyDefinition) {
        continue;
      }

      const definitionName = segment.content.slice(cursor.from, cursor.to).trim();

      if (!definitionName || !identifierStartPattern.test(definitionName[0] ?? '')) {
        continue;
      }

      const definitionFrom = segment.offset + cursor.from;
      const definitionTo = segment.offset + cursor.to;

      recordIndexedDefinition(
        filePath,
        content,
        index,
        definitionName,
        definitionFrom,
        definitionTo,
      );
    } while (cursor.next());
  }
}

function resolveJavaScriptPropertyDefinition(node: SyntaxNode) {
  const parentNode = node.parent;

  if (!parentNode) {
    return null;
  }

  const parentName = parentNode.name;
  const grandparentName = parentNode.parent?.name;

  if (parentName === 'ClassBody' || (parentName === 'MethodDeclaration' && grandparentName === 'ClassBody')) {
    return node;
  }

  if (parentName !== 'Property' || grandparentName !== 'ObjectExpression') {
    return null;
  }

  let hasFunctionValue = false;

  for (let child = parentNode.firstChild; child; child = child.nextSibling) {
    if (child.name === 'ParamList') {
      return node;
    }

    if (JAVASCRIPT_FUNCTION_PROPERTY_VALUE_NODE_NAMES.has(child.name)) {
      hasFunctionValue = true;
    }
  }

  return hasFunctionValue ? node : null;
}

function recordJavaScriptTypeDeclaration(
  filePath: string,
  content: string,
  index: IndexedNavigationFile,
  segment: JavaScriptSourceSegment,
  node: SyntaxNode,
) {
  const nameNode = resolveJavaScriptTypeDefinitionNode(node);

  if (!nameNode) {
    return;
  }

  const definitionName = segment.content.slice(nameNode.from, nameNode.to).trim();

  if (!definitionName || !identifierStartPattern.test(definitionName[0] ?? '')) {
    return;
  }

  const definitionFrom = segment.offset + nameNode.from;
  const definitionTo = segment.offset + nameNode.to;

  recordIndexedDefinition(
    filePath,
    content,
    index,
    definitionName,
    definitionFrom,
    definitionTo,
  );

  if (isTopLevelExportDeclarationNode(node)) {
    const target = index.localDefinitions.get(definitionName)?.target
      ?? buildNavigationTarget(filePath, content, definitionFrom);

    index.exportedDefinitions.set(definitionName, target);

    const exportNodeText = segment.content.slice(node.parent?.from ?? node.from, node.parent?.to ?? node.to);

    if (/^\s*export\s+default\b/.test(exportNodeText)) {
      index.defaultExportTarget = target;
    }
  }
}

function resolveJavaScriptTypeDefinitionNode(node: SyntaxNode) {
  if (node.name === 'NamespaceDeclaration') {
    return node.getChild('VariableDefinition') ?? node.getChild('TypeDefinition');
  }

  return node.getChild('TypeDefinition') ?? node.getChild('VariableDefinition');
}

function isTopLevelExportDeclarationNode(node: SyntaxNode) {
  return node.parent?.name === 'ExportDeclaration' && node.parent.parent?.name === 'Script';
}

function getJavaScriptSourceSegments(filePath: string, content: string): JavaScriptSourceSegment[] {
  if (getWorkspaceFileExtension(filePath) !== 'vue') {
    return [{
      content,
      offset: 0,
      language: resolveJavaScriptSegmentLanguage(getWorkspaceFileExtension(filePath), null),
    }];
  }

  const segments: JavaScriptSourceSegment[] = [];
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

  for (const match of content.matchAll(scriptPattern)) {
    const fullMatch = match[0] ?? '';
    const attributes = match[1] ?? '';
    const matchIndex = match.index ?? -1;
    const openTagEnd = fullMatch.indexOf('>');
    const closeTagStart = fullMatch.lastIndexOf('</script>');

    if (matchIndex < 0 || openTagEnd < 0 || closeTagStart < openTagEnd) {
      continue;
    }

    if (/\bsrc\s*=/.test(attributes)) {
      continue;
    }

    const body = fullMatch.slice(openTagEnd + 1, closeTagStart);

    if (!body.trim()) {
      continue;
    }

    const languageMatch = attributes.match(/\blang\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
    const languageHint = languageMatch?.[1] ?? languageMatch?.[2] ?? languageMatch?.[3] ?? null;

    segments.push({
      content: body,
      offset: matchIndex + openTagEnd + 1,
      language: resolveJavaScriptSegmentLanguage('vue', languageHint),
    });
  }

  return segments;
}

function resolveJavaScriptSegmentLanguage(
  extension: string,
  languageHint: string | null,
): JavaScriptSourceSegment['language'] {
  const normalizedHint = languageHint?.trim().toLowerCase() ?? '';

  if (normalizedHint === 'tsx') {
    return 'tsx';
  }

  if (normalizedHint === 'ts') {
    return 'typescript';
  }

  if (normalizedHint === 'jsx') {
    return 'jsx';
  }

  switch (extension) {
    case 'tsx':
      return 'tsx';
    case 'ts':
      return 'typescript';
    case 'jsx':
      return 'jsx';
    default:
      return 'javascript';
  }
}

function resolveJavaScriptParser(language: JavaScriptSourceSegment['language']) {
  switch (language) {
    case 'tsx':
      return tsxLanguage;
    case 'typescript':
      return typescriptLanguage;
    case 'jsx':
      return jsxLanguage;
    default:
      return javascriptLanguage;
  }
}

function parseJavaScriptImportClause(importClause: string, importSource: string) {
  const bindings = new Map<string, ImportBinding>();
  const normalizedClause = importClause.replace(/\btype\b/g, ' ').replace(/\s+/g, ' ').trim();

  if (!normalizedClause) {
    return bindings;
  }

  const namedBlockMatch = normalizedClause.match(/\{([^}]+)\}/);
  const namespaceMatch = normalizedClause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  const defaultPrefix = namedBlockMatch
    ? normalizedClause.slice(0, namedBlockMatch.index).replace(/,$/, '').trim()
    : namespaceMatch
      ? normalizedClause.slice(0, namespaceMatch.index).replace(/,$/, '').trim()
      : normalizedClause;

  if (defaultPrefix && !defaultPrefix.startsWith('{') && !defaultPrefix.startsWith('*')) {
    bindings.set(defaultPrefix, {
      language: 'javascript',
      source: importSource,
      importedName: 'default',
    });
  }

  if (namespaceMatch?.[1]) {
    bindings.set(namespaceMatch[1], {
      language: 'javascript',
      source: importSource,
      importedName: '*',
    });
  }

  if (namedBlockMatch?.[1]) {
    for (const namedSpecifier of namedBlockMatch[1].split(',')) {
      const normalizedSpecifier = namedSpecifier.trim();

      if (!normalizedSpecifier) {
        continue;
      }

      const [importedNamePart, localNamePart] = normalizedSpecifier.split(/\s+as\s+/i).map((value) => value.trim());
      const importedName = importedNamePart;
      const localName = localNamePart || importedNamePart;

      if (!importedName || !localName) {
        continue;
      }

      bindings.set(localName, {
        language: 'javascript',
        source: importSource,
        importedName,
      });
    }
  }

  return bindings;
}

function buildPythonIndex(filePath: string, content: string): IndexedNavigationFile {
  const index = buildEmptyIndex();

  recordRegexDefinitions(
    content,
    /(?:^|\n)\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/g,
    filePath,
    index,
    (match) => ({
      exported: true,
      defaultExport: false,
      name: match[1],
      nameOffset: match[0].lastIndexOf(match[1]),
    }),
  );
  recordRegexDefinitions(
    content,
    /(?:^|\n)\s*class\s+([A-Za-z_][\w]*)\b/g,
    filePath,
    index,
    (match) => ({
      exported: true,
      defaultExport: false,
      name: match[1],
      nameOffset: match[0].lastIndexOf(match[1]),
    }),
  );

  for (const match of content.matchAll(/(?:^|\n)\s*from\s+([A-Za-z_][\w.]*)\s+import\s+([^\n#]+)/g)) {
    const moduleName = match[1] ?? '';
    const importedNames = match[2] ?? '';

    for (const specifier of importedNames.split(',')) {
      const normalizedSpecifier = specifier.trim();

      if (!normalizedSpecifier) {
        continue;
      }

      const [importedNamePart, localNamePart] = normalizedSpecifier.split(/\s+as\s+/i).map((value) => value.trim());
      const importedName = importedNamePart;
      const localName = localNamePart || importedNamePart;

      if (!importedName || !localName) {
        continue;
      }

      index.importedBindings.set(localName, {
        language: 'python',
        moduleName,
        importedName,
      });
    }
  }

  for (const match of content.matchAll(/(?:^|\n)\s*import\s+([^\n#]+)/g)) {
    const importedModules = match[1] ?? '';

    for (const specifier of importedModules.split(',')) {
      const normalizedSpecifier = specifier.trim();

      if (!normalizedSpecifier) {
        continue;
      }

      const [moduleNamePart, localNamePart] = normalizedSpecifier.split(/\s+as\s+/i).map((value) => value.trim());
      const moduleName = moduleNamePart;
      const localName = localNamePart || moduleNamePart.split('.').at(-1) || moduleNamePart;

      if (!moduleName || !localName) {
        continue;
      }

      index.importedBindings.set(localName, {
        language: 'python',
        moduleName,
        importedName: null,
      });
    }
  }

  return index;
}

function buildPhpIndex(filePath: string, content: string): IndexedNavigationFile {
  const index = buildEmptyIndex();

  recordRegexDefinitions(
    content,
    /(?:^|\n)\s*(?:final\s+|abstract\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_][\w]*)\b/g,
    filePath,
    index,
    (match) => ({
      exported: true,
      defaultExport: false,
      name: match[1],
      nameOffset: match[0].lastIndexOf(match[1]),
    }),
  );
  recordRegexDefinitions(
    content,
    /(?:^|\n)\s*function\s+([A-Za-z_][\w]*)\s*\(/g,
    filePath,
    index,
    (match) => ({
      exported: true,
      defaultExport: false,
      name: match[1],
      nameOffset: match[0].lastIndexOf(match[1]),
    }),
  );

  for (const match of content.matchAll(/(?:^|\n)\s*use\s+([^;{}]+);/g)) {
    const useClause = match[1] ?? '';

    for (const specifier of useClause.split(',')) {
      const normalizedSpecifier = specifier.trim();

      if (!normalizedSpecifier) {
        continue;
      }

      const [namespacePart, aliasPart] = normalizedSpecifier.split(/\s+as\s+/i).map((value) => value.trim());
      const fullyQualifiedName = namespacePart.replace(/^\\+/, '');
      const localName = aliasPart || fullyQualifiedName.split('\\').at(-1);

      if (!fullyQualifiedName || !localName) {
        continue;
      }

      index.importedBindings.set(localName, {
        language: 'php',
        fullyQualifiedName,
      });
    }
  }

  return index;
}

function recordRegexDefinitions(
  content: string,
  pattern: RegExp,
  filePath: string,
  index: IndexedNavigationFile,
  extractor: (match: RegExpMatchArray) => {
    exported: boolean;
    defaultExport: boolean;
    name: string;
    nameOffset: number;
  },
) {
  for (const match of content.matchAll(pattern)) {
    const matchIndex = match.index ?? -1;

    if (matchIndex < 0) {
      continue;
    }

    const definitionMeta = extractor(match);
    const definitionOffset = matchIndex + Math.max(0, definitionMeta.nameOffset);
    recordIndexedDefinition(
      filePath,
      content,
      index,
      definitionMeta.name,
      Math.max(0, definitionOffset),
      Math.max(0, definitionOffset) + definitionMeta.name.length,
    );

    if (definitionMeta.exported) {
      index.exportedDefinitions.set(definitionMeta.name, buildNavigationTarget(filePath, content, definitionOffset));
    }

    if (definitionMeta.defaultExport) {
      index.defaultExportTarget = buildNavigationTarget(filePath, content, definitionOffset);
    }
  }
}

function recordIndexedDefinition(
  filePath: string,
  content: string,
  index: IndexedNavigationFile,
  name: string,
  from: number,
  to: number,
) {
  const clampedFrom = Math.max(0, Math.min(from, content.length));
  const clampedTo = Math.max(clampedFrom, Math.min(to, content.length));

  index.localDefinitions.set(name, {
    target: buildNavigationTarget(filePath, content, clampedFrom),
    from: clampedFrom,
    to: clampedTo,
  });
}

function buildNavigationTarget(filePath: string, content: string, offset: number): CodeNavigationTarget {
  const clampedOffset = Math.max(0, Math.min(offset, content.length));
  const before = content.slice(0, clampedOffset);
  const line = before.split('\n').length;
  const lineStart = before.lastIndexOf('\n');
  const column = clampedOffset - (lineStart < 0 ? 0 : lineStart + 1) + 1;

  return {
    filePath,
    line,
    column,
  };
}

export function clearCodeNavigationCaches() {
  fileIndexCache.clear();
  resolvedFilePathCache.clear();
  composerAutoloadCache.clear();
  javaScriptSyntaxCache.clear();
  phpSyntaxCache.clear();
  pythonSyntaxCache.clear();
}
