/**
 * Importable items a user can pull into the Planner from a repository's
 * provider: Azure DevOps work items (the task board) and GitHub issues. Pull
 * requests have their own richer `RemotePullRequest` contract (they can be
 * launched into the Review Board); these lighter shapes become plain Planner
 * tasks carrying a link back to the source item.
 */

/** A work item from an Azure DevOps project's board (Bug, Task, User Story…). */
export interface RemoteWorkItem {
  provider: 'azure-devops';
  /** Provider-native work-item id. */
  id: number;
  title: string;
  /** Web URL that opens the work item in Azure DevOps. */
  url: string;
  /** Work-item type, e.g. `Bug`, `Task`, `User Story`. */
  type: string;
  /** Current workflow state, e.g. `Active`, `New`, `Committed`. */
  state: string;
  /** Display name of the assignee, or null when unassigned. */
  assignedTo: string | null;
}

/** An open issue on a GitHub repository. */
export interface RemoteIssue {
  provider: 'github';
  /** Provider-native issue number. */
  number: number;
  title: string;
  /** Web URL of the issue. */
  url: string;
  /** Issue state, normally `open` for the listed set. */
  state: string;
  /** Author's login, when known. */
  author: string | null;
  /** Logins of the users the issue is assigned to. */
  assignees: string[];
  /** Label names applied to the issue. */
  labels: string[];
  /** ISO-8601 creation timestamp, or null when unknown. */
  createdAt: string | null;
}
