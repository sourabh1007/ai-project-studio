import { useState } from 'react';
import type {
  AgentPromptField,
  ConfigResponse,
  ConfigValue,
} from '../../lib/types.js';
import {
  AiMagicIcon,
  ChevronIcon,
  FileIcon,
  IntelligenceIcon,
  PrReviewIcon,
  PullRequestIcon,
  SearchIcon,
  SummaryIcon,
  WorkspaceContextIcon,
} from '../../components/icons.js';
import { PromptFieldEditor } from '../settings/prompts-commands-section.js';

/** A single editable prompt in the tree. */
interface LeafNode {
  id: string;
  field: AgentPromptField;
  modified: boolean;
}

/** A second-level group (e.g. one review perspective) holding leaves. */
interface SubgroupNode {
  id: string;
  label: string;
  leaves: LeafNode[];
}

/** A top-level category holding direct leaves and/or subgroups. */
interface GroupNode {
  id: string;
  label: string;
  leaves: LeafNode[];
  subgroups: SubgroupNode[];
}

function asString(value: ConfigValue): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

/** True when the field's persisted value differs from its shipped default. */
function isModified(field: AgentPromptField, data: ConfigResponse): boolean {
  const override = data.overrides[field.namespace]?.[field.key];
  const persisted =
    override !== undefined
      ? override
      : data.current[field.namespace]?.[field.key];
  const current = asString(persisted);
  const defaultValue = asString(data.defaults[field.namespace]?.[field.key]);
  return current !== defaultValue;
}

/**
 * Organise a flat list of prompt fields into a two-level tree, preserving the
 * order in which fields appear. Fields with no `group` fall into a default
 * "Prompts" category; fields with a `subgroup` nest one level deeper.
 */
function buildTree(fields: AgentPromptField[], data: ConfigResponse): GroupNode[] {
  const groups: GroupNode[] = [];
  const groupIndex = new Map<string, GroupNode>();
  const subIndex = new Map<string, SubgroupNode>();

  for (const field of fields) {
    const groupLabel = field.group ?? 'Prompts';
    let group = groupIndex.get(groupLabel);
    if (!group) {
      group = { id: `g:${groupLabel}`, label: groupLabel, leaves: [], subgroups: [] };
      groupIndex.set(groupLabel, group);
      groups.push(group);
    }
    const leaf: LeafNode = {
      id: `${field.namespace}.${field.key}`,
      field,
      modified: isModified(field, data),
    };
    if (field.subgroup) {
      const subKey = `${groupLabel}//${field.subgroup}`;
      let sub = subIndex.get(subKey);
      if (!sub) {
        sub = { id: `s:${subKey}`, label: field.subgroup, leaves: [] };
        subIndex.set(subKey, sub);
        group.subgroups.push(sub);
      }
      sub.leaves.push(leaf);
    } else {
      group.leaves.push(leaf);
    }
  }
  return groups;
}

function groupIcon(label: string) {
  switch (label) {
    case 'Foundation':
      return <WorkspaceContextIcon size={16} />;
    case 'Review perspectives':
      return <PrReviewIcon size={16} />;
    case 'PR analysis':
      return <PullRequestIcon size={16} />;
    default:
      return <FileIcon size={16} />;
  }
}

function leafIcon(field: AgentPromptField) {
  if (field.key === 'commonReviewGuidance') return <AiMagicIcon size={14} />;
  if (field.key.endsWith('Focus')) return <SearchIcon size={14} />;
  if (field.key.endsWith('IssueFormat')) return <SummaryIcon size={14} />;
  return <FileIcon size={14} />;
}

function modifiedCount(leaves: LeafNode[]): number {
  return leaves.reduce((n, l) => n + (l.modified ? 1 : 0), 0);
}

/** One editable prompt row: a clickable header that reveals the editor. */
function LeafRow({
  leaf,
  depth,
  open,
  onToggle,
  data,
  onSaved,
}: {
  leaf: LeafNode;
  depth: number;
  open: boolean;
  onToggle: () => void;
  data: ConfigResponse;
  onSaved: () => void;
}) {
  return (
    <div className="apt-leaf">
      <button
        type="button"
        className="apt-row apt-leaf-head"
        style={{ paddingLeft: 12 + depth * 20 }}
        onClick={onToggle}
        aria-expanded={open}
      >
        <ChevronIcon size={14} open={open} className="apt-caret" />
        <span className="apt-icon" aria-hidden="true">
          {leafIcon(leaf.field)}
        </span>
        <span className="apt-leaf-title">{leaf.field.label}</span>
        {leaf.modified && (
          <span className="apt-dot" title="Modified from default" aria-label="Modified" />
        )}
      </button>
      {open && (
        <div className="apt-leaf-editor" style={{ paddingLeft: 12 + depth * 20 }}>
          <PromptFieldEditor field={leaf.field} data={data} onSaved={onSaved} />
        </div>
      )}
    </div>
  );
}

/**
 * A collapsible tree over an agent's editable prompts. Everything is collapsed
 * by default; the caret arrows convey the category → perspective → prompt
 * hierarchy, and clicking a prompt reveals its inline editor.
 */
export function AgentPromptTree({
  fields,
  data,
  onSaved,
}: {
  fields: AgentPromptField[];
  data: ConfigResponse;
  onSaved: () => void;
}) {
  const groups = buildTree(fields, data);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="agent-prompt-tree" role="tree">
      {groups.map((group) => {
        const groupOpen = expanded.has(group.id);
        const count =
          group.leaves.length +
          group.subgroups.reduce((n, s) => n + s.leaves.length, 0);
        const mod =
          modifiedCount(group.leaves) +
          group.subgroups.reduce((n, s) => n + modifiedCount(s.leaves), 0);
        return (
          <div className="apt-group" key={group.id} role="treeitem" aria-expanded={groupOpen}>
            <button
              type="button"
              className="apt-row apt-group-head"
              onClick={() => toggle(group.id)}
              aria-expanded={groupOpen}
            >
              <ChevronIcon size={16} open={groupOpen} className="apt-caret" />
              <span className="apt-icon apt-group-icon" aria-hidden="true">
                {groupIcon(group.label)}
              </span>
              <span className="apt-group-title">{group.label}</span>
              <span className="apt-count">{count}</span>
              {mod > 0 && <span className="apt-mod-pill">{mod} modified</span>}
            </button>
            {groupOpen && (
              <div className="apt-group-body" role="group">
                {group.leaves.map((leaf) => (
                  <LeafRow
                    key={leaf.id}
                    leaf={leaf}
                    depth={1}
                    open={expanded.has(leaf.id)}
                    onToggle={() => toggle(leaf.id)}
                    data={data}
                    onSaved={onSaved}
                  />
                ))}
                {group.subgroups.map((sub) => {
                  const subOpen = expanded.has(sub.id);
                  const subMod = modifiedCount(sub.leaves);
                  return (
                    <div className="apt-sub" key={sub.id} role="treeitem" aria-expanded={subOpen}>
                      <button
                        type="button"
                        className="apt-row apt-sub-head"
                        style={{ paddingLeft: 32 }}
                        onClick={() => toggle(sub.id)}
                        aria-expanded={subOpen}
                      >
                        <ChevronIcon size={15} open={subOpen} className="apt-caret" />
                        <span className="apt-icon" aria-hidden="true">
                          <IntelligenceIcon size={15} />
                        </span>
                        <span className="apt-sub-title">{sub.label}</span>
                        <span className="apt-count">{sub.leaves.length}</span>
                        {subMod > 0 && (
                          <span className="apt-mod-pill">{subMod} modified</span>
                        )}
                      </button>
                      {subOpen && (
                        <div className="apt-sub-body" role="group">
                          {sub.leaves.map((leaf) => (
                            <LeafRow
                              key={leaf.id}
                              leaf={leaf}
                              depth={2}
                              open={expanded.has(leaf.id)}
                              onToggle={() => toggle(leaf.id)}
                              data={data}
                              onSaved={onSaved}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
