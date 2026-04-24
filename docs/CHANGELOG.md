# Changelog

## v0.7.0 - 2026-04-24

Workspace follow-up release focused on a stronger notes editor, smarter clipboard flow and calmer multi-repo behavior.

- Replaced the notes textarea with a CodeMirror 6 editor, aligned its theming with code tabs and added a persisted line-numbers toggle
- Added persistent clipboard history with smarter paste behavior for shell and editor flows
- Hardened workspace and session restore, including tab persistence, active-pane recovery and synchronous save on app close
- Added resizable split dividers across note split, multi-display and editor pane layouts
- Polished repo-family focus and keyboard handling, including safer global refresh blocking while keeping terminal history search intact

## v0.6.0 - 2026-04-17

Workspace expansion release focused on comparing more context at once and bringing Docker runtime control directly into the app.

- Added a global `Docker` dialog with container and image overview, grouped Compose projects, quick actions and direct logs tabs
- Added `Ctrl+click` two-tab workspace view for `shell`, `note` and `code` tabs so two open tabs can stay visible side by side
- Persisted the two-tab workspace view across session restore and added matching tab context-menu actions
- Simplified the Docker dialog header so the global runtime view does not imply a misleading single compose-root scope
- Brought the internal `0.5.2` terminal and navigation fixes into the release line, including preserved repo cwd when entering `wsl`, more reliable mixed Windows and WSL path opening, and smoother background workspace refresh

## v0.5.2 - 2026-04-15

Patch release focused on terminal path correctness and quieter workspace refresh across mixed Windows and WSL setups.

- Preserved the current repository cwd when entering `wsl` from the integrated PowerShell terminal
- Resolved mixed Windows and WSL file paths more reliably for note loading and terminal file-link navigation
- Smoothed background repo refresh for inactive workspaces to reduce bursty polling while keeping branch summaries current
- Refined repo-panel status indicators to emphasize changed, untracked and conflicted files more clearly

## v0.5.1 - 2026-04-13

Search follow-up release focused on finishing workspace text replacement and smoothing the release handoff.

- Added `Replace in Files` on top of the existing workspace search overlay with `Ctrl+Shift+H`
- Reused current search results, preview, file filtering and tracked/untracked scope for replace actions
- Added replace selected, replace in document and replace all flows with confirmation for broader changes
- Refreshed affected tabs and search results after replace to keep editor and overlay state in sync
- Polished the workspace search flow and prepared the next round of repo and workspace improvements

## v0.5.0 - 2026-04-04

Workspace navigation and history release focused on moving through larger repos faster while keeping shell workflows smoother.

- Rebuilt repository history browser with stronger commit browsing and preview flow
- Workspace `Quick Open` and `Find in files` workflows for faster file and text navigation
- `All files` tree upgrades including reveal-active-file, type-to-select and persistent tree state
- Better shell tab handling with safer close actions, missing file-link toasts and clearer attention indicators
- Session and Windows polish, including terminal cwd restore per workspace and preserved taskbar pinning on upgrade

## v0.4.0 - 2026-03-27

Workspace ergonomics release focused on reading diffs faster and managing larger editing sessions with less friction.

- Syntax-highlighted `DiffViewer` with direct open-in-editor flow for changed files
- Split code panes up to a `2x2` grid, including same-file side-by-side editing
- `All Tabs` switcher with search, type filter and `Ctrl+E` shortcut for large workspace sessions
- Mouse split controls and close actions for editor panes alongside the keyboard pane shortcuts
- Quieter Linux start flow by suppressing noisy DBus accessibility wrapper logs

## v0.3.0 - 2026-03-26

Workspace and repository workflow release focused on multi-repo clarity, worktree handling and repo-panel control.

- Worktree-aware branch picker with safer checkout flow and clearer repo switching
- Safe branch and worktree lifecycle actions, including merge into primary branch and guarded removal flows
- Compact sync toolbar in the repo panel with fetch, push and improved branch actions
- Support for non-git folders in the repo panel, including `All files` browsing and Git initialization
- Flexible layout settings for repository side and diff placement
- Repo family focus mode to temporarily hide unrelated workspaces and switch only within one repo family

## v0.2.1 - 2026-03-22

Post-release fix for the in-app update note and settings guidance.

- Updated the in-app welcome/update note for the 0.2.x release line
- Added an explicit `Ctrl + wheel` font-size hint in Settings

## v0.2.0 - 2026-03-21

Code editor milestone release with navigation, references, notes preview upgrades and appearance themes.

- CodeMirror-based `code` tabs with search, themes and file-backed save flow
- Shared highlighting and Mermaid preview in notes
- External file change and restored-session mismatch warnings for file-backed tabs
- App appearance themes plus editor theme variants and settings polish
- Ctrl/Cmd+click navigation, go-to-definition and find-references for JS/TS/Vue, PHP and Python
- Windows packaging workflow updated and verified on Node `24.14.0`

## v0.1.0 - 2026-03-16

First public GitHub release of BridgeGit.

- Public release repository: `bridgegit.github`
- Public release commit: `b1aae3a` (`chore: prepare initial public release`)
- Source repository reference commit: `4734d55` (`fix(onboarding): refine welcome defaults`)
