// Floating ZapLiga window injected in every page. The window itself is an extension page
// (panel.html) in an iframe; this script only places it: drag, resize, collapse, hide.
// Position/size/collapsed live in chrome.storage, so every tab shows the same window.
import type { BubbleStatus, UiState } from './shared/types';

(() => {
  if (window.top !== window || (window as any).__zapligaFloating) return;
  (window as any).__zapligaFloating = true;

  const UI_KEY = 'zapliga_ui';
  const MARGIN = 12;
  const MIN_W = 300; const MIN_H = 380;
  const BUBBLE = 54;
  let ui: UiState = { visible: true, collapsed: false, left: -1, top: -1, width: 340, height: 540 };

  const host = document.createElement('div');
  host.id = 'zapliga-extension-root';
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; left: 0; top: 0; width: 0; height: 0;';
  const root = host.attachShadow({ mode: 'closed' });
  const PHONE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z"/></svg>';
  root.innerHTML = `<style>
    * { box-sizing: border-box; }
    .win { position: fixed; display: flex; flex-direction: column; background: #fff; border-radius: 16px 16px 10px 10px; overflow: hidden;
      box-shadow: 0 0 0 1px rgba(16,24,40,.08), 0 24px 48px -12px rgba(16,24,40,.28), 0 6px 14px rgba(16,24,40,.08);
      font: 600 13px/1 Inter, 'Segoe UI', system-ui, -apple-system, sans-serif; animation: pop .16s ease-out; }
    @keyframes pop { from { opacity: 0; transform: translateY(6px) scale(.985); } }
    .bar { height: 36px; flex: none; display: flex; align-items: center; gap: 6px; padding: 0 6px 0 10px; color: #fff; cursor: grab; user-select: none; touch-action: none;
      background: linear-gradient(90deg, #073b5c, #0a4f7c); }
    .bar:active { cursor: grabbing; }
    .mark { width: 20px; height: 20px; border-radius: 6px; display: grid; place-items: center; background: linear-gradient(135deg, #2aa8ff, #078be8); }
    .mark svg { width: 12px; height: 12px; }
    .title { flex: 1; font-size: 13px; letter-spacing: .1px; } .title b { color: #7fd0ff; font-weight: 800; }
    .dots { color: rgba(255,255,255,.35); letter-spacing: 1px; font-size: 14px; margin-right: 4px; }
    .bar button { all: unset; width: 26px; height: 26px; display: grid; place-items: center; border-radius: 7px; color: rgba(255,255,255,.85); cursor: pointer; }
    .bar button:hover { background: rgba(255,255,255,.14); color: #fff; }
    .bar button svg { width: 15px; height: 15px; }
    iframe { flex: 1; width: 100%; border: 0; background: #fff; color-scheme: light; }
    .grip { position: absolute; left: 0; bottom: 0; width: 24px; height: 24px; z-index: 2; cursor: nesw-resize; touch-action: none; }
    .grip.right { left: auto; right: 0; cursor: nwse-resize; }
    .grip::after { content: ''; position: absolute; bottom: 5px; left: 5px; width: 7px; height: 7px; border-left: 2px solid #c4cad4; border-bottom: 2px solid #c4cad4; border-bottom-left-radius: 2px; opacity: 0; transition: opacity .15s; }
    .grip.right::after { left: auto; right: 5px; border-left: 0; border-right: 2px solid #c4cad4; border-bottom-left-radius: 0; border-bottom-right-radius: 2px; }
    .win:hover .grip::after { opacity: 1; }
    .shield { position: absolute; inset: 36px 0 0; display: none; } .dragging .shield { display: block; }
    .bubble { all: unset; position: fixed; width: ${BUBBLE}px; height: ${BUBBLE}px; border-radius: 50%; color: #fff; display: grid; place-items: center; cursor: pointer; touch-action: none; user-select: none;
      background: linear-gradient(135deg, #2aa8ff, #078be8 55%, #0567b8); box-shadow: 0 0 0 3px #fff, 0 12px 28px rgba(7,60,110,.35); transition: transform .12s; }
    .bubble:hover { transform: scale(1.06); }
    .bubble.call { background: linear-gradient(135deg, #34d58c, #12b76a 55%, #039855); animation: pulse 1.6s infinite; }
    .bubble.post { background: linear-gradient(135deg, #fdb022, #f79009 55%, #dc6803); }
    .bubble small { position: absolute; top: calc(100% + 6px); left: 50%; transform: translateX(-50%); white-space: nowrap; background: #0b1f33; color: #fff; padding: 4px 8px; border-radius: 999px;
      font: 700 11px/1.2 Inter, 'Segoe UI', system-ui, sans-serif; font-variant-numeric: tabular-nums; box-shadow: 0 4px 10px rgba(16,24,40,.2); }
    .bubble small:empty { display: none; }
    @keyframes pulse { 0%,100% { box-shadow: 0 0 0 3px #fff, 0 0 0 3px rgba(18,183,106,.5), 0 12px 28px rgba(3,152,85,.35); } 50% { box-shadow: 0 0 0 3px #fff, 0 0 0 14px rgba(18,183,106,0), 0 12px 28px rgba(3,152,85,.35); } }
    [hidden] { display: none !important; }
  </style>
  <div class="win"><div class="bar"><span class="mark">${PHONE}</span><span class="title">Zap<b>Liga</b></span><span class="dots" aria-hidden="true">⋮⋮</span>
    <button class="pin" title="Fixar na tela: fica por cima de tudo, até de outros programas"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5M9 10.8V4h6v6.8l2.5 3.2h-11L9 10.8ZM8 4h8"/></svg></button>
    <button class="min" title="Recolher"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg></button>
    <button class="close" title="Esconder (o ícone da extensão mostra de novo)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>
  <div class="shield"></div><div class="grip" title="Arraste para mudar o tamanho"></div><div class="grip right" title="Arraste para mudar o tamanho"></div></div>
  <button class="bubble" title="Abrir o ZapLiga">${PHONE}<small></small></button>`;

  const win = root.querySelector('.win') as HTMLDivElement;
  const bar = root.querySelector('.bar') as HTMLDivElement;
  const bubble = root.querySelector('.bubble') as HTMLButtonElement;
  const bubbleLabel = bubble.querySelector('small') as HTMLElement;
  let frame: HTMLIFrameElement | null = null;

  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
  const vw = () => document.documentElement.clientWidth || window.innerWidth;
  const vh = () => window.innerHeight;

  const layout = () => {
    const width = clamp(ui.width, MIN_W, vw() - 2 * MARGIN);
    const height = clamp(ui.height, MIN_H, vh() - 2 * MARGIN);
    // -1 = never moved: bottom-right corner.
    const left = clamp(ui.left < 0 ? vw() - width - MARGIN : ui.left, MARGIN, vw() - width - MARGIN);
    const top = clamp(ui.top < 0 ? vh() - height - MARGIN : ui.top, MARGIN, vh() - height - MARGIN);
    Object.assign(win.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    // The bubble sits where the window's top-right corner is, so it opens back in place.
    Object.assign(bubble.style, { left: `${clamp(left + width - BUBBLE, MARGIN, vw() - BUBBLE - MARGIN)}px`, top: `${clamp(top, MARGIN, vh() - BUBBLE - 28)}px` });
    win.hidden = !ui.visible || ui.collapsed || Boolean(ui.pinned);
    bubble.hidden = !ui.visible || !ui.collapsed || Boolean(ui.pinned);
    if (ui.visible && !frame) {
      frame = document.createElement('iframe');
      frame.src = chrome.runtime.getURL('panel.html');
      frame.allow = 'autoplay';
      frame.title = 'ZapLiga';
      win.insertBefore(frame, root.querySelector('.shield'));
    }
    if (!host.isConnected) document.documentElement.appendChild(host);
  };

  const save = (patch: Partial<UiState>) => { ui = { ...ui, ...patch }; layout(); void chrome.storage.local.set({ [UI_KEY]: ui }); };

  // Drag (window bar or bubble) and resize (bottom corners), with pointer capture so the iframe
  // never swallows the movement.
  const track = (handle: HTMLElement, onMove: (dx: number, dy: number, start: DOMRect) => void, onClick?: () => void) => {
    handle.addEventListener('pointerdown', (event) => {
      if ((event.target as HTMLElement).closest('button') && handle === bar) return;
      event.preventDefault();
      const start = win.hidden ? bubble.getBoundingClientRect() : win.getBoundingClientRect();
      const x0 = event.clientX; const y0 = event.clientY; let moved = false;
      handle.setPointerCapture(event.pointerId);
      win.classList.add('dragging');
      const move = (e: PointerEvent) => { const dx = e.clientX - x0; const dy = e.clientY - y0; if (Math.abs(dx) + Math.abs(dy) > 4) moved = true; if (moved) onMove(dx, dy, start); };
      const up = () => {
        handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up);
        win.classList.remove('dragging');
        if (moved) save({}); else onClick?.();
      };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
    });
  };

  const winRect = () => win.getBoundingClientRect();
  track(bar, (dx, dy, s) => { ui = { ...ui, left: s.left + dx, top: s.top + dy }; layout(); });
  track(root.querySelector('.grip.right') as HTMLElement, (dx, dy, s) => { ui = { ...ui, left: s.left, width: s.width + dx, height: s.height + dy }; layout(); });
  track(root.querySelector('.grip:not(.right)') as HTMLElement, (dx, dy, s) => { const width = clamp(s.width - dx, MIN_W, vw()); ui = { ...ui, left: s.right - width, width, height: s.height + dy }; layout(); });
  track(bubble, (dx, dy, s) => { const w = winRect().width || ui.width; ui = { ...ui, left: s.left + BUBBLE - w + dx, top: s.top + dy }; layout(); }, () => save({ collapsed: false }));
  (root.querySelector('.min') as HTMLButtonElement).addEventListener('click', () => save({ collapsed: true }));
  (root.querySelector('.close') as HTMLButtonElement).addEventListener('click', () => save({ visible: false }));
  window.addEventListener('resize', () => layout());

  // "Fixar na tela": Chrome's Document Picture-in-Picture window stays above every window and app,
  // and does not go away when the user clicks elsewhere. It lives as long as this tab is open.
  const pinButton = root.querySelector('.pin') as HTMLButtonElement;
  const pip = (window as any).documentPictureInPicture;
  if (!pip) pinButton.hidden = true;
  pinButton.addEventListener('click', async () => {
    try {
      const rect = win.getBoundingClientRect();
      const pipWindow: Window = await pip.requestWindow({ width: Math.round(rect.width), height: Math.round(rect.height - 36) });
      pipWindow.document.title = 'ZapLiga';
      const style = pipWindow.document.createElement('style');
      style.textContent = 'html,body{margin:0;height:100%;background:#fff;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}';
      pipWindow.document.head.append(style);
      const pinnedFrame = pipWindow.document.createElement('iframe');
      pinnedFrame.src = chrome.runtime.getURL('panel.html?pip=1');
      pinnedFrame.allow = 'autoplay';
      pipWindow.document.body.append(pinnedFrame);
      pipWindow.addEventListener('pagehide', () => { void chrome.runtime.sendMessage({ type: 'pinned', on: false }).catch(() => undefined); });
      await chrome.runtime.sendMessage({ type: 'pinned', on: true });
    } catch { /* the browser refused (no click, or not supported): keep the window in the page */ }
  });

  // Call status on the collapsed bubble, straight from the station.
  let port: any = null;
  let timer: number | undefined;
  const showBubble = (status: BubbleStatus) => {
    bubble.classList.toggle('call', status.inCall);
    bubble.classList.toggle('post', status.postCall && !status.inCall);
    if (timer) window.clearInterval(timer);
    const render = () => {
      if (status.answeredAt) { const s = Math.max(0, Math.floor((Date.now() - status.answeredAt) / 1000)); bubbleLabel.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
      else bubbleLabel.textContent = status.label;
    };
    render();
    if (status.answeredAt) timer = window.setInterval(render, 1000);
  };
  const connectBubble = async () => {
    if (port || !ui.visible) return;
    // After the extension is reloaded/updated this old script loses its connection: stop quietly.
    if (!chrome.runtime?.id) return;
    try { await chrome.runtime.sendMessage({ type: 'ensure-offscreen' }); port = chrome.runtime.connect({ name: 'zapliga-bubble' }); } catch { return; }
    port.onMessage.addListener(showBubble);
    port.onDisconnect.addListener(() => { port = null; window.setTimeout(() => void connectBubble(), 2000); });
  };

  void chrome.storage.local.get(UI_KEY).then((stored: any) => { ui = { ...ui, ...(stored[UI_KEY] ?? {}) }; layout(); void connectBubble(); });
  chrome.storage.onChanged.addListener((changes: any, area: string) => {
    if (area !== 'local' || !changes[UI_KEY]) return;
    ui = { ...ui, ...(changes[UI_KEY].newValue ?? {}) };
    layout();
    void connectBubble();
  });
})();
