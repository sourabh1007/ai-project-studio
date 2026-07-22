import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiProvider, apiClient } from './app/api-context.js';
import { App } from './App.js';
import './styles/design-tokens.css';
import './styles/app.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found');
}

createRoot(container).render(
  <StrictMode>
    <ApiProvider value={apiClient}>
      <App />
    </ApiProvider>
  </StrictMode>,
);
