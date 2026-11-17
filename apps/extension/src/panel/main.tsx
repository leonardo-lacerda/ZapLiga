import { createRoot } from 'react-dom/client';
import { Panel } from './Panel';
import './panel.css';

if (new URLSearchParams(location.search).has('window')) document.body.classList.add('standalone');
createRoot(document.getElementById('root')!).render(<Panel />);
