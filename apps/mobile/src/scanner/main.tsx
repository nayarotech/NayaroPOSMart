import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ScannerApp } from './ScannerApp';
import './scanner.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ScannerApp />
  </StrictMode>,
);
