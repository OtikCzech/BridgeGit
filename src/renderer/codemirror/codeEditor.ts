import type { Extension } from '@codemirror/state';
import { HighlightStyle, StreamLanguage, syntaxHighlighting, type Language } from '@codemirror/language';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { php } from '@codemirror/lang-php';
import { sass } from '@codemirror/lang-sass';
import { sql } from '@codemirror/lang-sql';
import { vue } from '@codemirror/lang-vue';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { githubDark, githubLight } from '@uiw/codemirror-theme-github';
import { nord } from '@uiw/codemirror-theme-nord';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { highlightTree, tagHighlighter, tags } from '@lezer/highlight';
import { getWorkspaceFileBaseName, getWorkspaceFileExtension, type ResolvedEditorTheme } from '../../shared/bridgegit';

export const CODE_EDITOR_LARGE_FILE_CHAR_LIMIT = 250_000;

const shellLanguage = StreamLanguage.define(shell);
const powerShellLanguage = StreamLanguage.define(powerShell);

const codeHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--code-token-comment)', fontStyle: 'italic' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--code-token-string)' },
  { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom], color: 'var(--code-token-number)' },
  { tag: [tags.keyword, tags.operatorKeyword, tags.controlKeyword, tags.modifier], color: 'var(--code-token-keyword)' },
  { tag: [tags.variableName, tags.labelName], color: 'var(--code-token-variable)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--code-token-property)' },
  { tag: [tags.tagName, tags.className, tags.typeName, tags.namespace], color: 'var(--code-token-tag)' },
  { tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket], color: 'var(--code-token-punctuation)' },
  { tag: tags.invalid, color: 'var(--code-token-invalid)', textDecoration: 'underline' },
]);

const htmlSupport = () => html({
  autoCloseTags: true,
  matchClosingTags: true,
  selfClosingTags: true,
});

interface CodeLanguageConfig {
  language: Language | null;
  label: string;
  support: Extension | null;
}

const CODE_LANGUAGE_ALIASES: Record<string, string> = {
  bash: 'shell',
  cjs: 'javascript',
  htm: 'html',
  js: 'javascript',
  jsonc: 'json',
  jsx: 'jsx',
  ps1: 'powershell',
  psm1: 'powershell',
  pwsh: 'powershell',
  shell: 'shell',
  sh: 'shell',
  ts: 'typescript',
  tsx: 'tsx',
  yml: 'yaml',
  zsh: 'shell',
};

const noteCodeBlockHighlighter = tagHighlighter([
  { tag: tags.comment, class: 'note-tab__code-token--comment' },
  { tag: [tags.string, tags.special(tags.string)], class: 'note-tab__code-token--string' },
  { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom], class: 'note-tab__code-token--number' },
  { tag: [tags.keyword, tags.operatorKeyword, tags.controlKeyword, tags.modifier], class: 'note-tab__code-token--keyword' },
  { tag: [tags.variableName, tags.labelName], class: 'note-tab__code-token--variable' },
  { tag: [tags.propertyName, tags.attributeName], class: 'note-tab__code-token--property' },
  { tag: [tags.tagName, tags.className, tags.typeName, tags.namespace], class: 'note-tab__code-token--tag' },
  { tag: [tags.escape, tags.processingInstruction, tags.special(tags.variableName)], class: 'note-tab__code-token--entity' },
]);

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resolveLanguageIdentifier(language: string | null): string | null {
  if (!language) {
    return null;
  }

  const normalizedLanguage = language.trim().toLocaleLowerCase();

  if (!normalizedLanguage) {
    return null;
  }

  return CODE_LANGUAGE_ALIASES[normalizedLanguage] ?? normalizedLanguage;
}

function renderDiffHighlightedCodeHtml(code: string) {
  return code
    .split('\n')
    .map((line, index, lines) => {
      const escapedLine = escapeHtml(line);
      const newline = index < lines.length - 1 ? '\n' : '';

      if (/^(?:@@|diff |index |--- |\+\+\+ )/.test(line)) {
        return `<span class="note-tab__code-token--diff-meta">${escapedLine}</span>${newline}`;
      }

      if (line.startsWith('+')) {
        return `<span class="note-tab__code-token--diff-add">${escapedLine}</span>${newline}`;
      }

      if (line.startsWith('-')) {
        return `<span class="note-tab__code-token--diff-remove">${escapedLine}</span>${newline}`;
      }

      return `${escapedLine}${newline}`;
    })
    .join('');
}

function toCodeLanguageConfig(label: string, support: Extension | null, language: Language | null): CodeLanguageConfig {
  return {
    label,
    support,
    language,
  };
}

function toSupportConfig(label: string, supportFactory: { extension: Extension; language: Language }): CodeLanguageConfig {
  return toCodeLanguageConfig(label, supportFactory.extension, supportFactory.language);
}

function resolveCodeLanguageConfig(filePath: string): CodeLanguageConfig {
  const extension = getWorkspaceFileExtension(filePath);
  const fileName = getWorkspaceFileBaseName(filePath);

  switch (extension) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return resolveCodeLanguageConfigForLanguage('javascript');
    case 'jsx':
      return resolveCodeLanguageConfigForLanguage('jsx');
    case 'ts':
      return resolveCodeLanguageConfigForLanguage('typescript');
    case 'tsx':
      return resolveCodeLanguageConfigForLanguage('tsx');
    case 'json':
    case 'jsonc':
      return resolveCodeLanguageConfigForLanguage('json');
    case 'css':
      return resolveCodeLanguageConfigForLanguage('css');
    case 'scss':
      return resolveCodeLanguageConfigForLanguage('scss');
    case 'sass':
      return resolveCodeLanguageConfigForLanguage('sass');
    case 'html':
    case 'htm':
      return resolveCodeLanguageConfigForLanguage('html');
    case 'vue':
      return resolveCodeLanguageConfigForLanguage('vue');
    case 'yaml':
    case 'yml':
      return resolveCodeLanguageConfigForLanguage('yaml');
    case 'php':
      return resolveCodeLanguageConfigForLanguage('php');
    case 'sql':
      return resolveCodeLanguageConfigForLanguage('sql');
    case 'xml':
    case 'svg':
      return resolveCodeLanguageConfigForLanguage(extension === 'svg' ? 'svg' : 'xml');
    case 'sh':
    case 'bash':
    case 'zsh':
      return resolveCodeLanguageConfigForLanguage('shell');
    case 'ps1':
    case 'psm1':
      return resolveCodeLanguageConfigForLanguage('powershell');
    default:
      break;
  }

  if (fileName === 'dockerfile') {
    return resolveCodeLanguageConfigForLanguage('dockerfile');
  }

  if (fileName === '.gitignore' || fileName === '.gitattributes' || fileName === '.env' || fileName === '.env.example') {
    return toCodeLanguageConfig('Config', null, null);
  }

  if (fileName === 'makefile') {
    return toCodeLanguageConfig('Makefile', null, null);
  }

  return toCodeLanguageConfig('Plain text', null, null);
}

function resolveCodeLanguageConfigForLanguage(language: string | null): CodeLanguageConfig {
  const normalizedLanguage = resolveLanguageIdentifier(language);

  switch (normalizedLanguage) {
    case 'javascript':
      return toSupportConfig('JavaScript', javascript());
    case 'jsx':
      return toSupportConfig('JSX', javascript({ jsx: true }));
    case 'typescript':
      return toSupportConfig('TypeScript', javascript({ typescript: true }));
    case 'tsx':
      return toSupportConfig('TSX', javascript({ jsx: true, typescript: true }));
    case 'json':
      return toSupportConfig('JSON', json());
    case 'css':
      return toSupportConfig('CSS', css());
    case 'scss':
      return toSupportConfig('SCSS', sass());
    case 'sass':
      return toSupportConfig('Sass', sass({ indented: true }));
    case 'html':
      return toSupportConfig('HTML', htmlSupport());
    case 'vue':
      return toSupportConfig('Vue', vue({ base: htmlSupport() }));
    case 'yaml':
      return toSupportConfig('YAML', yaml());
    case 'php':
      return toSupportConfig('PHP', php({ plain: true }));
    case 'sql':
      return toSupportConfig('SQL', sql());
    case 'xml':
      return toSupportConfig('XML', xml());
    case 'svg':
      return toSupportConfig('SVG', xml());
    case 'shell':
      return toCodeLanguageConfig('Shell', shellLanguage.extension, shellLanguage);
    case 'powershell':
      return toCodeLanguageConfig('PowerShell', powerShellLanguage.extension, powerShellLanguage);
    case 'dockerfile':
      return toCodeLanguageConfig('Dockerfile', shellLanguage.extension, shellLanguage);
    default:
      return toCodeLanguageConfig('Plain text', null, null);
  }
}

export function getCodeEditorLanguageLabel(filePath: string): string {
  return resolveCodeLanguageConfig(filePath).label;
}

export function normalizeCodeLanguageIdentifier(language: string | null): string | null {
  return resolveLanguageIdentifier(language);
}

export function getCodeEditorLanguageExtension(filePath: string, largeFile = false): Extension {
  if (largeFile) {
    return [];
  }

  return resolveCodeLanguageConfig(filePath).support ?? [];
}

export function isCodeEditorLargeFile(content: string): boolean {
  return content.length >= CODE_EDITOR_LARGE_FILE_CHAR_LIMIT;
}

export const bridgeGitCodeHighlighting = syntaxHighlighting(codeHighlightStyle);

export function getCodeEditorThemeExtension(theme: ResolvedEditorTheme): Extension {
  switch (theme) {
    case 'github-dark':
      return githubDark;
    case 'github-light':
      return githubLight;
    case 'nord':
      return nord;
    case 'bridgegit-dark':
    case 'bridgegit-light':
    default:
      return bridgeGitCodeHighlighting;
  }
}

export function renderHighlightedCodeHtml(code: string, language: string | null): string {
  const normalizedLanguage = resolveLanguageIdentifier(language);

  if (!normalizedLanguage) {
    return escapeHtml(code);
  }

  if (normalizedLanguage === 'diff' || normalizedLanguage === 'patch') {
    return renderDiffHighlightedCodeHtml(code);
  }

  const { language: parserLanguage } = resolveCodeLanguageConfigForLanguage(normalizedLanguage);

  if (!parserLanguage) {
    return escapeHtml(code);
  }

  const tree = parserLanguage.parser.parse(code);
  let html = '';
  let cursor = 0;

  highlightTree(tree, noteCodeBlockHighlighter, (from, to, classes) => {
    if (from > cursor) {
      html += escapeHtml(code.slice(cursor, from));
    }

    html += `<span class="${classes}">${escapeHtml(code.slice(from, to))}</span>`;
    cursor = to;
  });

  if (cursor < code.length) {
    html += escapeHtml(code.slice(cursor));
  }

  return html;
}
