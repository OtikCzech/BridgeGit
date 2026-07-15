# BridgeGit

BridgeGit is a desktop Git GUI workspace for AI-assisted development with worktrees, terminal sessions, diffs, code editor tabs and built-in Markdown notes.

Run Codex, Claude or other AI coding agents in parallel, keep each task in its own branch or worktree, and review the actual Git diff before you commit. BridgeGit keeps the surrounding context close: shell output, prompts, task notes, release checklists, changed files and code views all stay in one window.

It is built for developers who want AI speed without losing Git discipline.

Current release: `v1.0.1`

## Built For AI Coding Workflows

- Run multiple AI coding sessions across separate shell tabs, branches or worktrees
- Keep prompts, task plans, review notes and release checklists in built-in Markdown notes
- Review staged and unstaged diffs before accepting AI-generated code
- Compare AI edits with split code panes and side-by-side workspace tabs
- Keep tests, build commands and packaging logs next to the repository state
- Restore repository context, terminal tabs, notes and layout between sessions

## Core Workspace

- Git panel with branch status, staged/unstaged/untracked/conflicted files, sync actions and worktree-aware branch handling
- Syntax-highlighted diff viewer with working-tree and staged diffs plus direct stage-and-continue flow
- Terminal tabs for agents, tests, build commands, packaging and release checks
- Built-in Markdown notes with split preview and Mermaid rendering for prompts, plans and review notes
- Code editor with file-backed tabs, split panes up to `2x2` and code navigation for common languages
- `Quick Open`, `All Tabs`, `Find in Files`, `Replace in Files` and `All files` tree for larger repos
- Two-tab side-by-side workspace view via `Ctrl+click` on tab headers for `shell`, `note` and `code` tabs
- Global Docker dialog for containers, images, Compose grouping, quick actions and log handoff into workspace tabs
- Localized UI with English as the default language plus Czech, Spanish, German, French, Portuguese, Polish, Ukrainian, Chinese, Japanese and Korean
- Clipboard behavior settings, including right-click paste and selection auto-copy controls for terminal and editor workflows
- Session persistence for repo context, layout, workspace tabs and comparison view state

## Tech Stack

- Electron 41
- Vue 3 + TypeScript
- Vite 8
- `node-pty` for integrated terminal sessions
- `simple-git` for Git operations
- CodeMirror 6 for code editing
- `diff2html` for diff rendering
- `electron-store` for app session and settings persistence

## Requirements

- Node.js `24.14.0` in both WSL and Windows
- npm
- Git

For WSL/Linux development:

- `build-essential` for native `node-pty` rebuilds
- `fonts-noto-color-emoji` for correct emoji rendering in notes and other UI

```bash
sudo apt-get update
sudo apt-get install -y build-essential fonts-noto-color-emoji
fc-cache -f -v
```

## Development Setup

Primary development happens in the WSL checkout:

```bash
cd bridgegit
nvm use
npm install
npm run dev
```

Build the app bundles:

```bash
npm run build
```

Run Electron from built files:

```bash
npm run start
```

## Windows Packaging

For a Windows installer with the app icon applied to the installed executable, use the included PowerShell packaging wrapper from a Windows shell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\package-classic.ps1
```

The installer is written to `release\BridgeGit-Setup-<version>-x64.exe`.

## Scripts

- `npm run dev` - start Vite + TypeScript watchers and launch Electron in development mode
- `npm run build` - type-check and build renderer, main and preload bundles
- `npm run start` - launch Electron from the built output
- `npm run dist:win` - low-level Windows NSIS build via `electron-builder`
- `npm run dist:win:portable` - Windows portable build
- `npm run dist:linux` - Linux AppImage build
- `npm run rebuild:native` - rebuild native modules for the current environment
- `npm test` - placeholder script, no automated test suite yet

## Selected Shortcuts

- `Ctrl+1` / `Ctrl+2` / `Ctrl+3` - toggle repository, diff and workspace panels
- `Ctrl+H` - open Git history
- `Ctrl+Shift+D` - open the Docker dialog
- `Ctrl+N` - open the new-tab menu, then use the shown slot keys for shell, note or file actions
- `Ctrl+E` - open `All Tabs`
- `Ctrl+P` - `Quick Open`
- `Ctrl+Shift+F` - `Find in Files`
- `Ctrl+Shift+R` - `Replace in Files`
- `Ctrl+Shift+H` - `Clipboard History`
- `Ctrl+Alt+R` - reveal the active file in `All files`
- `Alt+Up` / `Alt+Down` - previous or next diff item
- `Alt+Enter` - stage the current diff item and continue

## Security

- `nodeIntegration: false`
- `contextIsolation: true`
- Renderer access goes through the preload bridge and serializable IPC payloads

## Changelog

Release notes live in [`docs/CHANGELOG.md`](docs/CHANGELOG.md).

## License

MIT
