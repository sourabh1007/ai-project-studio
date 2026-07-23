/**
 * Shared icon set. These wrap `lucide-react` — a modern, consistent line-icon
 * package — behind small local components so the rest of the app keeps a stable
 * import surface (`size`, `className`, and a few behavioural props) regardless
 * of the underlying icon library.
 */
import type { ComponentType } from 'react';
import {
  Activity,
  Check,
  ChevronRight,
  Circle,
  Clock,
  Coins,
  Download,
  FileText,
  Files,
  Gauge,
  History,
  Moon,
  PanelLeftClose,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  Sun,
  Timer,
  Trash2,
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

// Navigation icons.
export const FilesIcon = makeIcon(Files);
export const SettingsIcon = makeIcon(Settings);
export const SunIcon = makeIcon(Sun);
export const MoonIcon = makeIcon(Moon);

// Dashboard section icons.
export const OverviewIcon = makeIcon(Gauge);
export const UsageIcon = makeIcon(Coins);
export const ActivityIcon = makeIcon(Activity);
export const TimeIcon = makeIcon(Timer);
export const HistoryIcon = makeIcon(History);
export const SummaryIcon = makeIcon(FileText);
