import { useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { Skill, SkillExport, SkillKind, SkillRecommendedScope } from '../../lib/types.js';
import { Button, Card, EmptyState, ErrorText, IconBadge, Modal } from '../../components/ui.js';
import { BrandedLoader, LoadingStatus } from '../../components/loading.js';
import {
  ExportIcon,
  PencilIcon,
  PlusIcon,
  SkillsIcon,
  TrashIcon,
  UploadIcon,
  RefreshIcon,
} from '../../components/icons.js';
import { SkillKindIcon, skillKindLabel, SkillScopeBadge } from './skill-kind.js';
import { SkillForm } from './skill-form.js';
import { isDefiniteRejection } from '../../lib/operation-keys.js';

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
  const skills = useAsync(() => api.listSkills(), [], 'skills');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Skill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [remaining, setRemaining] = useState<Array<{ key: string; payload: SkillExport }>>([]);
  const outcomes = useRef(new Map<string, 'created' | 'unknown'>());

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
    if (uploading) return;
    setError(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as SkillExport | SkillExport[];
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const entries = list.map((payload, index) => ({ key: `${index}:${JSON.stringify(payload)}`, payload }));
      await importRemaining(entries.filter((entry) => !outcomes.current.has(entry.key)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function importRemaining(entries: typeof remaining) {
    setUploading(true);
    setError(null);
    let created = 0;
    let index = 0;
    try {
      for (; index < entries.length; index += 1) {
        const entry = entries[index]!;
        await api.importSkill(entry.payload);
        outcomes.current.set(entry.key, 'created');
        created += 1;
      }
      setRemaining([]);
    } catch (err) {
      const uncertain = !isDefiniteRejection(err);
      if (uncertain) outcomes.current.set(entries[index]!.key, 'unknown');
      setRemaining(entries.slice(index + (uncertain ? 1 : 0)));
      setError(`${created} skill(s) imported. ${err instanceof Error ? err.message : String(err)} ${
        uncertain
          ? 'The last skill may have been imported. Check the list before uploading it again; it is excluded from retry.'
          : 'The rejected and unattempted skills can be retried.'
      }`);
    } finally {
      // An uncertain request may also have committed on the backend.
      skills.reload();
      setUploading(false);
    }
  }

  const list = skills.data ?? [];
  const sections = [
    { name: 'Cosmos DB IDE skills', skills: list.filter((skill) => skill.name.startsWith('Cosmos DB: ')) },
    { name: 'Other IDE skills', skills: list.filter((skill) => !skill.name.startsWith('Cosmos DB: ')) },
  ].filter((section) => section.skills.length > 0);
  const uploadOutcomes = [...outcomes.current.values()];
  const createdCount = uploadOutcomes.filter((outcome) => outcome === 'created').length;
  const unknownCount = uploadOutcomes.filter((outcome) => outcome === 'unknown').length;

  return (
    <Card>
      <div className="page-header">
        <div className="page-header-main">
          <IconBadge
            icon={<SkillsIcon size={24} />}
            tone="ai"
            size="lg"
            glow
          />
          <div>
            <h2 className="page-title">Skills</h2>
            <p className="page-subtitle">
              Reusable instruction blocks you can tag to a feature or a single
              session. Tagged skills are injected into every session run.
            </p>
          </div>
        </div>
        <div className="row">
          <Button variant="ghost" disabled={uploading} onClick={() => fileInput.current?.click()}>
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
      {(createdCount > 0 || unknownCount > 0) && <p role="status">
        {createdCount} skill(s) imported in this batch. {unknownCount > 0 && `${unknownCount} outcome(s) remain unconfirmed. Check the list before uploading those skills again.`} Confirmed and unconfirmed entries are excluded from retry.
      </p>}
      {remaining.length > 0 && <Button disabled={uploading} onClick={() => void importRemaining(remaining)}>
        Retry {remaining.length} remaining skill(s)
      </Button>}
      {skills.error && <p role="status">Skills could not be loaded. The list is unknown, not empty. <Button variant="ghost" onClick={skills.reload}><RefreshIcon size={13} /> Retry loading skills</Button></p>}
      {skills.loading && !skills.data && <BrandedLoader title="Loading skills" detail="Reading your skill library" />}
      {skills.loading && skills.data && <LoadingStatus label="Refreshing skills; showing saved snapshot" />}
      {!skills.loading && !skills.error && list.length === 0 && (
        <EmptyState
          icon={<SkillsIcon size={20} />}
          title="No skills yet"
          description="Skills are reusable instruction blocks you can tag to a feature or session. Create your first one to get started."
          action={{ label: 'New skill', onClick: () => setCreating(true) }}
        />
      )}

      {sections.map((section) => <section key={section.name} aria-label={section.name}>
        <h3>{section.name} ({section.skills.length})</h3>
        {section.name === 'Cosmos DB IDE skills' && <p className="page-subtitle">Relevant guidance is selected automatically for Cosmos DB reviews; explicit review selections take precedence.</p>}
        <div className="skill-list">
        {section.skills.map((skill) => (
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
      </section>)}

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
