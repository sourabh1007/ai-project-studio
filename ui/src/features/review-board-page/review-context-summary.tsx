import type { ChangeGraphStep, ReviewBoard } from '../../lib/types.js';

/** Specific evidence-derived context, not just a generic project classification. */
export function ReviewContextSummary({
  board, graph, loading, error, onOpenFiles,
}: {
  board: ReviewBoard;
  graph: ChangeGraphStep | null;
  loading: boolean;
  error: string | null;
  onOpenFiles(): void;
}) {
  const projectIds = new Set(graph?.nodes.filter((node) => node.kind === 'changed').map((node) => node.projectId));
  const projects = (graph?.projects ?? []).filter((project) => projectIds.has(project.id));
  const names = projects.map((project) => project.name);
  const languages = [...new Set([...board.model.primaryLanguages, ...board.model.secondaryLanguages])];
  return (
    <div className="rb-context-summary">
      <details>
        <summary>
          <span>{names.length ? names.join(', ') : board.model.projectType}</span>
          <span className="muted"> · Project details</span>
        </summary>
        <dl>
          <dt>Project type</dt><dd>{board.model.projectType}</dd>
          <dt>Projects</dt><dd>{projects.length
            ? projects.map((project) => <div key={project.id}>{project.name}{project.path && <> · <code>{project.path}</code></>}</div>)
            : loading ? 'Loading project evidence…' : 'No project manifests identified in the change graph.'}</dd>
          <dt>Languages</dt><dd>{languages.join(', ') || 'Not identified'}</dd>
          <dt>Components</dt><dd>{board.model.changedComponents.join(', ') || 'Not identified'}</dd>
          <dt>Modules</dt><dd>{board.model.changedModules.join(', ') || 'Not identified'}</dd>
          <dt>Runtime paths</dt><dd>{board.model.changedRuntimePaths.join(', ') || 'Not identified'}</dd>
          <dt>Deployment</dt><dd>{board.model.deploymentModel || 'Not identified'}</dd>
          <dt>Base branch</dt><dd>{board.baseBranch ?? 'Unknown'}</dd>
          <dt>Commit</dt><dd><code>{board.pull.headSha ?? 'Unknown'}</code></dd>
        </dl>
      </details>
      <button type="button" className="rb-act" onClick={onOpenFiles}
        aria-label={`View ${board.changedFiles} changed files`}>
        {board.changedFiles} {board.changedFiles === 1 ? 'file' : 'files'} changed
      </button>
      {error && <span role="status" className="error">{error}</span>}
    </div>
  );
}
