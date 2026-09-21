import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <main className="p-8 font-sans">
      <h1 className="text-2xl font-semibold">Slack Archive</h1>
      <p className="text-gray-600">Running on {window.archive.platform}.</p>
    </main>
  </StrictMode>,
);
