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
  const BUBBLE = 56;
  let ui: UiState = { visible: true, collapsed: false, left: -1, top: -1, width: 340, height: 540 };

  const host = document.createElement('div');
  host.id = 'zapliga-extension-root';
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; left: 0; top: 0; width: 0; height: 0;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    * { box-sizing: border-box; }
    .win { position: fixed; display: flex; flex-direction: column; background: #fff; border: 1px solid #d0d5dd; border-radius: 14px; overflow: hidden;
      box-shadow: 0 16px 40px rgba(16,24,40,.18), 0 2px 6px rgba(16,24,40,.08); font: 600 13px/1 Inter, system-ui, -apple-system, 'Segoe UI', sans-serif; }
    .bar { height: 34px; flex: none; display: flex; align-items: center; gap: 8px; padding: 0 6px 0 12px; background: #073b5c; color: #fff; cursor: grab; user-select: none; touch-action: none; }
    .bar:active { cursor: grabbing; }
    .title { flex: 1; letter-spacing: .2px; } .title b { color: #5cc1ff; font-weight: 800; }
    .bar button { all: unset; width: 26px; height: 26px; display: grid; place-items: center; border-radius: 6px; color: #fff; cursor: pointer; font-size: 16px; }
    .bar button:hover { background: rgba(255,255,255,.14); }
    iframe { flex: 1; width: 100%; border: 0; background: #fff; color-scheme: light; }
    .grip { position: absolute; left: 0; bottom: 0; width: 18px; height: 18px; cursor: nesw-resize; touch-action: none;
      background: linear-gradient(45deg, transparent 0 45%, #98a2b3 45% 52%, transparent 52% 64%, #98a2b3 64% 71%, transparent 71%); }
    .grip.right { left: auto; right: 0; cursor: nwse-resize; background: linear-gradient(-45deg, transparent 0 45%, #98a2b3 45% 52%, transparent 52% 64%, #98a2b3 64% 71%, transparent 71%); }
    .shield { position: absolute; inset: 34px 0 0; display: none; } .dragging .shield { display: block; }
    .bubble { all: unset; position: fixed; width: ${BUBBLE}px; height: ${BUBBLE}px; border-radius: 50%; background: #078be8; color: #fff; display: grid; place-items: center;
      box-shadow: 0 10px 28px rgba(16,24,40,.28); cursor: pointer; touch-action: none; user-select: none; font: 800 15px/1 Inter, system-ui, sans-serif; }
    .bubble.call { background: #12b76a; animation: pulse 1.6s infinite; } .bubble.post { background: #f79009; }
    .bubble small { position: absolute; bottom: -20px; left: 50%; transform: translateX(-50%); white-space: nowrap; background: #1d2939; color: #fff; padding: 3px 7px; border-radius: 999px; font: 600 11px/1.2 Inter, system-ui, sans-serif; }
    .bubble small:empty { display: none; }
    @keyframes pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(18,183,106,.5), 0 10px 28px rgba(16,24,40,.28); } 50% { box-shadow: 0 0 0 10px rgba(18,183,106,0), 0 10px 28px rgba(16,24,40,.28); } }
    [hidden] { display: none !important; }
  </style>
  <div class="win" part="win"><div class="bar"><span class="title">Zap<b>Liga</b></span><button class="min" title="Recolher">–</button><button class="close" title="Fechar (clique no ícone da extensão para abrir de novo)">×</button></div>
  <div class="shield"></div><div class="grip" title="Arraste para mudar o tamanho"></div><div class="grip right" title="Arraste para mudar o tamanho"></div></div>
  <button class="bubble" title="Abrir o ZapLiga"><span>ZL</span><small></small></button>`;

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
    win.hidden = !ui.visible || ui.collapsed;
    bubble.hidden = !ui.visible || !ui.collapsed;
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
