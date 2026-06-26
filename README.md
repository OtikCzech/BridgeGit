# BridgeGit

BridgeGit is an Electron desktop app that combines Git workflows, an integrated terminal workspace, notes and a code editor in one window.

Current release: `v1.0.0`

It is built for day-to-day repository work where you want Git status, history, diffs, shell sessions and file editing to stay in the same context.

## Highlights

- Repository panel with branch status, staged/unstaged/untracked/conflicted files, sync actions and worktree-aware branch handling
- Syntax-highlighted diff viewer with working-tree and staged diffs plus direct stage-and-continue flow
- Workspace tabs for shell, notes and code files
- Code editor with split panes up to `2x2`, file-backed tabs and code navigation for common languages
- Notes tabs with Markdown editing, split preview and Mermaid rendering
- `Quick Open`, `All Tabs`, `Find in Files`, `Replace in Files` and `All files` tree for larger repos
- Two-tab side-by-side workspace view via `Ctrl+click` on tab headers for `shell`, `note` and `code` tabs
- Global Docker dialog for containers, images, Compose grouping, quick actions and log handoff into workspace tabs
- Localized UI with English as the default language plus Czech, Spanish, German, French, Portuguese, Polish, Ukrainian, Chinese, Japanese and Korean
- Clipboard behavior settings, including right-click paste and selection auto-copy controls for terminal and editor workflows
- Session persistence for repo context, layout, workspace tabs and comparison view state

## What's New in v1.0.0

BridgeGit `v1.0.0` is the first stable release. It keeps the existing Git, terminal, editor, notes and Docker workflows, and adds a broader localization and clipboard polish pass.

- Default app language is English, with language selection at the top of `Settings -> General`
- Added complete UI dictionaries for `en`, `cs`, `es`, `de`, `fr`, `pt`, `pl`, `uk`, `zh`, `ja` and `ko`
- Localized the main workspace, repo panel, diff viewer, commit history, Docker dialog, notes, code tabs, terminal tabs and shared error/copy states
- Added configurable clipboard behavior for right-click paste and selection auto-copy
- Fixed the terminal right-click paste edge case where clipboard text could be inserted twice
- Refined editor and notes copy/selection behavior around stale selections, cursor scrolling and saved-file state

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
