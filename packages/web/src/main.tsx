import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'diff2html/bundles/css/diff2html.min.css';
import { App } from './App.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
