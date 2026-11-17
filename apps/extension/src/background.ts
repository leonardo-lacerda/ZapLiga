// Service worker: keeps the offscreen station alive and toggles the floating window.
// No imports here (the file must stay a single script); types only.
import type { UiState } from './shared/types';

const UI_KEY = 'zapliga_ui';
const DEFAULT_UI: UiState = { visible: true, collapsed: false, left: -1, top: -1, width: 340, height: 540 };

let creating: Promise<void> | null = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creating ??= chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Microfone e áudio das ligações do ZapLiga, mantidos enquanto você navega.',
  }).catch((error: unknown) => { if (!/single offscreen/i.test(String(error))) throw error; }).finally(() => { creating = null; });
  await creating;
}

async function readUi(): Promise<UiState> {
  const stored = (await chrome.storage.local.get(UI_KEY))[UI_KEY];
  return { ...DEFAULT_UI, ...(stored ?? {}) };
}

// Which tab holds the always-on-top window: it closes with that tab, so the in-page window must come back.
async function setPinned(on: boolean, tabId?: number) {
  const ui = await readUi();
  await chrome.storage.local.set({ [UI_KEY]: { ...ui, pinned: on } });
  await chrome.storage.session.set({ pinnedTabId: on ? tabId ?? null : null });
}
const clearPinIfTab = async (tabId: number) => {
  const { pinnedTabId } = await chrome.storage.session.get('pinnedTabId');
  if (pinnedTabId === tabId) await setPinned(false);
};
chrome.tabs.onRemoved.addListener((tabId: number) => void clearPinIfTab(tabId));
chrome.tabs.onUpdated.addListener((tabId: number, change: any) => { if (change.status === 'loading') void clearPinIfTab(tabId); });
chrome.runtime.onStartup.addListener(() => void setPinned(false));

const openPermissionTab = () => chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });

// Pages where content scripts cannot run (new tab, chrome://, the Web Store): use a small window.
async function openPanelWindow() {
  await ensureOffscreen();
  await chrome.windows.create({ url: chrome.runtime.getURL('panel.html?window=1'), type: 'popup', width: 360, height: 600 });
}

chrome.action.onClicked.addListener(async (tab: any) => {
  const url = String(tab?.url ?? '');
  if (!/^https?:/.test(url)) { await openPanelWindow(); return; }
  const ui = await readUi();
  // Clicking the icon brings the window open in this Chrome window (and only here); clicking again hides it.
  const here = ui.windowId === tab.windowId;
  const next = here && ui.visible && !ui.collapsed ? { ...ui, visible: false } : { ...ui, visible: true, collapsed: false, windowId: tab.windowId };
  await chrome.storage.local.set({ [UI_KEY]: next });
});

chrome.runtime.onMessage.addListener((request: any, _sender: any, sendResponse: (value: unknown) => void) => {
  if (request?.type === 'ensure-offscreen') { ensureOffscreen().then(() => sendResponse({ ok: true }), (error) => sendResponse({ ok: false, error: String(error) })); return true; }
  if (request?.type === 'whoami') { sendResponse({ windowId: _sender?.tab?.windowId }); return false; }
  if (request?.type === 'pinned') { void setPinned(Boolean(request.on), _sender?.tab?.id); return false; }
    if (request?.type === 'open-permission') { void openPermissionTab(); return false; }
  if (request?.type === 'open-url' && typeof request.url === 'string' && /^https:\/\//.test(request.url)) { void chrome.tabs.create({ url: request.url }); return false; }
  return false;
});

chrome.runtime.onInstalled.addListener(async (details: any) => {
  const ui = await readUi();
  const focused = await chrome.windows.getLastFocused().catch(() => undefined);
  await chrome.storage.local.set({ [UI_KEY]: { ...ui, visible: true, windowId: focused?.id } });
  // Tabs opened before the install have no content script yet: add the window to them now.
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(tabs.map((tab: any) => chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => undefined)));
  if (details.reason === 'install') await openPermissionTab();
});
