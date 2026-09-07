import type { PluginAction } from "@jmfederico/pi-web/plugin-api";
import { statusCache } from "./cache.ts";
import { PANEL_LOCAL_ID } from "./panel.ts";

export function createActions(runtimePluginId: string): PluginAction[] {
  const panelId = `${runtimePluginId}:${PANEL_LOCAL_ID}`;
  return [
    {
      id: "workspace.open-pr",
      title: "Open Pull Request panel",
      description: "Open the GitHub pull request status panel for this workspace",
      group: "Workspace",
      enabled: (context) => context.state.selectedWorkspace !== undefined,
      run: (context) => {
        context.selectWorkspaceTool(panelId);
      },
    },
    {
      id: "workspace.refresh-pr",
      title: "Refresh GitHub PR status",
      description: "Re-run the pull request status probe for the selected workspace",
      group: "Workspace",
      enabled: (context) => context.state.selectedWorkspace !== undefined,
      run: (context) => {
        void context.refreshWorkspacePanels(panelId);
      },
    },
    {
      id: "workspace.open-pr-on-github",
      title: "Open pull request on GitHub",
      description: "Open the current pull request in a new tab",
      group: "Workspace",
      enabled: (context) => currentPrUrl(context) !== undefined,
      run: (context) => {
        const url = currentPrUrl(context);
        if (url !== undefined) window.open(url, "_blank", "noopener,noreferrer");
      },
    },
  ];
}

interface ActionStateLike {
  state: {
    selectedWorkspace?: { id: string; projectId: string };
    selectedMachine?: { id: string };
  };
}

function currentPrUrl(context: ActionStateLike): string | undefined {
  const workspace = context.state.selectedWorkspace;
  if (workspace === undefined) return undefined;
  const machineId = context.state.selectedMachine?.id ?? "local";
  return statusCache.statusByKey(machineId, workspace.projectId, workspace.id)?.pr?.url;
}
