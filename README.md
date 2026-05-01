# BridgeGit

BridgeGit is an Electron desktop app that combines Git workflows, an integrated terminal workspace, notes and a code editor in one window.

Current release: `v0.8.0`

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

Use your local checkout for development:

```bash
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

## Scripts

- `npm run dev` - start Vite + TypeScript watchers and launch Electron in development mode
- `npm run build` - type-check and build renderer, main and preload bundles
- `npm run start` - launch Electron from the built output
- `npm run dist:win` - Windows NSIS installer build
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

Release notes live in `docs/CHANGELOG.md`.

## License

MIT
