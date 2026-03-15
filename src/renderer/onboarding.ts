import {
  DEFAULT_NOTE_FONT_SIZE,
  GLOBAL_WORKSPACE_SESSION_KEY,
  type WorkspaceNoteTabState,
  type WorkspaceSessionState,
  type WorkspaceSessionsByContext,
  type WorkspaceTabState,
} from '../shared/bridgegit';
import welcomeNoteContent from './assets/welcome-note.md?raw';

export const WELCOME_NOTE_TAB_ID = 'note-welcome';
export const CURRENT_INFO_NOTE_REVISION = 'welcome-0.1.0';
const WELCOME_SHELL_TAB_ID = 'shell-main';

export function hasWorkspaceTabs(workspaceSessions: WorkspaceSessionsByContext): boolean {
  return Object.values(workspaceSessions).some((workspaceSession) => workspaceSession.tabs.length > 0);
}

export function buildOnboardingWorkspaceSessions(
  repoPath: string | null,
  cwd: string,
): WorkspaceSessionsByContext {
  const contextKey = repoPath ?? GLOBAL_WORKSPACE_SESSION_KEY;

  return {
    [contextKey]: buildOnboardingWorkspaceSession(cwd),
  };
}

function buildOnboardingWorkspaceSession(cwd: string): WorkspaceSessionState {
  return {
    tabs: [
      buildWelcomeNoteTab(),
      {
        id: WELCOME_SHELL_TAB_ID,
        type: 'shell',
        title: 'Shell 1',
        cwd,
        launcherProfileId: null,
      },
    ],
    activeTabId: WELCOME_NOTE_TAB_ID,
  };
}

export function buildWelcomeNoteTab(): WorkspaceNoteTabState {
  return {
    id: WELCOME_NOTE_TAB_ID,
    type: 'note',
    title: 'Welcome',
    filePath: null,
    content: welcomeNoteContent,
    savedContent: welcomeNoteContent,
    viewMode: 'preview',
    fontSize: DEFAULT_NOTE_FONT_SIZE,
  };
}

export function upsertWelcomeNoteTab(tabs: WorkspaceTabState[]): WorkspaceTabState[] {
  const welcomeTab = buildWelcomeNoteTab();
  const existingIndex = tabs.findIndex((tab) => tab.id === WELCOME_NOTE_TAB_ID && tab.type === 'note');

  if (existingIndex === -1) {
    return [welcomeTab, ...tabs];
  }

  return tabs.map((tab) => (
    tab.id === WELCOME_NOTE_TAB_ID && tab.type === 'note'
      ? {
          ...tab,
          title: welcomeTab.title,
          content: welcomeTab.content,
          savedContent: welcomeTab.savedContent,
        }
      : tab
  ));
}
