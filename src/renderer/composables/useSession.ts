import { ref } from 'vue';
import {
  DEFAULT_SESSION_DATA,
  cloneClipboardHistoryEntries,
  cloneDismissedWorktreePaths,
  cloneWorkspaceTabDefaults,
  cloneSeenInfoNoteRevisions,
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
    seenInfoNoteRevisions: cloneSeenInfoNoteRevisions(session.seenInfoNoteRevisions),
    clipboardHistory: cloneClipboardHistoryEntries(session.clipboardHistory),
    terminalCommandPresets: cloneTerminalCommandPresets(session.terminalCommandPresets),
    workspaceSessions: cloneWorkspaceSessions(session.workspaceSessions),
  };
}

function serializeSessionForIpc(session: SessionData): SessionData {
  return JSON.parse(JSON.stringify(session)) as SessionData;
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
    seenInfoNoteRevisions: patch.seenInfoNoteRevisions
      ? cloneSeenInfoNoteRevisions(patch.seenInfoNoteRevisions)
      : cloneSeenInfoNoteRevisions(base.seenInfoNoteRevisions),
    clipboardHistory: patch.clipboardHistory
      ? cloneClipboardHistoryEntries(patch.clipboardHistory)
      : cloneClipboardHistoryEntries(base.clipboardHistory),
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
  let saveRevision = 0;
  let saveQueue: Promise<SessionData | null> = Promise.resolve(null);

  function nextPersistenceRevision() {
    saveRevision += 1;
    return saveRevision;
  }

  async function loadSession(): Promise<SessionData> {
    if (!window.bridgegit?.session) {
      return session.value;
    }

    const loadedSession = await window.bridgegit.session.load();
    session.value = mergeSession(DEFAULT_SESSION_DATA, loadedSession);
    saveRevision = Math.max(saveRevision, session.value.persistenceRevision);
    return session.value;
  }

  async function saveSession(patch: SessionPatch): Promise<SessionData> {
    const revision = nextPersistenceRevision();
    const nextSession = mergeSession(session.value, {
      ...patch,
      persistenceRevision: revision,
    });
    session.value = nextSession;

    if (!window.bridgegit?.session) {
      return session.value;
    }

    saveQueue = saveQueue
      .catch(() => null)
      .then(async () => {
        const serializedSession = serializeSessionForIpc(nextSession);
        const savedSession = await window.bridgegit!.session.save(serializedSession);

        if (revision === saveRevision) {
          session.value = mergeSession(DEFAULT_SESSION_DATA, savedSession);
        }

        return mergeSession(DEFAULT_SESSION_DATA, savedSession);
      });

    const savedSession = await saveQueue;
    return savedSession ?? session.value;
  }

  function saveSessionSync(patch: SessionPatch): SessionData | null {
    const nextSession = mergeSession(session.value, {
      ...patch,
      persistenceRevision: nextPersistenceRevision(),
    });
    session.value = nextSession;

    if (!window.bridgegit?.session?.saveSync) {
      return session.value;
    }

    const serializedSession = serializeSessionForIpc(nextSession);
    const savedSession = window.bridgegit.session.saveSync(serializedSession);

    if (!savedSession) {
      return null;
    }

    session.value = mergeSession(DEFAULT_SESSION_DATA, savedSession);
    return session.value;
  }

  return {
    session,
    loadSession,
    saveSession,
    saveSessionSync,
  };
}
