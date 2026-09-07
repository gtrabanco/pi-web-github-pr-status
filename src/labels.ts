import { explainCiState } from "./guards.ts";
import { statusCache } from "./cache.ts";
import type { CiState, PrStatus } from "./types.ts";
import type { HtmlTemplateTag, WorkspaceLabelContribution, WorkspaceLabelItem } from "@jmfederico/pi-web/plugin-api";

export type LabelDescriptor =
  | { kind: "prLink"; number: number; href: string; title: string; draft: boolean }
  | { kind: "ciDot"; ciState: CiState; href?: string; title: string }
  | { kind: "dirtyDot"; count: number; title: string }
  | { kind: "aheadArrow"; count: number; title: string }
  | { kind: "behindArrow"; count: number; title: string };

/**
 * Pure description of the label items for a workspace status. The lit
 * mapping lives in workspaceLabelItems; this part is unit-testable.
 *
 * Items only render for workspaces with an open PR: labels stay quiet for
 * plain branches, main checkouts, and non-git workspaces.
 */
export function labelDescriptors(status: PrStatus | undefined, showCI: boolean): LabelDescriptor[] {
  if (status === undefined || !status.git) return [];
  const pr = status.pr;
  if (pr === undefined || pr.state !== "OPEN") return [];

  const items: LabelDescriptor[] = [
    {
      kind: "prLink",
      number: pr.number,
      href: pr.url,
      title: pr.isDraft ? `PR #${String(pr.number)} (draft): ${pr.title}` : `PR #${String(pr.number)}: ${pr.title}`,
      draft: pr.isDraft,
    },
  ];

  if (showCI && status.ci.state !== "none") {
    items.push({ kind: "ciDot", ciState: status.ci.state, href: pr.url, title: explainCiState(status.ci) });
  }

  const dirty = status.staged + status.unstaged + status.untracked;
  if (dirty > 0) {
    items.push({
      kind: "dirtyDot",
      count: dirty,
      title: `Uncommitted changes: ${String(status.staged)} staged, ${String(status.unstaged)} unstaged, ${String(status.untracked)} untracked`,
    });
  }

  if (status.ahead > 0) {
    items.push({ kind: "aheadArrow", count: status.ahead, title: `${String(status.ahead)} commit(s) not pushed` });
  }
  if (status.behind > 0) {
    items.push({ kind: "behindArrow", count: status.behind, title: `${String(status.behind)} commit(s) behind upstream` });
  }
  return items;
}

const CI_DOT_COLORS: Record<CiState, string> = {
  none: "transparent",
  passed: "#3fb950",
  running: "#d29922",
  failed: "#f85149",
};

function labelItem(html: HtmlTemplateTag, descriptor: LabelDescriptor): WorkspaceLabelItem {
  switch (descriptor.kind) {
    case "prLink":
      return { type: "link", text: `#${String(descriptor.number)}`, href: descriptor.href, title: descriptor.title, target: "_blank" };
    case "ciDot": {
      const color = CI_DOT_COLORS[descriptor.ciState];
      return {
        type: "render",
        render: () =>
          html`<a
            href=${descriptor.href}
            target="_blank"
            rel="noopener noreferrer"
            title=${descriptor.title}
            style="text-decoration:none;color:${color};font-size:11px;line-height:1"
            >●</a
          >`,
      };
    }
    case "dirtyDot":
      return {
        type: "render",
        render: () =>
          html`<span title=${descriptor.title} style="color:#e3b341;font-weight:600;font-size:11px;line-height:1"
            >✎${String(descriptor.count)}</span
          >`,
      };
    case "aheadArrow":
      return {
        type: "render",
        render: () => html`<span title=${descriptor.title} style="font-weight:600;font-size:11px;line-height:1">↑${String(descriptor.count)}</span>`,
      };
    case "behindArrow":
      return {
        type: "render",
        render: () =>
          html`<span title=${descriptor.title} style="color:var(--pi-muted, #8b949e);font-size:11px;line-height:1">↓${String(descriptor.count)}</span>`,
      };
  }
}

/** Workspace label: compact PR/CI/worktree facts next to the workspace name. */
export function createWorkspaceLabelContribution(html: HtmlTemplateTag): WorkspaceLabelContribution {
  return {
    id: "pr-status",
    order: 15,
    items: (context) => {
      const entry = statusCache.ensureLoaded(context);
      const showCI = entry.settings?.showCI ?? true;
      return labelDescriptors(entry.status, showCI).map((descriptor) => labelItem(html, descriptor));
    },
  };
}
