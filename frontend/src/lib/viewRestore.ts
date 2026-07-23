import type { BrowserViewState } from "../types";
import { hasExplicitViewState } from "./urlState";
import type { LocalWorkspaceState } from "./workspaceStore";

export interface InitialViewChoice {
  view: BrowserViewState;
  restoredLastView: boolean;
}

/** Explicit URLs always win; automatic restoration is limited to an empty view URL. */
export function chooseInitialView(
  search: string,
  urlView: BrowserViewState,
  workspace: LocalWorkspaceState,
): InitialViewChoice {
  if (!hasExplicitViewState(search) && workspace.restoreLastView && workspace.lastView) {
    return { view: workspace.lastView, restoredLastView: true };
  }
  return { view: urlView, restoredLastView: false };
}
