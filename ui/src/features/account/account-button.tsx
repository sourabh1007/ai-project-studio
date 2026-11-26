import { useState } from 'react';
import { Avatar } from '../../components/avatar.js';
import { AccountIcon } from '../../components/icons.js';
import { Tooltip } from '../../components/tooltip.js';
import { Modal } from '../../components/ui.js';
import { useGithubIdentity } from '../../hooks/use-github-identity.js';
import { AzureStatusBadge } from '../azure/azure-status.js';
import { GithubStatusBadge } from '../github/github-status.js';

/**
 * Dock entry showing who is signed in: the GitHub profile picture once signed
 * in (initials if the picture cannot load), otherwise a generic account icon.
 * Opens the shared GitHub and Azure DevOps account controls.
 */
export function AccountButton() {
  const identity = useGithubIdentity();
  const [open, setOpen] = useState(false);
  const label = !identity.checked
    ? 'Accounts: checking sign-in'
    : identity.login
      ? `Accounts: signed in to GitHub as ${identity.login}`
      : 'Accounts: not signed in to GitHub';
  return <>
    <Tooltip label={label}>
      <button type="button" className={`activity-item account-button${identity.login ? ' is-signed-in' : ''}`}
        aria-label={label} title={label} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        {identity.login
          ? <Avatar name={identity.login} avatarUrl={identity.avatarUrl} size={24} title={identity.login} />
          : <AccountIcon size={22} />}
        {identity.checked && !identity.login && <span className="account-button-badge" aria-hidden="true" />}
      </button>
    </Tooltip>
    {open && <Modal title="Accounts" onClose={() => setOpen(false)} size="md">
      <div className="account-dialog">
        {identity.login && <div className="account-dialog-hero">
          <Avatar name={identity.login} avatarUrl={identity.avatarUrl} size={56} title={identity.login} />
          <div>
            <strong>{identity.login}</strong>
            <span>GitHub account used by every new CLI session</span>
          </div>
        </div>}
        <GithubStatusBadge />
        <AzureStatusBadge />
      </div>
    </Modal>}
  </>;
}
