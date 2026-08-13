import { useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { Skill, SkillExport, SkillKind, SkillRecommendedScope } from '../../lib/types.js';
import { Button, Card, EmptyState, ErrorText, Modal } from '../../components/ui.js';
import { SkeletonCards } from '../../components/loading.js';
import {
  ExportIcon,
  PencilIcon,
  PlusIcon,
  SkillsIcon,
  TrashIcon,
  UploadIcon,
} from '../../components/icons.js';
import { SkillKindIcon, skillKindLabel, SkillScopeBadge } from './skill-kind.js';
import { SkillForm } from './skill-form.js';

function downloadJson(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function SkillsManager() {
  const api = useApi();
  const skills = useAsync(() => api.listSkills(), []);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Skill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  async function create(input: {
    name: string;
    kind: SkillKind;
    instructions: string;
    removalInstructions: string;
    recommendedScope: SkillRecommendedScope;
  }) {
    await api.createSkill(input);
    setCreating(false);
    skills.reload();
  }

  async function update(
    id: string,
    input: {
      name: string;
      instructions: string;
      removalInstructions: string;
      recommendedScope: SkillRecommendedScope;
    },
  ) {
    await api.updateSkill(id, input);
    setEditing(null);
    skills.reload();
  }

  async function remove(skill: Skill) {
    setError(null);
    try {
      await api.deleteSkill(skill.id);
      skills.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function exportOne(skill: Skill) {
    const data = await api.exportSkill(skill.id);
    downloadJson(`${skill.name}.skill.json`, data);
  }

  async function exportAll() {
    const data = await api.exportSkills();
    downloadJson('skills.json', data);
  }

  async function onUpload(file: File) {
    setError(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as SkillExport | SkillExport[];
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const payload of list) {
        await api.importSkill(payload);
      }
      skills.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const list = skills.data ?? [];

  return (
    <Card>
      <div className="page-header">
        <div>
          <h2 className="page-title">Skills</h2>
          <p className="page-subtitle">
            Reusable instruction blocks you can tag to a feature or a single
            session. Tagged skills are injected into every session run.
          </p>
        </div>
        <div className="row">
          <Button variant="ghost" onClick={() => fileInput.current?.click()}>
            <span className="btn-icon">
              <UploadIcon size={15} />
            </span>
            Upload
          </Button>
          <Button
            variant="ghost"
            onClick={exportAll}
            disabled={list.length === 0}
          >
            <span className="btn-icon">
              <ExportIcon size={15} />
            </span>
            Download all
          </Button>
          <Button onClick={() => setCreating(true)}>
            <span className="btn-icon">
              <PlusIcon size={15} />
            </span>
            New skill
          </Button>
        </div>
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            void onUpload(file);
          }
          event.target.value = '';
        }}
      />

      <ErrorText error={error ?? skills.error} />
      {skills.loading && <SkeletonCards cards={3} />}
      {!skills.loading && list.length === 0 && (
        <EmptyState
          icon={<SkillsIcon size={20} />}
          title="No skills yet"
          description="Skills are reusable instruction blocks you can tag to a feature or session. Create your first one to get started."
          action={{ label: 'New skill', onClick: () => setCreating(true) }}
        />
      )}

      <div className="skill-list">
        {list.map((skill) => (
          <div key={skill.id} className="skill-card">
            <div className="skill-card-head">
              <span className={`skill-chip skill-chip-${skill.kind}`}>
                <SkillKindIcon kind={skill.kind} />
                {skillKindLabel(skill.kind)}
              </span>
              <SkillScopeBadge scope={skill.recommendedScope} />
              <div className="skill-card-actions">
                <button
                  type="button"
                  className="tree-action"
                  title="Edit"
                  aria-label={`Edit ${skill.name}`}
                  onClick={() => setEditing(skill)}
                >
                  <PencilIcon />
                </button>
                <button
                  type="button"
                  className="tree-action"
                  title="Download"
                  aria-label={`Download ${skill.name}`}
                  onClick={() => void exportOne(skill)}
                >
                  <ExportIcon />
                </button>
                <button
                  type="button"
                  className="tree-action tree-action-danger"
                  title="Delete"
                  aria-label={`Delete ${skill.name}`}
                  onClick={() => void remove(skill)}
                >
                  <TrashIcon />
                </button>
              </div>
            </div>
            <span className="skill-card-name" title={skill.name}>
              {skill.name}
            </span>
            {skill.instructions && (
              <p className="skill-card-body">{skill.instructions}</p>
            )}
          </div>
        ))}
      </div>

      {creating && (
        <Modal title="New skill" onClose={() => setCreating(false)}>
          <SkillForm onSubmit={create} onCancel={() => setCreating(false)} />
        </Modal>
      )}
      {editing && (
        <Modal title="Edit skill" onClose={() => setEditing(null)}>
          <SkillForm
            initial={editing}
            onSubmit={(input) => update(editing.id, input)}
            onCancel={() => setEditing(null)}
          />
        </Modal>
      )}
    </Card>
  );
}
