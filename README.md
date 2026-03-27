# BridgeGit

BridgeGit is a desktop Git client with an integrated terminal workspace, built with Electron + Vue.

It combines:
- Git status/staging/commit workflows
- Diff viewer (side-by-side and unified)
- Split code panes up to 2x2
- Workspace tabs for shell sessions and notes
- Session persistence (repo, layout, tabs, presets)

## Highlights

- Three-panel layout: Repository panel, Diff panel, Workspace panel
- Syntax-highlighted diff viewer with open-in-editor flow
- Split code panes with keyboard and mouse controls
- All Tabs switcher with search and `Ctrl+E`
- Shell tabs with multi-session support and reconnect
- Notes tabs with Markdown source/split/preview modes
- Custom command presets
- Keyboard-driven workflow for common actions

## Tech Stack

- Electron 41
- Vue 3 (Composition API) + TypeScript
- Vite 8
- `node-pty` for terminal sessions
- `simple-git` for Git operations
- `diff2html` for diff rendering
- `electron-store` for session/settings persistence

## Requirements

- Node.js `24.14.0` (recommended via `.nvmrc`)
- npm
- Git

For WSL/Linux development:
- `build-essential` (required for native `node-pty` rebuild)
- `fonts-noto-color-emoji` (required for correct emoji rendering in Notes and other UI areas when running from WSL)

```bash
sudo apt-get update
sudo apt-get install -y build-essential fonts-noto-color-emoji
fc-cache -f -v
```

## Quick Start

```bash
nvm use
npm install
npm run dev
```

Production build:

```bash
npm run build
```

Run Electron app from built files:

```bash
npm run start
```

## Scripts

- `npm run dev` – start development mode
- `npm run build` – type-check + renderer/main build
- `npm run start` – run Electron app
- `npm run dist:win` – build Windows NSIS installer
- `npm run dist:win:portable` – build Windows portable package

## Default Keyboard Shortcuts

- `Ctrl+1` / `Ctrl+2` / `Ctrl+3` – toggle repository/diff/workspace panels
- `Ctrl+N` – new shell tab
- `Ctrl+Shift+N` – new notes tab
- `Ctrl+E` – open All Tabs switcher
- `Ctrl+PgUp` / `Ctrl+PgDn` – previous/next shell tab
- `Ctrl+F4` – close active shell tab
- `Ctrl+H` – open git history
- `Ctrl+Shift+F` – focus history search
- `Alt+Up` / `Alt+Down` – previous/next diff item
- `Alt+Enter` – stage current diff and continue
- `Ctrl+Alt+Arrow` – split or focus code pane in a direction
- `Ctrl+Alt+Shift+Arrow` – close or merge current code pane

## Security Notes

- `nodeIntegration: false`
- `contextIsolation: true`
- IPC APIs are exposed through preload bridge only

## License

MIT
