import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import { createActions } from "./actions.ts";
import { createWorkspaceLabelContribution } from "./labels.ts";
import { createPanelContribution, PrUiController } from "./panel.ts";

/**
 * GitHub PR Status — PI WEB plugin.
 *
 * Shows the open pull request for the workspace branch (number + link), a CI
 * ball (green passing / orange running / red failing / none when there is no
 * CI), worktree dirtiness and push state; adds a Pull Request panel with
 * guarded one-click merge and close without opening GitHub.
 */
const plugin: PiWebPlugin = {
  apiVersion: 4,
  name: "GitHub PR Status",
  activate: ({ runtimePluginId, html, svg }) => {
    const controller = new PrUiController();
    return {
      contributions: {
        actions: createActions(runtimePluginId),
        workspacePanels: [createPanelContribution(html, svg, controller)],
        workspaceLabels: [createWorkspaceLabelContribution(html)],
      },
    };
  },
};

export default plugin;
