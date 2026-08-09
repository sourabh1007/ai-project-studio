import { useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type {
  ReadinessCheck,
  RepoDefinitionContent,
  RepoDefinitionEntry,
  Repository,
  RepoInsights,
} from '../../lib/types.js';
import { EmptyState, ErrorText, Modal } from '../../components/ui.js';
import { Loader } from '../../components/loading.js';
import { UsageBreakdownModal } from '../../components/usage-breakdown.js';
import {
  CheckIcon,
  CloseIcon,
  OverviewIcon,
  RefreshIcon,
  SearchIcon,
  SkillsIcon,
  SummaryIcon,
  UsageIcon,
} from '../../components/icons.js';

const READY_COLOR = '#34d399';
const NOT_READY_COLOR = '#fbbf24';
const SKILLS_COLOR = '#818cf8';
const AGENTS_COLOR = '#22d3ee';
const DOCS_COLOR = '#f472b6';

function Kpi({
  value,
  label,
  accent,
  onClick,
}: {
  value: string;
  label: string;
  accent: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="dash-kpi-bar" style={{ background: accent }} />
      <span className="dash-kpi-value">{value}</span>
      <span className="dash-kpi-label">{label}</span>
    </>
  );
  if (onClick) {
    return (
      <button type="button" className="dash-kpi dash-kpi-button" onClick={onClick}>
        {content}
      </button>
    );
  }
  return <div className="dash-kpi">{content}</div>;
}

function Section({
  icon,
  title,
  hint,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="dash-section">
      <header className="dash-section-head">
        <span className="dash-section-icon" aria-hidden="true">
          {icon}
        </span>
        <h3 className="dash-section-title">{title}</h3>
        {hint && <span className="dash-section-hint">{hint}</span>}
      </header>
      {children}
    </section>
  );
}

function ReadinessRow({ check }: { check: ReadinessCheck }) {
  return (
    <li className={`repo-readiness-row repo-readiness-${check.status}`}>
      <span className="repo-readiness-glyph" aria-hidden="true">
        {check.status === 'pass' ? <CheckIcon size={13} /> : <CloseIcon size={13} />}
      </span>
      <div className="repo-readiness-body">
        <span className="repo-readiness-label">{check.label}</span>
        <span className="repo-readiness-req">{check.requirement}</span>
      </div>
      <span className="repo-readiness-detail">
        {check.detail ?? (check.status === 'pass' ? 'Satisfied' : 'Missing')}
      </span>
    </li>
  );
}

function DefinitionCards({
  entries,
  emptyMessage,
  onOpen,
}: {
  entries: RepoDefinitionEntry[];
  emptyMessage: string;
  onOpen: (entry: RepoDefinitionEntry) => void;
}) {
  if (entries.length === 0) {
    return <EmptyState message={emptyMessage} />;
  }
  return (
    <ul className="repo-insights-defs">
      {entries.map((entry) => (
        <li key={entry.path}>
          <button
            type="button"
            className="repo-insights-def repo-insights-def-button"
            onClick={() => onOpen(entry)}
            title="Open read-only preview"
          >
            <div className="repo-insights-def-head">
              <span className="repo-insights-def-name">{entry.name}</span>
              <span className="repo-insights-def-author">{entry.author}</span>
            </div>
            {entry.description && (
              <p className="repo-insights-def-desc">{entry.description}</p>
            )}
            <code className="repo-insights-def-path">{entry.path}</code>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Read-only preview of a discovered skill/agent/doc file. Fetches the raw
 * file content from the repo's default branch and shows it verbatim.
 */
function DefinitionViewer({
  repoId,
  entry,
  onClose,
}: {
  repoId: string;
  entry: RepoDefinitionEntry;
  onClose: () => void;
}) {
  const api = useApi();
  const file = useAsync<RepoDefinitionContent | null>(
    () => api.getRepoDefinition(repoId, entry.path),
    [repoId, entry.path],
  );
  return (
    <Modal title={entry.name} onClose={onClose}>
      <div className="repo-def-viewer">
        <div className="repo-def-viewer-meta">
          <code className="repo-insights-def-path">{entry.path}</code>
          {file.data && (
            <span className="repo-def-viewer-branch">
              Branch {file.data.branch}
            </span>
          )}
        </div>
        <ErrorText error={file.error} />
        {file.loading && <Loader label="Loading file" />}
        {file.data && (
          <pre className="repo-def-viewer-body" tabIndex={0}>
            {file.data.content}
          </pre>
        )}
      </div>
    </Modal>
  );
}

/**
 * Repo analogue of the feature dashboard: opens as a tab and surfaces
 * agent-readiness, discovered skills and custom agents, and repository usage.
 * Every figure reflects a live on-demand scan of the repo's default branch.
 */
export function RepoDashboard({ repo }: { repo: Repository }) {
  const api = useApi();
  const insights = useAsync<RepoInsights | null>(
    () => api.getRepoInsights(repo.id),
    [repo.id],
  );
  const [viewingUsage, setViewingUsage] = useState(false);
  const [viewing, setViewing] = useState<RepoDefinitionEntry | null>(null);
  const [query, setQuery] = useState('');

  const data = insights.data;
  const providerLabel =
    repo.provider === 'azure-devops' ? 'Azure DevOps' : 'GitHub';
  const passed = data
    ? data.readiness.filter((check) => check.status === 'pass').length
    : 0;
  const total = data?.readiness.length ?? 0;

  const q = query.trim().toLowerCase();
  const matches = (entry: RepoDefinitionEntry): boolean =>
    q === '' ||
    [entry.name, entry.description, entry.author, entry.path].some((value) =>
      value?.toLowerCase().includes(q),
    );
  const skills = data ? data.skills.filter(matches) : [];
  const agents = data ? data.agents.filter(matches) : [];
  const docs = data ? data.docs.filter(matches) : [];
  const hasDefinitions =
    data !== null &&
    (data.skills.length > 0 || data.agents.length > 0 || data.docs.length > 0);

  return (
    <div className="dashboard">
      <header className="dash-header">
        <h2 className="dash-title">{repo.name}</h2>
        <p className="dash-description">
          {providerLabel} · <code>{repo.localPath}</code>
        </p>
        <div className="dash-header-actions">
          <button
            type="button"
            className="dash-refresh"
            onClick={() => insights.reload()}
            disabled={insights.loading}
            title="Re-scan the default branch"
          >
            <RefreshIcon size={13} />
            {insights.loading && data ? 'Rescanning…' : 'Rescan'}
          </button>
        </div>
      </header>

      <ErrorText error={insights.error} />
      {insights.loading && !data && <Loader label="Scanning repository" />}

      {data && (
        <>
          <Section
            icon={<OverviewIcon size={15} />}
            title="Overview"
            hint={`Branch ${data.branch}`}
          >
            <div className="dash-kpis">
              <Kpi
                value={data.agentReady ? 'Ready' : 'Not ready'}
                label="Agent readiness"
                accent={data.agentReady ? READY_COLOR : NOT_READY_COLOR}
              />
              <Kpi
                value={`${passed}/${total}`}
                label="Checks passed"
                accent={data.agentReady ? READY_COLOR : NOT_READY_COLOR}
              />
              <Kpi
                value={String(data.skills.length)}
                label="Skills"
                accent={SKILLS_COLOR}
              />
              <Kpi
                value={String(data.agents.length)}
                label="Custom agents"
                accent={AGENTS_COLOR}
              />
              <Kpi
                value={String(data.docs.length)}
                label="Docs & TSGs"
                accent={DOCS_COLOR}
              />
            </div>
          </Section>

          <Section
            icon={data.agentReady ? <CheckIcon size={15} /> : <CloseIcon size={15} />}
            title="Agent readiness"
            hint={`${passed} of ${total} checks passing`}
          >
            <ul className="repo-readiness-list">
              {data.readiness.map((check) => (
                <ReadinessRow key={check.key} check={check} />
              ))}
            </ul>
          </Section>

          {hasDefinitions && (
            <div className="repo-dash-search">
              <SearchIcon size={14} />
              <input
                type="search"
                className="repo-dash-search-input"
                placeholder="Search skills, agents and docs…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Search skills, agents and docs"
              />
            </div>
          )}

          <Section
            icon={<SkillsIcon size={15} />}
            title="Skills"
            hint={`${skills.length}${q ? ` / ${data.skills.length}` : ''} shown`}
          >
            <DefinitionCards
              entries={skills}
              onOpen={setViewing}
              emptyMessage={
                q && data.skills.length > 0
                  ? 'No skills match your search.'
                  : 'No repo-native skills found on this branch.'
              }
            />
          </Section>

          <Section
            icon={<SkillsIcon size={15} />}
            title="Custom agents"
            hint={`${agents.length}${q ? ` / ${data.agents.length}` : ''} shown`}
          >
            <DefinitionCards
              entries={agents}
              onOpen={setViewing}
              emptyMessage={
                q && data.agents.length > 0
                  ? 'No custom agents match your search.'
                  : 'No custom agent definitions found on this branch.'
              }
            />
          </Section>

          <Section
            icon={<SummaryIcon size={15} />}
            title="Docs & TSGs"
            hint={`${docs.length}${q ? ` / ${data.docs.length}` : ''} shown`}
          >
            <DefinitionCards
              entries={docs}
              onOpen={setViewing}
              emptyMessage={
                q && data.docs.length > 0
                  ? 'No docs match your search.'
                  : 'No documentation or troubleshooting guides found on this branch.'
              }
            />
          </Section>

          <Section icon={<UsageIcon size={15} />} title="Usage & cost">
            <button
              type="button"
              className="repo-dash-usage-btn"
              onClick={() => setViewingUsage(true)}
            >
              <UsageIcon size={14} /> View usage breakdown
            </button>
          </Section>
        </>
      )}

      {!insights.loading && !insights.error && !data && (
        <EmptyState message="No insights are available for this repository yet." />
      )}

      {viewingUsage && (
        <UsageBreakdownModal
          scope={{ kind: 'repo', id: repo.id, label: repo.name }}
          onClose={() => setViewingUsage(false)}
        />
      )}

      {viewing && (
        <DefinitionViewer
          repoId={repo.id}
          entry={viewing}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}
