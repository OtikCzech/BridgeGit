import { ref } from 'vue';
import {
  DEFAULT_SESSION_DATA,
  cloneWorkspaceSessions,
  type RecentRepoEntry,
  type SessionData,
  type TerminalCommandPreset,
  type TerminalCommandStep,
} from '../../shared/bridgegit';

type SessionPatch = Partial<Omit<SessionData, 'panelLayout'>> & {
  panelLayout?: Partial<SessionData['panelLayout']>;
};

function cloneSession(session: SessionData): SessionData {
  return {
    ...session,
    recentRepos: cloneRecentRepos(session.recentRepos),
    panelLayout: { ...session.panelLayout },
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
    panelLayout: {
      ...base.panelLayout,
      ...patch.panelLayout,
    },
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
