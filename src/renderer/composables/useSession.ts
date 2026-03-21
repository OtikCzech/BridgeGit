import { ref } from 'vue';
import {
  DEFAULT_SESSION_DATA,
  cloneDismissedWorktreePaths,
  cloneWorkspaceTabDefaults,
  clonePanelLayoutsByWorkspace,
  cloneProjectTitlesByContext,
  cloneWorkspaceIndicatorVisibilitySettings,
  cloneWorkspaceRepoPanelStates,
  cloneWorkspaceDescriptors,
  cloneWorkspaceSessions,
  type RecentRepoEntry,
  type SessionData,
  type TerminalCommandPreset,
  type TerminalCommandStep,
} from '../../shared/bridgegit';

type SessionPatch = Partial<Omit<SessionData, 'panelLayout' | 'panelLayoutsByWorkspace' | 'workspaceRepoPanelStates'>> & {
  panelLayout?: Partial<SessionData['panelLayout']>;
  panelLayoutsByWorkspace?: SessionData['panelLayoutsByWorkspace'];
  workspaceRepoPanelStates?: SessionData['workspaceRepoPanelStates'];
};

function cloneSession(session: SessionData): SessionData {
  return {
    ...session,
    recentRepos: cloneRecentRepos(session.recentRepos),
    workspaceDescriptors: cloneWorkspaceDescriptors(session.workspaceDescriptors),
    workspaceOrder: [...session.workspaceOrder],
    panelLayout: { ...session.panelLayout },
    panelLayoutsByWorkspace: clonePanelLayoutsByWorkspace(session.panelLayoutsByWorkspace),
    workspaceRepoPanelStates: cloneWorkspaceRepoPanelStates(session.workspaceRepoPanelStates),
    projectTitlesByContext: cloneProjectTitlesByContext(session.projectTitlesByContext),
    workspaceIndicatorVisibility: cloneWorkspaceIndicatorVisibilitySettings(session.workspaceIndicatorVisibility),
    workspaceTabDefaults: cloneWorkspaceTabDefaults(session.workspaceTabDefaults),
    dismissedWorktreePaths: cloneDismissedWorktreePaths(session.dismissedWorktreePaths),
    terminalCommandPresets: cloneTerminalCommandPresets(session.terminalCommandPresets),
    workspaceSessions: cloneWorkspaceSessions(session.workspaceSessions),
  };
}

function cloneRecentRepos(recentRepos: RecentRepoEntry[]): RecentRepoEntry[] {
  return recentRepos.map((repo) => ({ ...repo }));
}

function cloneTerminalCommandStep(step: TerminalCommandStep): TerminalCommandStep {
  if (step.type === 'delay') {
    return { ...step };
  }

  if (step.type === 'wait-for-prompt') {
    return { ...step };
  }

  return { ...step };
}

function cloneTerminalCommandPresets(terminalCommandPresets: TerminalCommandPreset[]): TerminalCommandPreset[] {
  return terminalCommandPresets.map((preset) => ({
    ...preset,
    steps: preset.steps.map((step) => cloneTerminalCommandStep(step)),
  }));
}

function mergeSession(base: SessionData, patch: SessionPatch): SessionData {
  return {
    ...base,
    ...patch,
    recentRepos: patch.recentRepos
      ? cloneRecentRepos(patch.recentRepos)
      : cloneRecentRepos(base.recentRepos),
    workspaceDescriptors: patch.workspaceDescriptors
      ? cloneWorkspaceDescriptors(patch.workspaceDescriptors)
      : cloneWorkspaceDescriptors(base.workspaceDescriptors),
    workspaceOrder: patch.workspaceOrder
      ? [...patch.workspaceOrder]
      : [...base.workspaceOrder],
    panelLayout: {
      ...base.panelLayout,
      ...patch.panelLayout,
    },
    panelLayoutsByWorkspace: patch.panelLayoutsByWorkspace
      ? clonePanelLayoutsByWorkspace(patch.panelLayoutsByWorkspace)
      : clonePanelLayoutsByWorkspace(base.panelLayoutsByWorkspace),
    workspaceRepoPanelStates: patch.workspaceRepoPanelStates
      ? cloneWorkspaceRepoPanelStates(patch.workspaceRepoPanelStates)
      : cloneWorkspaceRepoPanelStates(base.workspaceRepoPanelStates),
    projectTitlesByContext: patch.projectTitlesByContext
      ? cloneProjectTitlesByContext(patch.projectTitlesByContext)
      : cloneProjectTitlesByContext(base.projectTitlesByContext),
    workspaceIndicatorVisibility: patch.workspaceIndicatorVisibility
      ? cloneWorkspaceIndicatorVisibilitySettings(patch.workspaceIndicatorVisibility)
      : cloneWorkspaceIndicatorVisibilitySettings(base.workspaceIndicatorVisibility),
    workspaceTabDefaults: patch.workspaceTabDefaults
      ? cloneWorkspaceTabDefaults(patch.workspaceTabDefaults)
      : cloneWorkspaceTabDefaults(base.workspaceTabDefaults),
    dismissedWorktreePaths: patch.dismissedWorktreePaths
      ? cloneDismissedWorktreePaths(patch.dismissedWorktreePaths)
      : cloneDismissedWorktreePaths(base.dismissedWorktreePaths),
    terminalCommandPresets: patch.terminalCommandPresets
      ? cloneTerminalCommandPresets(patch.terminalCommandPresets)
      : cloneTerminalCommandPresets(base.terminalCommandPresets),
    workspaceSessions: patch.workspaceSessions
      ? cloneWorkspaceSessions(patch.workspaceSessions)
      : cloneWorkspaceSessions(base.workspaceSessions),
  };
}

export function useSession() {
  const session = ref<SessionData>(cloneSession(DEFAULT_SESSION_DATA));

  async function loadSession(): Promise<SessionData> {
    if (!window.bridgegit?.session) {
      return session.value;
    }

    const loadedSession = await window.bridgegit.session.load();
    session.value = mergeSession(DEFAULT_SESSION_DATA, loadedSession);
    return session.value;
  }

  async function saveSession(patch: SessionPatch): Promise<SessionData> {
    const nextSession = mergeSession(session.value, patch);

    if (!window.bridgegit?.session) {
      session.value = nextSession;
      return session.value;
    }

    const savedSession = await window.bridgegit.session.save(nextSession);
    session.value = mergeSession(DEFAULT_SESSION_DATA, savedSession);
    return session.value;
  }

  return {
    session,
    loadSession,
    saveSession,
  };
}
