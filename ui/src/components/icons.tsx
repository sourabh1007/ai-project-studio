/**
 * Shared icon set. These wrap `lucide-react` — a modern, consistent line-icon
 * package — behind small local components so the rest of the app keeps a stable
 * import surface (`size`, `className`, and a few behavioural props) regardless
 * of the underlying icon library.
 */
import type { ComponentType } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  BookOpen,
  Check,
  ChevronRight,
  Circle,
  Clock,
  Coins,
  Download,
  FileText,
  Files,
  Folder,
  FolderGit2,
  GitPullRequest,
  Gauge,
  History,
  ListChecks,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  ScanSearch,
  Search,
  Settings,
  Sparkles,
  Sun,
  Tag,
  Timer,
  Trash2,
  Upload,
  Wrench,
  X,
  type LucideProps,
} from 'lucide-react';

type IconProps = { size?: number; className?: string };

const STROKE = 1.75;

export function ChevronIcon({
  size = 16,
  open = false,
  className,
}: IconProps & { open?: boolean }) {
  return (
    <ChevronRight
      size={size}
      strokeWidth={STROKE}
      className={className}
      style={{
        transform: open ? 'rotate(90deg)' : 'none',
        transition: 'transform 140ms ease',
      }}
      aria-hidden
    />
  );
}

function makeIcon(Component: ComponentType<LucideProps>) {
  return function Icon({ size = 16, className }: IconProps) {
    return (
      <Component
        size={size}
        strokeWidth={STROKE}
        className={className}
        aria-hidden
      />
    );
  };
}

export const PencilIcon = makeIcon(Pencil);
export const PlusIcon = makeIcon(Plus);
export const TrashIcon = makeIcon(Trash2);
export const ImportIcon = makeIcon(Download);
export const CheckIcon = makeIcon(Check);
export const CloseIcon = makeIcon(X);
export const CollapseSidebarIcon = makeIcon(PanelLeftClose);
export const CircleIcon = makeIcon(Circle);
export const ClockIcon = makeIcon(Clock);
export const RefreshIcon = makeIcon(RefreshCw);
export const MoreIcon = makeIcon(MoreHorizontal);
export const SearchIcon = makeIcon(Search);

// Navigation icons.
export const FilesIcon = makeIcon(Files);
export const RepoIcon = makeIcon(FolderGit2);
export const FolderIcon = makeIcon(Folder);
export const PullRequestIcon = makeIcon(GitPullRequest);
export const PrReviewIcon = makeIcon(ScanSearch);
export const SettingsIcon = makeIcon(Settings);
export const SunIcon = makeIcon(Sun);
export const MoonIcon = makeIcon(Moon);

// Dashboard section icons.
export const OverviewIcon = makeIcon(Gauge);
export const UsageIcon = makeIcon(Coins);
export const ArrowUpIcon = makeIcon(ArrowUp);
export const ArrowDownIcon = makeIcon(ArrowDown);
export const ActivityIcon = makeIcon(Activity);
export const TimeIcon = makeIcon(Timer);
export const HistoryIcon = makeIcon(History);
export const SummaryIcon = makeIcon(FileText);
export const FileIcon = makeIcon(FileText);

// Skills icons.
export const SkillsIcon = makeIcon(Sparkles);
export const McpIcon = makeIcon(Plug);
export const ToolsIcon = makeIcon(Wrench);
export const InstructionSkillIcon = makeIcon(BookOpen);
export const TaskPlanSkillIcon = makeIcon(ListChecks);
export const TagIcon = makeIcon(Tag);
export const ExportIcon = makeIcon(Download);
export const UploadIcon = makeIcon(Upload);
