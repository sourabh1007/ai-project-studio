import {
  createContext,
  useContext,
  useState,
  type DragEvent,
  type ReactNode,
} from 'react';
import type {
  MoveNodeInput,
  Session,
  TreeGroup,
} from '../../lib/types.js';
import {
  ChevronIcon,
  CheckIcon,
  CloseIcon,
  FolderIcon,
  PencilIcon,
  PlusIcon,
  PullRequestIcon,
  TrashIcon,
} from '../../components/icons.js';
import { OverflowMenu } from '../../components/overflow-menu.js';

/** A node currently being dragged in the feature tree. */
export interface DragNode {
  type: 'session' | 'group';
  id: string;
}

/** Insertion index used when dropping onto a group header (append to end). */
export const APPEND_INDEX = Number.MAX_SAFE_INTEGER;

/** Shared drag state so a node can be dragged from one feature and dropped in
 * another. */
export interface NodeDragStore {
  dragging: DragNode | null;
  setDragging: (node: DragNode | null) => void;
}

const NodeDragStoreContext = createContext<NodeDragStore | null>(null);

/**
 * Provides a single drag state shared by every {@link FeatureTree} beneath it,
 * enabling cross-feature moves of sessions and groups. Without this provider a
 * tree falls back to its own local drag state (moves stay within the feature).
 */
export function NodeDragStoreProvider({ children }: { children: ReactNode }) {
  const [dragging, setDragging] = useState<DragNode | null>(null);
  return (
    <NodeDragStoreContext.Provider value={{ dragging, setDragging }}>
      {children}
    </NodeDragStoreContext.Provider>
  );
}

/** The shared drag store when inside a provider, else null. */
export function useNodeDragStore(): NodeDragStore | null {
  return useContext(NodeDragStoreContext);
}

interface TreeContextValue {
  featureId: string;
  groups: TreeGroup[];
  sessions: Session[];
  ordinals: Map<string, number>;
  dragging: DragNode | null;
  setDragging: (node: DragNode | null) => void;
  onMove: (input: MoveNodeInput) => void;
  onAddSubcategory: (parentGroupId: string | null) => void;
  onAttachPr: (parentGroupId: string | null) => void;
  onRenameGroup: (group: TreeGroup, name: string) => void;
  onDeleteGroup: (group: TreeGroup) => void;
  renderSession: (session: Session, ordinal: number) => ReactNode;
}

const TreeContext = createContext<TreeContextValue | null>(null);

function useTree(): TreeContextValue {
  const ctx = useContext(TreeContext);
  if (!ctx) {
    throw new Error('Tree components must be used within a FeatureTree.');
  }
  return ctx;
}

/** A container's ordered children: groups and sessions share one sort space. */
interface OrderedChild {
  order: number;
  createdAt: string;
  group?: TreeGroup;
  session?: Session;
}

/** Builds the sorted child list for the container identified by `parentGroupId`. */
export function orderedChildren(
  groups: TreeGroup[],
  sessions: Session[],
  parentGroupId: string | null,
): OrderedChild[] {
  const items: OrderedChild[] = [];
  for (const group of groups) {
    if (group.parentGroupId === parentGroupId) {
      items.push({ order: group.orderIndex, createdAt: group.createdAt, group });
    }
  }
  for (const session of sessions) {
    if ((session.groupId ?? null) === parentGroupId) {
      items.push({
        order: session.orderIndex ?? 0,
        createdAt: session.createdAt,
        session,
      });
    }
  }
  return items.sort((a, b) =>
    a.order !== b.order
      ? a.order - b.order
      : a.createdAt.localeCompare(b.createdAt),
  );
}

/** A thin drop zone that inserts the dragged node at `index` in a container. */
function DropSlot({
  parentGroupId,
  index,
}: {
  parentGroupId: string | null;
  index: number;
}) {
  const { featureId, dragging, setDragging, onMove } = useTree();
  const [over, setOver] = useState(false);
  if (!dragging) {
    return null;
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    setOver(false);
    if (!dragging) {
      return;
    }
    onMove({
      type: dragging.type,
      id: dragging.id,
      targetFeatureId: featureId,
      targetParentGroupId: parentGroupId,
      targetIndex: index,
    });
    setDragging(null);
  }

  return (
    <div
      className={`tree-drop-slot ${over ? 'is-over' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
      aria-hidden="true"
    />
  );
}

/** Renders the ordered children of one container, interleaved with drop slots. */
function TreeContainer({
  parentGroupId,
}: {
  parentGroupId: string | null;
}) {
  const { groups, sessions, ordinals, renderSession } = useTree();
  const children = orderedChildren(groups, sessions, parentGroupId);
  return (
    <div className="tree-container">
      <DropSlot parentGroupId={parentGroupId} index={0} />
      {children.map((child, index) => (
        <div key={child.group ? `g:${child.group.id}` : `s:${child.session!.id}`}>
          {child.group ? (
            <GroupNode group={child.group} />
          ) : (
            <DraggableSession
              session={child.session!}
              ordinal={ordinals.get(child.session!.id) ?? index + 1}
            >
              {renderSession(
                child.session!,
                ordinals.get(child.session!.id) ?? index + 1,
              )}
            </DraggableSession>
          )}
          <DropSlot parentGroupId={parentGroupId} index={index + 1} />
        </div>
      ))}
    </div>
  );
}

/** Wraps a rendered session row so it can be picked up and dragged. */
function DraggableSession({
  session,
  children,
}: {
  session: Session;
  ordinal: number;
  children: ReactNode;
}) {
  const { setDragging } = useTree();
  return (
    <div
      className="tree-draggable"
      draggable
      onDragStart={(event) => {
        event.stopPropagation();
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
        }
        setDragging({ type: 'session', id: session.id });
      }}
      onDragEnd={() => setDragging(null)}
    >
      {children}
    </div>
  );
}

/** A group (subcategory folder or PR container) and its recursive subtree. */
function GroupNode({ group }: { group: TreeGroup }) {
  const {
    featureId,
    dragging,
    setDragging,
    onMove,
    onAddSubcategory,
    onAttachPr,
    onRenameGroup,
    onDeleteGroup,
  } = useTree();
  const [expanded, setExpanded] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(group.name);
  const [confirming, setConfirming] = useState(false);
  const [dropTarget, setDropTarget] = useState(false);

  const isPr = group.kind === 'pr';
  const label = isPr
    ? `#${group.prNumber} ${group.name}`
    : group.name;

  function commitName() {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== group.name) {
      onRenameGroup(group, next);
    }
  }

  function handleHeaderDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(false);
    if (!dragging) {
      return;
    }
    onMove({
      type: dragging.type,
      id: dragging.id,
      targetFeatureId: featureId,
      targetParentGroupId: group.id,
      targetIndex: APPEND_INDEX,
    });
    setDragging(null);
  }

  return (
    <div className="tree-group">
      <div
        className={`tree-group-header ${dropTarget ? 'is-drop-target' : ''}`}
        draggable={!editing}
        onDragStart={(event) => {
          event.stopPropagation();
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
          }
          setDragging({ type: 'group', id: group.id });
        }}
        onDragEnd={() => setDragging(null)}
        onDragOver={(event) => {
          if (dragging) {
            event.preventDefault();
            setDropTarget(true);
          }
        }}
        onDragLeave={() => setDropTarget(false)}
        onDrop={handleHeaderDrop}
      >
        <button
          type="button"
          className="tree-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${group.name}` : `Expand ${group.name}`}
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="chevron" aria-hidden="true">
            <ChevronIcon open={expanded} />
          </span>
        </button>
        <span className="tree-group-icon" aria-hidden="true">
          {isPr ? <PullRequestIcon size={14} /> : <FolderIcon size={14} />}
        </span>
        {editing ? (
          <input
            className="feature-name-input"
            autoFocus
            value={draft}
            aria-label="Group name"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commitName();
              } else if (event.key === 'Escape') {
                setEditing(false);
                setDraft(group.name);
              }
            }}
          />
        ) : isPr && group.prUrl ? (
          <a
            className="tree-group-label"
            href={group.prUrl}
            target="_blank"
            rel="noreferrer"
            title={group.prUrl}
          >
            {label}
          </a>
        ) : (
          <button
            type="button"
            className="tree-group-label"
            onDoubleClick={() => {
              setDraft(group.name);
              setEditing(true);
            }}
            title={group.name}
          >
            {label}
          </button>
        )}
        <button
          type="button"
          className="tree-action"
          title="Add subcategory"
          aria-label={`Add subcategory in ${group.name}`}
          onClick={() => {
            setExpanded(true);
            onAddSubcategory(group.id);
          }}
        >
          <PlusIcon />
        </button>
        {confirming ? (
          <span className="row-confirm" role="group" aria-label="Confirm delete">
            <button
              type="button"
              className="row-confirm-yes"
              title="Confirm delete"
              aria-label={`Confirm delete ${group.name}`}
              onClick={() => {
                setConfirming(false);
                onDeleteGroup(group);
              }}
            >
              <CheckIcon />
            </button>
            <button
              type="button"
              className="row-confirm-no"
              title="Cancel"
              aria-label="Cancel delete"
              onClick={() => setConfirming(false)}
            >
              <CloseIcon />
            </button>
          </span>
        ) : (
          <OverflowMenu
            label={`Actions for ${group.name}`}
            actions={[
              {
                label: 'Rename',
                icon: <PencilIcon />,
                onSelect: () => {
                  setDraft(group.name);
                  setEditing(true);
                },
              },
              {
                label: 'Add subcategory',
                icon: <FolderIcon size={14} />,
                onSelect: () => {
                  setExpanded(true);
                  onAddSubcategory(group.id);
                },
              },
              {
                label: 'Attach pull request',
                icon: <PullRequestIcon size={14} />,
                onSelect: () => {
                  setExpanded(true);
                  onAttachPr(group.id);
                },
              },
              {
                label: 'Delete group',
                icon: <TrashIcon />,
                danger: true,
                onSelect: () => setConfirming(true),
              },
            ]}
          />
        )}
      </div>
      {expanded && (
        <div className="tree-group-children">
          <TreeContainer parentGroupId={group.id} />
        </div>
      )}
    </div>
  );
}

/**
 * Renders a feature's organizable work tree: nested subcategory/PR groups with
 * sessions as leaves, all rearrangeable via native drag-and-drop. Session rows
 * themselves are supplied by the caller through `renderSession` so this module
 * owns only the tree structure and drag behaviour.
 */
export function FeatureTree(props: {
  featureId: string;
  groups: TreeGroup[];
  sessions: Session[];
  ordinals: Map<string, number>;
  onMove: (input: MoveNodeInput) => void;
  onAddSubcategory: (parentGroupId: string | null) => void;
  onAttachPr: (parentGroupId: string | null) => void;
  onRenameGroup: (group: TreeGroup, name: string) => void;
  onDeleteGroup: (group: TreeGroup) => void;
  renderSession: (session: Session, ordinal: number) => ReactNode;
}) {
  const shared = useNodeDragStore();
  const [localDragging, setLocalDragging] = useState<DragNode | null>(null);
  const dragging = shared ? shared.dragging : localDragging;
  const setDragging = shared ? shared.setDragging : setLocalDragging;
  const value: TreeContextValue = {
    ...props,
    dragging,
    setDragging,
  };
  return (
    <TreeContext.Provider value={value}>
      <TreeContainer parentGroupId={null} />
    </TreeContext.Provider>
  );
}
