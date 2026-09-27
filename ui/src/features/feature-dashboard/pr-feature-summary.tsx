import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import { Button, ErrorText } from '../../components/ui.js';

export function pullRequestUrl(description: string): string | null {
  try {
    const url = new URL(description);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return /\/(?:pull|pullrequest)\/\d+(?:\/|$)/i.test(url.pathname) ? url.href : null;
  } catch { return null; }
}

export function PrFeatureSummary({ featureId, url }: { featureId: string; url: string }) {
  const api = useApi();
  const review = useAsync(() => api.getPrReview(featureId), [api, featureId]);
  const pull = review.data?.pull;
  const needsMetadata = Boolean(pull && (!pull.sourceBranch || !pull.author));
  const metadata = useAsync(async () => {
    const stored = review.data;
    if (!stored || !needsMetadata) return null;
    const pulls = await api.listRepoPulls(stored.repoId);
    return pulls.find((entry) => entry.number === stored.pull.number) ?? null;
  }, [api, review.data?.repoId, pull?.number, needsMetadata]);
  const sourceBranch = metadata.data?.sourceBranch || pull?.sourceBranch;
  const author = metadata.data?.author || pull?.author;
  const current = review.data;
  const loading = review.loading || needsMetadata && metadata.loading;
  const error = review.error || metadata.error;

  return <div className="pr-feature-summary">
    <a className="dash-description" href={url} target="_blank" rel="noopener noreferrer">{url}</a>
    {current && <dl className="pr-feature-facts">
      <div><dt>Branch</dt><dd>{sourceBranch || (loading ? 'Loading...' : 'Not available')}
        {current.baseBranch && <> → {current.baseBranch}</>}</dd></div>
      <div><dt>Author</dt><dd>{author || (loading ? 'Loading...' : 'Not available')}</dd></div>
      {current.headSha && <div><dt>Reviewed commit</dt><dd title={current.headSha}>{current.headSha.slice(0, 8)}</dd></div>}
      {current.changedFiles !== null && <div><dt>Changed files</dt><dd>{current.changedFiles}</dd></div>}
    </dl>}
    {review.loading && !current && <span className="field-hint" role="status">Loading PR details...</span>}
    {error && <div className="row">
      <ErrorText error={`PR details: ${error}`} />
      <Button variant="ghost" onClick={() => { review.reload(); metadata.reload(); }}>Retry PR details</Button>
    </div>}
    {current?.worktreePath && <details>
      <summary>Checkout details</summary>
      <p className="field-hint">{current.worktreePath}</p>
      <p className="field-hint">Imported {new Date(current.timestamps.createdAt).toLocaleString()}</p>
    </details>}
  </div>;
}
