// What this extension offers other extensions in the same dashboard: its terminal, and the agent
// pod it opens onto.
//
// The Studio's in-pod service is an HTTP API, registered in api-registry.ts, and is how a pod or a
// CLI reaches the agent's conversations. This is the other half, for code that runs in the same
// browser page: a Vue component and a handful of functions, put where any extension's bundle can
// find them without importing this one - the same `window` the two bundles already share.
//
// Why a terminal is offered rather than described. Every pane in this dashboard that opens onto
// the agent pod should be *this* pane: the same exec subresource, the same cookie Rancher already
// has, the same reconnect, the same image paste, the same clickable paths. The Dev extension's
// first version copied PodTerminal instead, and a copy of a terminal is a terminal that stops
// matching the first time either is fixed. So the component itself is handed over, and the caller
// says only what to run and where to put it: a workspace's conversation list, a pull request's
// review agent, a discussion under one comment. All of them the one pod; each pointed at a
// different conversation.
//
// A global rather than the shell's plugin registry, deliberately. The shell's `register()` is for
// the things the shell itself asks for - models, routes, panels - and a component another
// extension wants is not one of those. A property on window with a version on it, and an event
// when it appears, is the smallest thing that works whichever bundle the dashboard happens to
// load first.
import PodTerminal from './components/PodTerminal.vue';
import {
  AGENT_CONTAINER, agentPod, agentSessions, projectSessions, startAgentSession, startProjectSession,
  renameAgentSession, endAgentSession, queueSessionPrompt, sessionCommand, sessionPane
} from './agent';
import { EXT_NS } from './extensions';

/** Where the API is: `window.__extensionStudio`. */
export const STUDIO_GLOBAL = '__extensionStudio';

/** Fired on `window` when the API is installed, for a bundle that loaded before this one did. */
export const STUDIO_READY_EVENT = 'extension-studio:ready';

export interface StudioBrowserApi {
  /** The Studio's package version, for a caller that needs a feature a given version added. */
  version: string;
  terminal: {
    /**
     * The terminal, as a Vue component: `<component :is="api.terminal.component" target="agent"
     * :command="api.agent.command(id)" @state="...">`. It emits `state` - waiting, connecting,
     * open, closed - for whatever draws a dot for it.
     */
    component: unknown;
  };
  agent: {
    /** The namespace and container every pane opens in. */
    namespace: string;
    container: string;
    /** The agent pod's current name, or null while there is none. Panes find it themselves. */
    pod(): Promise<string | null>;
    /** The argv a pane runs for one conversation: what the component's `command` prop takes. */
    command(id: string, mode?: 'claude' | 'shell'): string[];
    /** The drawer's own conversations. */
    sessions(): Promise<{ id: string; title: string }[]>;
    /** One project's conversations - `p-<project>-<n>`, which the drawer never lists. */
    projectSessions(project: string): Promise<{ id: string; title: string }[]>;
    /** Start a conversation in the drawer, or in a project, optionally with a name and an opening prompt. */
    start(): Promise<string>;
    startInProject(project: string, title?: string, prompt?: string): Promise<string>;
    /** Queue what a conversation opens with; it is read the first time a pane attaches. */
    queue(id: string, prompt: string): Promise<void>;
    rename(id: string, title: string): Promise<void>;
    end(id: string): Promise<void>;
    /** What a conversation's pane is showing, for reading a verdict off it. */
    pane(id: string, lines?: number): Promise<{ text: string; running: boolean }>;
  };
}

export function installBrowserApi(version: string): StudioBrowserApi {
  const api: StudioBrowserApi = {
    version,
    terminal: { component: PodTerminal },
    agent:    {
      namespace:      EXT_NS,
      container:      AGENT_CONTAINER,
      pod:            agentPod,
      command:        sessionCommand,
      sessions:       agentSessions,
      projectSessions,
      start:          startAgentSession,
      startInProject: startProjectSession,
      queue:          queueSessionPrompt,
      rename:         renameAgentSession,
      end:            endAgentSession,
      pane:           sessionPane,
    },
  };

  (window as unknown as Record<string, unknown>)[STUDIO_GLOBAL] = api;
  window.dispatchEvent(new CustomEvent(STUDIO_READY_EVENT, { detail: api }));

  return api;
}
