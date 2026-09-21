import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

// No theme work before the first render: main applies the saved theme to the window
// (nativeTheme), so `prefers-color-scheme` already matches it when the page loads.
const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
