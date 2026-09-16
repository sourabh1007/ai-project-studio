import { AiChatIcon, LaunchIcon, PrReviewIcon } from '../components/icons.js';

/**
 * Resolves an agent manifest `icon` id to a rendered glyph. Unknown ids fall
 * back to a generic agent icon so a new agent always renders something.
 */
export function AgentIcon({
  icon,
  size = 16,
}: {
  icon: string;
  size?: number;
}) {
  switch (icon) {
    case 'review-board':
      return <PrReviewIcon size={size} />;
    case 'new-task':
      return <LaunchIcon size={size} />;
    default:
      return <AiChatIcon size={size} />;
  }
}
