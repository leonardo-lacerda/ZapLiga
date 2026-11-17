import { createRoot } from 'react-dom/client';
import { Panel } from './Panel';
import './panel.css';

const params = new URLSearchParams(location.search);
const root = document.getElementById('root')!;

// Opened as its own small window (pages where the extension cannot draw on the page, like a new
// tab): offer the always-on-top window, since a normal window hides behind Chrome on any click.
const pip = (window as any).documentPictureInPicture;
if (params.has('window') && pip) {
  document.body.classList.add('standalone');
  const bar = document.createElement('button');
  bar.className = 'pin-bar';
  bar.textContent = 'Fixar na tela (fica por cima de tudo)';
  bar.addEventListener('click', async () => {
    try {
      const pipWindow: Window = await pip.requestWindow({ width: 340, height: 560 });
      pipWindow.document.title = 'ZapLiga';
      const style = pipWindow.document.createElement('style');
      style.textContent = 'html,body{margin:0;height:100%;background:#fff;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}';
      pipWindow.document.head.append(style);
      const frame = pipWindow.document.createElement('iframe');
      frame.src = chrome.runtime.getURL('panel.html?pip=1');
      pipWindow.document.body.append(frame);
      await chrome.runtime.sendMessage({ type: 'pinned', on: true });
      pipWindow.addEventListener('pagehide', () => { void chrome.runtime.sendMessage({ type: 'pinned', on: false }); });
      root.hidden = true;
      bar.textContent = 'O ZapLiga está fixo na tela. Não feche esta janela (pode minimizar).';
      bar.disabled = true;
      // Keep this window alive (the pinned one closes with it), just out of the way.
      const current = await chrome.windows.getCurrent();
      await chrome.windows.update(current.id, { state: 'minimized' });
    } catch { /* not allowed now: keep the normal window */ }
  });
  document.body.prepend(bar);
} else if (params.has('window')) {
  document.body.classList.add('standalone');
}
createRoot(root).render(<Panel />);
