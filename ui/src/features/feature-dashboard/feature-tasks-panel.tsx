import { useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import { ErrorText } from '../../components/ui.js';
import {
  CheckIcon,
  PlusIcon,
  RefreshIcon,
  TaskPlanSkillIcon,
  TrashIcon,
} from '../../components/icons.js';
import { hasTaskPlanSkill, taskProgress } from '../../lib/task-progress.js';

/**
 * Feature checklist delivered by the task-plan skill. Renders only when a
 * task-plan skill is tagged to the feature. Supports AI generation, manual
 * add, toggle-done with a progress bar, and removal — all on demand.
 */
export function FeatureTasksPanel({ featureId }: { featureId: string }) {
  const api = useApi();
  const skills = useAsync(() => api.listFeatureSkills(featureId), [featureId]);
  const tasks = useAsync(() => api.listFeatureTasks(featureId), [featureId]);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!hasTaskPlanSkill(skills.data ?? [])) {
    return null;
  }

  const list = tasks.data ?? [];
  const progress = taskProgress(list);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await action();
      tasks.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function generate() {
    void run(() => api.generateFeatureTasks(featureId));
  }

  function add() {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      return;
    }
    void run(async () => {
      await api.addFeatureTask(featureId, { title: trimmed });
      setTitle('');
    });
  }

  return (
    <section className="tasks-panel">
      <header className="tasks-head">
        <span className="tasks-title">
          <TaskPlanSkillIcon size={15} /> Tasks
        </span>
        <span className="tasks-count">
          {progress.done}/{progress.total}
        </span>
        <button
          type="button"
          className="tree-action"
          title={list.length === 0 ? 'Generate tasks' : 'Regenerate tasks'}
          aria-label={list.length === 0 ? 'Generate tasks' : 'Regenerate tasks'}
          disabled={busy}
          onClick={generate}
        >
          <RefreshIcon />
        </button>
      </header>

      <div className="tasks-progress" role="progressbar" aria-valuenow={progress.percent}>
        <span className="tasks-progress-fill" style={{ width: `${progress.percent}%` }} />
      </div>

      <ul className="tasks-list">
        {list.map((task) => (
          <li key={task.id} className={`task-row task-${task.status}`}>
            <button
              type="button"
              className="task-check"
              title={task.status === 'done' ? 'Mark pending' : 'Mark done'}
              aria-label={task.status === 'done' ? 'Mark pending' : 'Mark done'}
              disabled={busy}
              onClick={() => void run(() => api.toggleFeatureTask(task.id))}
            >
              {task.status === 'done' && <CheckIcon size={12} />}
            </button>
            <span className="task-body">
              <span className="task-title">{task.title}</span>
              {task.detail && <span className="task-detail">{task.detail}</span>}
            </span>
            <button
              type="button"
              className="tree-action task-remove"
              title="Remove task"
              aria-label="Remove task"
              disabled={busy}
              onClick={() => void run(() => api.removeFeatureTask(task.id))}
            >
              <TrashIcon size={13} />
            </button>
          </li>
        ))}
        {!tasks.loading && list.length === 0 && (
          <li className="tasks-empty">
            No tasks yet. Generate a plan or add one below.
          </li>
        )}
      </ul>

      <div className="tasks-add">
        <input
          className="tasks-add-input"
          placeholder="Add a task…"
          value={title}
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              add();
            }
          }}
        />
        <button
          type="button"
          className="tree-action"
          title="Add task"
          aria-label="Add task"
          disabled={busy || title.trim().length === 0}
          onClick={add}
        >
          <PlusIcon />
        </button>
      </div>

      <ErrorText error={error ?? skills.error ?? tasks.error} />
    </section>
  );
}
