import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiProvider, apiClient } from './app/api-context.js';
import { App } from './App.js';
import { ErrorBoundary } from './components/error-boundary.js';
import { AgencyInstallGate } from './features/bootstrap/agency-install-gate.js';
import {
  TabPopout,
  readTabPopoutFromLocation,
} from './features/workspace/tab-popout.js';
import './styles/design-tokens.css';
import './styles/app.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found');
}

// A detached window renders only its one tab (a session terminal or an agent
// board), not the full IDE. The main process encodes the tab into the URL when
// it spawns the window.
const popout = readTabPopoutFromLocation(
  window.location.search,
  window.location.hash,
);

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <ApiProvider value={apiClient}>
        {popout ? (
          <TabPopout tab={popout.tab} label={popout.label} />
        ) : (
          <AgencyInstallGate>
            <App />
          </AgencyInstallGate>
        )}
      </ApiProvider>
    </ErrorBoundary>
  </StrictMode>,
);
