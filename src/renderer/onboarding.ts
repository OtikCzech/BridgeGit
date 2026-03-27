import {
  DEFAULT_SHELL_FONT_SIZE,
  DEFAULT_NOTE_FONT_SIZE,
  GLOBAL_WORKSPACE_ID,
  type WorkspaceTabDefaults,
  type WorkspaceNoteTabState,
  type WorkspaceSessionState,
  type WorkspaceSessionsById,
  type WorkspaceTabState,
} from '../shared/bridgegit';
import packageJson from '../../package.json';
import welcomeNoteContent from './assets/welcome-note.md?raw';

export const WELCOME_NOTE_TAB_ID = 'note-welcome';
export const CURRENT_APP_VERSION = packageJson.version;
export const CURRENT_INFO_NOTE_REVISION = `welcome-${CURRENT_APP_VERSION}`;
const WELCOME_SHELL_TAB_ID = 'shell-main';

export function hasWorkspaceTabs(workspaceSessions: WorkspaceSessionsById): boolean {
  return Object.values(workspaceSessions).some((workspaceSession) => workspaceSession.tabs.length > 0);
}

export function buildOnboardingWorkspaceSessions(
  repoPath: string | null,
  cwd: string,
  workspaceTabDefaults?: WorkspaceTabDefaults,
): WorkspaceSessionsById {
  const workspaceId = repoPath ? `workspace:${repoPath}` : GLOBAL_WORKSPACE_ID;

  return {
    [workspaceId]: buildOnboardingWorkspaceSession(cwd, workspaceTabDefaults),
  };
}

function buildOnboardingWorkspaceSession(
  cwd: string,
  workspaceTabDefaults?: WorkspaceTabDefaults,
): WorkspaceSessionState {
  return {
    tabs: [
      buildWelcomeNoteTab(workspaceTabDefaults),
      {
        id: WELCOME_SHELL_TAB_ID,
        type: 'shell',
        title: 'Shell 1',
        cwd,
        fontSize: workspaceTabDefaults?.shellFontSize ?? DEFAULT_SHELL_FONT_SIZE,
        launcherProfileId: null,
      },
    ],
    activeTabId: WELCOME_NOTE_TAB_ID,
    editorPaneLayout: {
      panes: [],
      activePaneId: null,
    },
  };
}

export function buildWelcomeNoteTab(workspaceTabDefaults?: WorkspaceTabDefaults): WorkspaceNoteTabState {
  return {
    id: WELCOME_NOTE_TAB_ID,
    type: 'note',
    title: 'Welcome',
    filePath: null,
    content: welcomeNoteContent,
    savedContent: welcomeNoteContent,
    viewMode: 'preview',
    fontSize: workspaceTabDefaults?.noteFontSize ?? DEFAULT_NOTE_FONT_SIZE,
  };
}

export function upsertWelcomeNoteTab(
  tabs: WorkspaceTabState[],
  workspaceTabDefaults?: WorkspaceTabDefaults,
): WorkspaceTabState[] {
  const welcomeTab = buildWelcomeNoteTab(workspaceTabDefaults);
  const existingIndex = tabs.findIndex((tab) => tab.id === WELCOME_NOTE_TAB_ID && tab.type === 'note');

  if (existingIndex === -1) {
    return [welcomeTab, ...tabs];
  }

  return tabs.map((tab) => (
    tab.id === WELCOME_NOTE_TAB_ID && tab.type === 'note'
      ? mergeWelcomeNoteTab(tab, welcomeTab)
      : tab
  ));
}

export function refreshWelcomeNoteTabs(
  workspaceSessions: WorkspaceSessionsById,
  workspaceTabDefaults?: WorkspaceTabDefaults,
): WorkspaceSessionsById {
  const welcomeTab = buildWelcomeNoteTab(workspaceTabDefaults);

  return Object.fromEntries(
    Object.entries(workspaceSessions).map(([workspaceId, workspaceSession]) => ([
      workspaceId,
      {
        ...workspaceSession,
        tabs: workspaceSession.tabs.map((tab) => (
          tab.id === WELCOME_NOTE_TAB_ID && tab.type === 'note'
            ? mergeWelcomeNoteTab(tab, welcomeTab)
            : tab
        )),
      },
    ])),
  );
}

function mergeWelcomeNoteTab(
  tab: WorkspaceNoteTabState,
  welcomeTab: WorkspaceNoteTabState,
): WorkspaceNoteTabState {
  return {
    ...tab,
    title: welcomeTab.title,
    filePath: welcomeTab.filePath,
    content: welcomeTab.content,
    savedContent: welcomeTab.savedContent,
  };
}
