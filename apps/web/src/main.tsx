import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './app/App';
import { AuthProvider } from './features/auth/AuthProvider';
import './styles/global.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><AuthProvider><App /></AuthProvider></React.StrictMode>);
