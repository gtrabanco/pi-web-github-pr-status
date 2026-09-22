import type {
  HtmlTemplateTag,
  SvgTemplateTag,
  WorkspacePanelContext,
  WorkspacePanelContribution,
} from "@jmfederico/pi-web/plugin-api";
import { runWorkspaceCommand, statusCache, StatusCache, CYCLE_WAIT_TIMEOUT_MS } from "./cache.ts";
import { buildCheckoutTargetCommand, buildCloseCommand, buildDeleteLocalBranchCommand, buildMergeCommand, evaluateClose, evaluateMerge, explainCiState } from "./guards.ts";
import { DEFAULT_SETTINGS, MERGE_METHODS, serializeSettings, type Settings } from "./settings.ts";
import { PLUGIN_ID, SETTINGS_PATH } from "./types.ts";
import type { PrStatus } from "./types.ts";

export const PANEL_LOCAL_ID = "workspace.pr";
const ACTIVITY_ELEMENT_TAG = "pi-web-github-pr-activity";
const MERGE_CLOSE_TIMEOUT_MS = 60_000;
/** Activity-element timer cadence: keeps files fresh and the watcher alive. */
const TICK_INTERVAL_MS = 5_000;

interface PrWorkspaceUiState {
  context: WorkspacePanelContext;
  confirm: { kind: "merge" | "close"; reasons: string[] } | null;
  busy: null | "probe" | "merge" | "close" | "settings" | "post-merge";
  outcome: { ok: boolean; message: string; terminalId?: string } | null;
  settingsOpen: boolean;
  draft: Settings | null;
  /** Post-merge state: set after a successful merge to offer follow-up actions. */
  postMerge: {
    targetBranch: string;
    mergedBranch: string;
  } | null;
}

export class PrUiController {
  private readonly cache: StatusCache;
  private readonly states = new Map<string, PrWorkspaceUiState>();

  constructor(cache: StatusCache = statusCache) {
    this.cache = cache;
  }

  stateFor(context: WorkspacePanelContext): PrWorkspaceUiState {
    const key = `${context.machine.id}:${context.workspace.projectId}:${context.workspace.id}`;
    const existing = this.states.get(key);
    if (existing !== undefined) {
      existing.context = context;
      return existing;
    }
    const created: PrWorkspaceUiState = {
      context,
      confirm: null,
      busy: null,
      outcome: null,
      settingsOpen: false,
      draft: null,
      postMerge: null,
    };
    this.states.set(key, created);
    return created;
  }

  connect(context: WorkspacePanelContext): void {
    const state = this.stateFor(context);
    this.cache.ensureLoaded(context);
    void this.syncWatcher(context);
    this.requestRender(state);
  }

  disconnect(context: WorkspacePanelContext): void {
    const key = `${context.machine.id}:${context.workspace.projectId}:${context.workspace.id}`;
    this.states.delete(key);
  }

  /** Timer tick from the activity element: keep files fresh and the watcher alive. */
  tick(context: WorkspacePanelContext): void {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    this.cache.ensureLoaded(context);
    void this.syncWatcher(context);
  }

  /** Ensure the watcher terminal exists and matches the current cadence. */
  private async syncWatcher(context: WorkspacePanelContext): Promise<void> {
    try {
      await this.cache.ensureWatcher(context, this.cache.settingsOf(context));
    } catch {
      // Spawn failures are counted inside the cache and surface via backoff.
    }
  }

  invalidate(context: WorkspacePanelContext): void {
    const state = this.stateFor(context);
    // Reading the scratch files is free; an immediate watcher cycle costs one
    // trigger-file write — never a terminal, which pi-web keeps forever.
    this.cache.requestCycle(context);
    void statusCache
      .refreshFiles(context)
      .then(() => this.requestRender(state))
      .catch(() => this.requestRender(state));
  }

  async refresh(context: WorkspacePanelContext): Promise<void> {
    const state = this.stateFor(context);
    if (state.busy !== null) return;
    state.busy = "probe";
    state.outcome = null;
    this.requestRender(state);
    try {
      const completed = await this.cache.requestCycleAndWait(context, CYCLE_WAIT_TIMEOUT_MS);
      if (!completed) state.outcome = { ok: false, message: "Watcher did not complete a refresh cycle in time. Press Refresh to retry." };
    } catch (error) {
      state.outcome = { ok: false, message: errorMessage(error) };
    } finally {
      state.busy = null;
      this.requestRender(state);
    }
  }

  onMergeClick(context: WorkspacePanelContext): void {
    const state = this.stateFor(context);
    const status = this.cache.entryStatus(context);
    const settings = this.cache.settingsOf(context);
    const evaluation = evaluateMerge(status, settings);
    if (!evaluation.canMerge) {
      state.confirm = null;
      state.outcome = { ok: false, message: evaluation.blockers.join(" · ") };
      this.requestRender(state);
      return;
    }
    if (evaluation.confirmations.length > 0 && state.confirm?.kind !== "merge") {
      state.confirm = { kind: "merge", reasons: evaluation.confirmations };
      state.outcome = null;
      this.requestRender(state);
      return;
    }
    void this.runMerge(context, status, settings);
  }

  onCloseClick(context: WorkspacePanelContext): void {
    const state = this.stateFor(context);
    const status = this.cache.entryStatus(context);
    const evaluation = evaluateClose(status);
    if (!evaluation.canClose) {
      state.confirm = null;
      state.outcome = { ok: false, message: evaluation.blockers.join(" · ") };
      this.requestRender(state);
      return;
    }
    const prNumber = status?.pr?.number;
    if (state.confirm?.kind !== "close") {
      state.confirm = { kind: "close", reasons: [`Close PR #${String(prNumber ?? 0)} without merging?`] };
      state.outcome = null;
      this.requestRender(state);
      return;
    }
    void this.runClose(context, status);
  }

  cancelConfirm(context: WorkspacePanelContext): void {
    const state = this.stateFor(context);
    state.confirm = null;
    this.requestRender(state);
  }

  private async runMerge(context: WorkspacePanelContext, status: PrStatus | undefined, settings: Settings): Promise<void> {
    const state = this.stateFor(context);
    const pr = status?.pr;
    if (pr === undefined) return;
    state.confirm = null;
    state.busy = "merge";
    state.outcome = null;
    state.postMerge = null;
    this.requestRender(state);
    try {
      const run = await runGuardedCommand(context, {
        title: `Merge PR #${String(pr.number)}`,
        command: buildMergeCommand(pr.number, settings),
        op: "merge",
      });
      if (run.exitCode === 0) {
        state.outcome = { ok: true, message: `PR #${String(pr.number)} merged (${settings.merge.method}).` };
        // Offer post-merge actions when configured
        const targetBranch = pr.baseRefName;
        const mergedBranch = pr.headRefName ?? status?.branch;
        if (settings.merge.checkoutTarget && targetBranch !== undefined && mergedBranch !== undefined) {
          state.postMerge = { targetBranch, mergedBranch };
        }
      } else {
        state.outcome = { ok: false, message: `Merge failed (exit ${String(run.exitCode ?? "?")}). Check the terminal output.`, terminalId: run.terminalId };
      }
    } catch (error) {
      state.outcome = { ok: false, message: errorMessage(error) };
    } finally {
      state.busy = null;
      this.cache.requestCycle(context);
      void this.cache.refreshFiles(context).catch(() => undefined);
      this.requestRender(state);
    }
  }

  /** Post-merge: checkout target branch and pull. */
  async postMergeCheckout(context: WorkspacePanelContext): Promise<void> {
    const state = this.stateFor(context);
    const pm = state.postMerge;
    if (pm === null) return;
    state.busy = "post-merge";
    state.outcome = null;
    this.requestRender(state);
    try {
      const run = await runGuardedCommand(context, {
        title: `Checkout ${pm.targetBranch}`,
        command: buildCheckoutTargetCommand(pm.targetBranch),
        op: "post-merge",
      });
      if (run.exitCode === 0) {
        state.outcome = { ok: true, message: `Switched to ${pm.targetBranch} and pulled latest.` };
        state.postMerge = null;
      } else {
        state.outcome = { ok: false, message: `Checkout failed (exit ${String(run.exitCode ?? "?")}).`, terminalId: run.terminalId };
      }
    } catch (error) {
      state.outcome = { ok: false, message: errorMessage(error) };
    } finally {
      state.busy = null;
      this.cache.requestCycle(context);
      void this.cache.refreshFiles(context).catch(() => undefined);
      this.requestRender(state);
    }
  }

  /** Post-merge: delete the merged branch locally. */
  async postMergeDeleteBranch(context: WorkspacePanelContext): Promise<void> {
    const state = this.stateFor(context);
    const pm = state.postMerge;
    if (pm === null) return;
    state.busy = "post-merge";
    state.outcome = null;
    this.requestRender(state);
    try {
      const run = await runGuardedCommand(context, {
        title: `Delete branch ${pm.mergedBranch}`,
        command: buildDeleteLocalBranchCommand(pm.mergedBranch),
        op: "post-merge",
      });
      if (run.exitCode === 0) {
        state.outcome = { ok: true, message: `Branch ${pm.mergedBranch} deleted.` };
        state.postMerge = null;
      } else {
        state.outcome = { ok: false, message: `Delete failed (exit ${String(run.exitCode ?? "?")}).`, terminalId: run.terminalId };
      }
    } catch (error) {
      state.outcome = { ok: false, message: errorMessage(error) };
    } finally {
      state.busy = null;
      this.cache.requestCycle(context);
      void this.cache.refreshFiles(context).catch(() => undefined);
      this.requestRender(state);
    }
  }

  /** Dismiss the post-merge panel. */
  dismissPostMerge(context: WorkspacePanelContext): void {
    const state = this.stateFor(context);
    state.postMerge = null;
    this.requestRender(state);
  }

  private async runClose(context: WorkspacePanelContext, status: PrStatus | undefined): Promise<void> {
    const state = this.stateFor(context);
    const pr = status?.pr;
    if (pr === undefined) return;
    state.confirm = null;
    state.busy = "close";
    state.outcome = null;
    this.requestRender(state);
    try {
      const run = await runGuardedCommand(context, {
        title: `Close PR #${String(pr.number)}`,
        command: buildCloseCommand(pr.number),
        op: "close",
      });
      if (run.exitCode === 0) {
        state.outcome = { ok: true, message: `PR #${String(pr.number)} closed.` };
      } else {
        state.outcome = { ok: false, message: `Close failed (exit ${String(run.exitCode ?? "?")}). Check the terminal output.`, terminalId: run.terminalId };
      }
    } catch (error) {
      state.outcome = { ok: false, message: errorMessage(error) };
    } finally {
      state.busy = null;
      this.cache.requestCycle(context);
      void this.cache.refreshFiles(context).catch(() => undefined);
      this.requestRender(state);
    }
  }

  updateDraft(context: WorkspacePanelContext, mutate: (draft: Settings) => Settings): void {
    const state = this.stateFor(context);
    const current = state.draft ?? this.cache.settingsOf(context);
    state.draft = mutate({ ...current, merge: { ...current.merge } });
    this.requestRender(state);
  }

  toggleSettings(context: WorkspacePanelContext): void {
    const state = this.stateFor(context);
    state.settingsOpen = !state.settingsOpen;
    state.draft = null;
    this.requestRender(state);
  }

  async saveSettings(context: WorkspacePanelContext): Promise<void> {
    const state = this.stateFor(context);
    const draft = state.draft ?? this.cache.settingsOf(context);
    state.busy = "settings";
    state.outcome = null;
    this.requestRender(state);
    try {
      await context.files.writeFile(SETTINGS_PATH, serializeSettings(draft), { overwrite: true });
      state.outcome = { ok: true, message: `Settings saved to ${SETTINGS_PATH}.` };
      state.draft = null;
      state.settingsOpen = false;
    } catch (error) {
      state.outcome = { ok: false, message: `Could not save settings: ${errorMessage(error)}` };
    } finally {
      state.busy = null;
      void this.cache.refreshFiles(context).catch(() => undefined);
      this.requestRender(state);
    }
  }

  resetSettings(context: WorkspacePanelContext): void {
    const state = this.stateFor(context);
    state.draft = { ...DEFAULT_SETTINGS, merge: { ...DEFAULT_SETTINGS.merge } };
    this.requestRender(state);
  }

  requestRender(state: PrWorkspaceUiState): void {
    state.context.host.requestRender();
  }
}

async function runGuardedCommand(
  context: WorkspacePanelContext,
  input: { title: string; command: string; op: string },
): Promise<{ exitCode?: number; terminalId: string }> {
  return await runWorkspaceCommand(context, { ...input, timeoutMs: MERGE_CLOSE_TIMEOUT_MS });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPanelContribution(
  html: HtmlTemplateTag,
  svg: SvgTemplateTag,
  controller: PrUiController,
): WorkspacePanelContribution {
  defineActivityElement(controller);
  return {
    id: PANEL_LOCAL_ID,
    title: "Pull Request",
    icon: svg`
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="6" cy="6" r="2.5"></circle>
        <circle cx="6" cy="18" r="2.5"></circle>
        <circle cx="18" cy="18" r="2.5"></circle>
        <path d="M6 8.5v7"></path>
        <path d="M13 6h3a2 2 0 0 1 2 2v7.5"></path>
        <path d="m13 6 2-2"></path>
        <path d="m13 6 2 2"></path>
      </svg>
    `,
    order: 30,
    routeAliases: ["pull-request", "pr"],
    visible: (context) => {
      // Workspace must have a provider (v2 API). Non-git workspaces are
      // filtered by the status check below (status.git === false).
      if (context.workspace.provider === undefined) return false;
      const status = statusCache.get(context)?.status;
      if (status !== undefined && status.git === false && status.cold !== true) return false;
      return true;
    },
    badge: (context) => {
      const settings = statusCache.settingsOf(context);
      if (!settings.showCI) return undefined;
      const ci = statusCache.get(context)?.status?.ci;
      if (ci === undefined || ci.state === "none" || ci.state === "passed") return undefined;
      const color = ci.state === "failed" ? CI_DOT_COLORS.failed : CI_DOT_COLORS.running;
      return html`<span title=${explainCiState(ci)} style="display:inline-block;width:9px;height:9px;border-radius:999px;background:${color}"></span>`;
    },
    onInvalidate: (context) => {
      controller.invalidate(context);
    },
    render: (context) => renderPanel(html, controller, context),
  };
}

function defineActivityElement(controller: PrUiController): void {
  if (typeof customElements === "undefined" || typeof HTMLElement === "undefined") return;
  if (customElements.get(ACTIVITY_ELEMENT_TAG) !== undefined) return;
  class PrPanelActivityElement extends HTMLElement {
    private contextValue: WorkspacePanelContext | undefined;
    private tickTimer: number | undefined;

    set context(value: WorkspacePanelContext | undefined) {
      applyActivityContextSwap(controller, this.contextValue, value, this.isConnected);
      this.contextValue = value;
    }

    get context(): WorkspacePanelContext | undefined {
      return this.contextValue;
    }

    connectedCallback(): void {
      // Defensive: a stray double connect must not leak a second interval.
      if (this.tickTimer !== undefined) window.clearInterval(this.tickTimer);
      if (this.contextValue !== undefined) controller.connect(this.contextValue);
      this.tickTimer = window.setInterval(() => {
        if (this.contextValue !== undefined) controller.tick(this.contextValue);
      }, TICK_INTERVAL_MS);
    }

    disconnectedCallback(): void {
      if (this.tickTimer !== undefined) window.clearInterval(this.tickTimer);
      this.tickTimer = undefined;
      if (this.contextValue !== undefined) controller.disconnect(this.contextValue);
    }
  }
  customElements.define(ACTIVITY_ELEMENT_TAG, PrPanelActivityElement);
}

/**
 * Context swap for the activity element: pi-web can update `.context` without
 * remounting the element (workspace switch), so the old workspace's UI state
 * must be released and the new one connected — otherwise stale states stay
 * pinned in the controller map forever.
 *
 * IMPORTANT: PI WEB hands a **brand-new context object** to `render` on every
 * host render (`createWorkspacePanelContext` builds a fresh object per call),
 * even when the selected workspace is unchanged. Treating that fresh object as
 * disconnect/reconnect loops forever: connect() → requestRender() → host
 * re-renders with a fresh context → swap → connect() → … To break the loop we
 * key on the **workspace identity** (machine + project + workspace), so two
 * fresh contexts for the same workspace are treated as the same connection and
 * never re-trigger a render.
 */
export function applyActivityContextSwap(
  controller: Pick<PrUiController, "connect" | "disconnect">,
  previous: WorkspacePanelContext | undefined,
  next: WorkspacePanelContext | undefined,
  connected: boolean,
): void {
  if (!connected) return;
  if (previous !== undefined && next !== undefined && workspaceKeyOf(previous) === workspaceKeyOf(next)) {
    return;
  }
  if (previous !== undefined) controller.disconnect(previous);
  if (next !== undefined) controller.connect(next);
}

/** Identity of a panel context: same machine + project + workspace. */
function workspaceKeyOf(context: { machine?: { id?: string }; workspace?: { projectId?: string; id?: string } }): string {
  return `${context.machine?.id ?? ""}:${context.workspace?.projectId ?? ""}:${context.workspace?.id ?? ""}`;
}

const CI_DOT_COLORS = { passed: "#3fb950", running: "#d29922", failed: "#f85149" } as const;

function renderPanel(html: HtmlTemplateTag, controller: PrUiController, context: WorkspacePanelContext) {
  const state = controller.stateFor(context);
  const entry = statusCache.ensureLoaded(context);
  const settings = state.draft ?? statusCache.settingsOf(context);
  const status = entry.status;
  const busy = state.busy !== null;

  return html`
    <section class="ghpr-panel">
      <style .textContent=${panelStyles}></style>
      <pi-web-github-pr-activity .context=${context}></pi-web-github-pr-activity>
      <section class="ghpr-toolbar">
        <strong>Pull Request</strong>
        <div class="ghpr-toolbar-actions">
          <button type="button" ?disabled=${busy} @click=${() => { void controller.refresh(context); }}>Refresh</button>
        </div>
      </section>
      ${renderBody(html, controller, context, state, settings, status, busy)}
    </section>
  `;
}

function renderBody(
  html: HtmlTemplateTag,
  controller: PrUiController,
  context: WorkspacePanelContext,
  state: PrWorkspaceUiState,
  settings: Settings,
  status: PrStatus | undefined,
  busy: boolean,
) {
  if (status === undefined || status.cold === true) {
    return html`<p class="ghpr-muted">${busy ? "Probing workspace…" : "PR status has not been collected yet. Press Refresh."}</p>`;
  }
  if (!status.git) {
    return html`<p class="ghpr-muted">Not a git repository workspace.</p>`;
  }

  const mergeEvaluation = evaluateMerge(status, settings);
  const closeEvaluation = evaluateClose(status);
  const pr = status.pr;

  return html`
    ${status.gh !== undefined && status.gh !== "ok" ? renderGhHint(html, status) : null}
    ${pr === undefined ? renderNoPr(html, status) : renderPrCard(html, pr)}
    ${settings.showCI ? renderCiSection(html, status) : html`<p class="ghpr-muted">CI display is disabled in settings.</p>`}
    ${renderWorktreeSection(html, status)}
    ${renderOutcome(html, state)}
    ${state.postMerge !== null ? renderPostMerge(html, controller, context, state, busy) : null}
    ${pr !== undefined && pr.state === "OPEN" && state.postMerge === null
      ? renderActions(html, controller, context, state, mergeEvaluation, closeEvaluation, busy)
      : null}
    ${renderSettings(html, controller, context, state, settings)}
  `;
}

function renderGhHint(html: HtmlTemplateTag, status: PrStatus) {
  const hint =
    status.gh === "missing"
      ? "GitHub CLI (gh) was not found on this machine. Install it to see pull request and CI status: https://cli.github.com"
      : status.gh === "unauthenticated"
        ? "gh is not authenticated. Run `gh auth login` in a terminal to enable pull request status."
        : `gh error: ${status.ghMessage ?? "unknown error"}`;
  return html`<div class="ghpr-warning" role="status">${hint}</div>`;
}

function renderNoPr(html: HtmlTemplateTag, status: PrStatus) {
  const branch = status.branch === "HEAD" ? "detached HEAD" : (status.branch ?? "unknown branch");
  return html`<p class="ghpr-muted">No open pull request for branch ${branch}.</p>`;
}

function renderPrCard(html: HtmlTemplateTag, pr: NonNullable<PrStatus["pr"]>) {
  const stateChip =
    pr.state === "OPEN" ? (pr.isDraft ? "DRAFT" : "OPEN") : pr.state === "MERGED" ? "MERGED" : "CLOSED";
  return html`
    <section class="ghpr-pr">
      <div class="ghpr-pr-title">
        <a href=${pr.url} target="_blank" rel="noopener noreferrer">PR #${String(pr.number)} — ${pr.title}</a>
        <span class=${`ghpr-chip ghpr-chip-${stateChip.toLowerCase()}`}>${stateChip}</span>
      </div>
      <p class="ghpr-meta">
        ${pr.author === undefined ? null : html`<span>@${pr.author}</span>`}
        ${pr.headRefName === undefined || pr.baseRefName === undefined
          ? null
          : html`<span>${pr.headRefName} → ${pr.baseRefName}</span>`}
        ${pr.mergeable === "CONFLICTING" ? html`<span class="ghpr-conflict">conflicts</span>` : null}
        ${pr.reviewDecision === undefined ? null : html`<span>review: ${pr.reviewDecision.toLowerCase()}</span>`}
      </p>
    </section>
  `;
}

function renderCiSection(html: HtmlTemplateTag, status: PrStatus) {
  const ci = status.ci;
  if (ci.state === "none") {
    return html`<p class="ghpr-muted">${status.pr === undefined ? "No CI checks (status unknown without a PR)." : "No CI checks configured for this pull request."}</p>`;
  }
  return html`
    <section class="ghpr-ci">
      <p class="ghpr-ci-head">
        <span
          class="ghpr-ball"
          title=${explainCiState(ci)}
          style="background:${CI_DOT_COLORS[ci.state as keyof typeof CI_DOT_COLORS]}"
        ></span>
        ${explainCiState(ci)}
      </p>
      ${ci.checks.length === 0
        ? null
        : html`
            <ul class="ghpr-checks">
              ${ci.checks.map(
                (check) => html`
                  <li>
                    <span class=${`ghpr-check-state ghpr-check-${check.state}`}>${checkStateGlyph(check.state)}</span>
                    ${check.url === undefined
                      ? html`<span>${check.name}</span>`
                      : html`<a href=${check.url} target="_blank" rel="noopener noreferrer">${check.name}</a>`}
                  </li>
                `,
              )}
            </ul>
          `}
    </section>
  `;
}

function checkStateGlyph(state: string): string {
  if (state === "passed") return "✓";
  if (state === "failed") return "✗";
  if (state === "running") return "◐";
  return "○";
}

function renderWorktreeSection(html: HtmlTemplateTag, status: PrStatus) {
  const dirty = status.staged + status.unstaged + status.untracked;
  return html`
    <section class="ghpr-git">
      <p class="ghpr-meta">
        <span>${status.branch ?? "unknown branch"}</span>
        ${status.hasUpstream && (status.ahead > 0 || status.behind > 0)
          ? html`<span>↑${String(status.ahead)} ↓${String(status.behind)}</span>`
          : null}
        ${!status.hasUpstream ? html`<span class="ghpr-conflict">no upstream</span>` : null}
      </p>
      <p class="ghpr-meta ${dirty > 0 ? "ghpr-dirty" : ""}">
        ${dirty > 0
          ? html`<span title="Uncommitted changes">✎ ${String(dirty)} changed (${String(status.staged)} staged, ${String(status.unstaged)} unstaged, ${String(status.untracked)} untracked)</span>`
          : html`<span>worktree clean</span>`}
      </p>
    </section>
  `;
}

function renderOutcome(html: HtmlTemplateTag, state: PrWorkspaceUiState) {
  if (state.outcome === null) return null;
  return html`
    <div class=${state.outcome.ok ? "ghpr-success" : "ghpr-error"} role="status">
      ${state.outcome.message}
      ${state.outcome.terminalId === undefined
        ? null
        : html`<button type="button" @click=${() => { state.context.terminal.open({ terminalId: state.outcome?.terminalId }); }}>Open terminal</button>`}
    </div>
  `;
}

function renderPostMerge(
  html: HtmlTemplateTag,
  controller: PrUiController,
  context: WorkspacePanelContext,
  state: PrWorkspaceUiState,
  busy: boolean,
) {
  const pm = state.postMerge;
  if (pm === null) return null;
  return html`
    <section class="ghpr-actions ghpr-post-merge">
      <p class="ghpr-post-merge-title">Merge complete! Next steps:</p>
      <div class="ghpr-buttons">
        <button
          type="button"
          class="ghpr-primary"
          title="Checkout "${pm.targetBranch}" and pull latest changes"
          ?disabled=${busy}
          @click=${() => { void controller.postMergeCheckout(context); }}
        >
          ${state.busy === "post-merge" ? "Working…" : `Checkout ${pm.targetBranch} + pull`}
        </button>
        <button
          type="button"
          title="Delete the merged branch "${pm.mergedBranch}" locally"
          ?disabled=${busy}
          @click=${() => { void controller.postMergeDeleteBranch(context); }}
        >
          ${state.busy === "post-merge" ? "Working…" : `Delete branch ${pm.mergedBranch}`}
        </button>
        <button
          type="button"
          ?disabled=${busy}
          @click=${() => { controller.dismissPostMerge(context); }}
        >
          Dismiss
        </button>
      </div>
    </section>
  `;
}

function renderActions(
  html: HtmlTemplateTag,
  controller: PrUiController,
  context: WorkspacePanelContext,
  state: PrWorkspaceUiState,
  mergeEvaluation: ReturnType<typeof evaluateMerge>,
  closeEvaluation: ReturnType<typeof evaluateClose>,
  busy: boolean,
) {
  const mergeTitle = mergeEvaluation.canMerge
    ? mergeEvaluation.confirmations.length > 0
      ? "Merge with confirmation"
      : "Merge this pull request"
    : mergeEvaluation.blockers.join(" · ");
  const confirm = state.confirm;
  return html`
    <section class="ghpr-actions">
      ${confirm === null
        ? null
        : html`
            <div class="ghpr-warning" role="alert">
              <p>${confirm.reasons.join(" ")}</p>
              <div class="ghpr-confirm-buttons">
                <button
                  type="button"
                  class="ghpr-primary"
                  ?disabled=${busy}
                  @click=${() => { confirm.kind === "merge" ? controller.onMergeClick(context) : controller.onCloseClick(context); }}
                >
                  ${confirm.kind === "merge" ? "Merge anyway" : "Close PR"}
                </button>
                <button type="button" ?disabled=${busy} @click=${() => { controller.cancelConfirm(context); }}>Cancel</button>
              </div>
            </div>
          `}
      <div class="ghpr-buttons">
        <button
          type="button"
          class="ghpr-primary"
          title=${mergeTitle}
          ?disabled=${busy}
          @click=${() => { controller.onMergeClick(context); }}
        >
          ${state.busy === "merge" ? "Merging…" : "Merge"}
        </button>
        <button
          type="button"
          title=${closeEvaluation.canClose ? "Close this pull request" : closeEvaluation.blockers.join(" · ")}
          ?disabled=${busy}
          @click=${() => { controller.onCloseClick(context); }}
        >
          ${state.busy === "close" ? "Closing…" : "Close PR"}
        </button>
      </div>
    </section>
  `;
}

function renderSettings(
  html: HtmlTemplateTag,
  controller: PrUiController,
  context: WorkspacePanelContext,
  state: PrWorkspaceUiState,
  settings: Settings,
) {
  if (!state.settingsOpen) {
    return html`<button type="button" class="ghpr-settings-toggle" @click=${() => { controller.toggleSettings(context); }}>⚙ Settings</button>`;
  }
  const draft = state.draft ?? settings;
  return html`
    <section class="ghpr-settings">
      <p class="ghpr-settings-hint">
        Stored per workspace in <code>${SETTINGS_PATH}</code>. Plugin: ${PLUGIN_ID}.
      </p>
      <label><input type="checkbox" ?checked=${draft.showCI} @change=${(event: Event) => { updateCheckbox(context, controller, event, (d, value) => { d.showCI = value; }); }} /> Show CI status</label>
      <label><input type="checkbox" ?checked=${draft.merge.enabled} @change=${(event: Event) => { updateCheckbox(context, controller, event, (d, value) => { d.merge.enabled = value; }); }} /> Allow one-click merge</label>
      <label><input type="checkbox" ?checked=${draft.merge.requireCleanWorktree} @change=${(event: Event) => { updateCheckbox(context, controller, event, (d, value) => { d.merge.requireCleanWorktree = value; }); }} /> Require clean worktree to merge</label>
      <label
        ><input type="checkbox" ?checked=${draft.merge.requireCI} @change=${(event: Event) => { updateCheckbox(context, controller, event, (d, value) => { d.merge.requireCI = value; }); }} /> Require CI
        confirmation (only when CI exists)</label
      >
      <label
        ><input type="checkbox" ?checked=${draft.merge.deleteBranch} @change=${(event: Event) => { updateCheckbox(context, controller, event, (d, value) => { d.merge.deleteBranch = value; }); }} /> Delete
        branch after merge (remote)</label
      >
      <label><input type="checkbox" ?checked=${draft.merge.checkoutTarget} @change=${(event: Event) => { updateCheckbox(context, controller, event, (d, value) => { d.merge.checkoutTarget = value; }); }} /> Offer checkout to target branch after merge</label>
      <label><input type="checkbox" ?checked=${draft.merge.deleteBranchAfterMerge} @change=${(event: Event) => { updateCheckbox(context, controller, event, (d, value) => { d.merge.deleteBranchAfterMerge = value; }); }} /> Offer delete merged branch after merge</label>
      <label><input type="checkbox" ?checked=${draft.adaptiveRefresh} @change=${(event: Event) => { updateCheckbox(context, controller, event, (d, value) => { d.adaptiveRefresh = value; }); }} /> Adaptive refresh (faster when CI is running)</label>
      <label>
        Merge method
        <select
          @change=${(event: Event) => {
            const value = (event.target as HTMLSelectElement).value;
            controller.updateDraft(context, (d) => { d.merge.method = value === "squash" ? "squash" : value === "rebase" ? "rebase" : "merge"; return d; });
          }}
        >
          ${MERGE_METHODS.map(
            (method) => html`<option value=${method} ?selected=${draft.merge.method === method}>${method}</option>`,
          )}
        </select>
      </label>
      <label>
        Refresh every
        <input
          type="number"
          min="0"
          max="3600"
          step="5"
          .value=${String(draft.refreshSeconds)}
          @change=${(event: Event) => {
            const raw = (event.target as HTMLInputElement).value;
            const seconds = Math.max(0, Math.min(3600, Math.floor(Number(raw))));
            controller.updateDraft(context, (d) => { d.refreshSeconds = Number.isFinite(seconds) ? seconds : 0; return d; });
          }}
        />
        seconds (0 = pauses the background watcher; adaptive refresh runs at most every 30s)
      </label>
      <div class="ghpr-settings-actions">
        <button type="button" class="ghpr-primary" ?disabled=${state.busy === "settings"} @click=${() => { void controller.saveSettings(context); }}>Save</button>
        <button type="button" @click=${() => { controller.resetSettings(context); }}>Reset to defaults</button>
        <button type="button" @click=${() => { controller.toggleSettings(context); }}>Close</button>
      </div>
    </section>
  `;
}

function updateCheckbox(
  context: WorkspacePanelContext,
  controller: PrUiController,
  event: Event,
  apply: (draft: Settings, value: boolean) => void,
): void {
  const value = (event.target as HTMLInputElement).checked;
  controller.updateDraft(context, (draft) => {
    apply(draft, value);
    return draft;
  });
}

const panelStyles = `
  .ghpr-panel { flex: 1 1 auto; min-height: 0; overflow: auto; color: var(--pi-text); background: var(--pi-bg); font: 13px system-ui, sans-serif; display: flex; flex-direction: column; }
  .ghpr-panel ${ACTIVITY_ELEMENT_TAG} { display: none; }
  .ghpr-panel button { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-surface); color: var(--pi-text); padding: 5px 8px; cursor: pointer; font-size: 12px; }
  .ghpr-panel button:disabled { cursor: wait; opacity: .6; }
  .ghpr-panel button.ghpr-primary { border-color: var(--pi-accent); color: var(--pi-accent); }
  .ghpr-panel a { color: var(--pi-accent); text-decoration: none; }
  .ghpr-panel a:hover { text-decoration: underline; }
  .ghpr-toolbar { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 8px; border-bottom: 1px solid var(--pi-border-muted); }
  .ghpr-toolbar-actions { display: flex; gap: 8px; margin-left: auto; }
  .ghpr-muted { color: var(--pi-muted); margin: 10px 8px; }
  .ghpr-panel > :not(.ghpr-toolbar) { margin: 8px; }
  .ghpr-warning, .ghpr-error { border: 1px solid var(--pi-warning, #d29922); border-radius: 7px; padding: 8px; color: var(--pi-warning, #d29922); display: flex; flex-direction: column; gap: 6px; }
  .ghpr-error { border-color: var(--pi-danger, #f85149); color: var(--pi-danger, #f85149); }
  .ghpr-success { border: 1px solid var(--pi-success, #3fb950); border-radius: 7px; padding: 8px; color: var(--pi-success, #3fb950); display: flex; align-items: center; gap: 8px; }
  .ghpr-warning p { margin: 0; }
  .ghpr-confirm-buttons, .ghpr-buttons, .ghpr-settings-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .ghpr-pr-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-weight: 600; }
  .ghpr-meta { display: flex; gap: 10px; flex-wrap: wrap; color: var(--pi-muted); margin: 4px 0 0; font-size: 12px; }
  .ghpr-meta span { white-space: nowrap; }
  .ghpr-chip { border: 1px solid var(--pi-border); border-radius: 999px; padding: 0 7px; font-size: 11px; font-weight: 500; }
  .ghpr-chip-open, .ghpr-chip-merged { border-color: var(--pi-success, #3fb950); color: var(--pi-success, #3fb950); }
  .ghpr-chip-closed, .ghpr-chip-draft { border-color: var(--pi-muted); color: var(--pi-muted); }
  .ghpr-conflict { color: var(--pi-danger, #f85149); font-weight: 600; }
  .ghpr-ci-head { display: flex; align-items: center; gap: 8px; margin: 0; }
  .ghpr-ball { width: 10px; height: 10px; border-radius: 999px; display: inline-block; }
  .ghpr-checks { list-style: none; margin: 6px 0 0; padding: 0 0 0 18px; font-size: 12px; display: flex; flex-direction: column; gap: 3px; }
  .ghpr-check-state { display: inline-block; width: 14px; font-weight: 600; }
  .ghpr-check-passed { color: var(--pi-success, #3fb950); }
  .ghpr-check-failed { color: var(--pi-danger, #f85149); }
  .ghpr-check-running { color: #d29922; }
  .ghpr-check-skipped { color: var(--pi-muted); }
  .ghpr-git { border-top: 1px dashed var(--pi-border-muted); padding-top: 8px; }
  .ghpr-dirty span { color: #e3b341; }
  .ghpr-actions { display: flex; flex-direction: column; gap: 8px; border-top: 1px dashed var(--pi-border-muted); padding-top: 8px; }
  .ghpr-settings { display: flex; flex-direction: column; gap: 8px; border-top: 1px dashed var(--pi-border-muted); padding-top: 8px; font-size: 12px; }
  .ghpr-settings label { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .ghpr-settings input[type="number"] { width: 80px; }
  .ghpr-settings select { background: var(--pi-surface); color: var(--pi-text); border: 1px solid var(--pi-border); border-radius: 6px; padding: 3px 6px; }
  .ghpr-settings-hint { color: var(--pi-muted); margin: 0; }
  .ghpr-settings-hint code { font-size: 11px; }
  .ghpr-settings-toggle { align-self: flex-start; margin-top: auto; }
`;
