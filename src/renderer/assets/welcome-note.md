# Welcome

This note is the default place for release updates and small product messages inside BridgeGit.

## New in 1.0.2

- BridgeGit now writes a launch-time backup of the restored session before continuing startup
- the app keeps the three newest session launch backups in its user data folder
- Settings can save a session snapshot manually when you want a known-good restore point
- restoring a selected backup JSON shows a short comparison of workspaces, repositories and open tabs before it replaces the saved session

## Also in 1.0.1

- mouse-driven paste in shell tabs now inserts external clipboard text only once
- terminal paste handling now blocks the native xterm textarea path before it can emit a duplicate input event
- right-click paste now runs on button release, which avoids the press/release duplication seen with slower clicks
- `Ctrl+V` paste behavior stays unchanged

## Also in the 1.0.0 release

- BridgeGit has full app localization with English as the default language
- choose the app language first in `Settings -> General`
- use Czech, Spanish, German, French, Portuguese, Polish, Ukrainian, Chinese, Japanese or Korean UI translations
- clipboard behavior can be adjusted from General settings
- editor and notes selection handling is steadier during copy and paste workflows
- the bundled release note now follows the app version, so the envelope button highlights this update once after install

## Quick Start

1. Open a repository from the left panel.
2. Review changed files and stage what you want.
3. Use shell tabs for Git, build, or tooling commands.
4. Open source files into code tabs when you need proper editing next to the repo.
5. Split code panes when you want to compare files or keep two parts of the same file visible.
6. Use `Ctrl+E` to open the full `All Tabs` switcher when the workspace gets crowded.
7. Keep markdown notes nearby for prompts, release notes, or scratch context in the upgraded notes editor.

## Tips

- Double-click a tab title to rename it.
- Hold Ctrl and use the mouse wheel over shell, note, code, or the workspace sidebar to change font size.
- Use the layout settings to move the repository panel left or right and place diff top, bottom, left, or right.
- Use `Ctrl+Alt+Arrow` to split or focus editor panes, and `Ctrl+Alt+Shift+Arrow` to merge them back.
- Use `Ctrl+click` on workspace tabs to show two open tabs side by side.
- Use `Ctrl+Shift+H` to open clipboard history when you want to paste an older snippet.
- Ctrl/Cmd+click on a file path in code to open it.
- Ctrl/Cmd+click on a symbol usage to jump to its definition.
- Ctrl/Cmd+click on a symbol definition to open references.

Open a repo and start with the shell tab when you're ready.
