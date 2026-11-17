import type { AudioDeviceState } from '@web/audio/AudioBridge';

/** Everything the floating window shows. The offscreen document owns it and pushes every change. */
export type StationSnapshot = {
  auth: 'loading' | 'signed_out' | 'signed_in' | 'blocked';
  /** Why the account cannot be used here (e-mail not verified, password change, terms…). */
  blockedReason?: string;
  user?: { name: string; email: string };
  tenants: { id: string; name: string; role: string }[];
  tenantId: string;
  busy: boolean;
  /** off: no control channel; ready: identified and able to dial; taken: opened somewhere else. */
  station: 'off' | 'connecting' | 'ready' | 'taken';
  micPermission: 'granted' | 'prompt' | 'denied' | 'unknown';
  call: null | {
    phase: 'dialing' | 'ringing' | 'answered';
    callId?: string;
    name?: string;
    phone: string;
    answeredAt?: number;
    /** The WhatsApp line the call goes out on. */
    line?: string;
    hearing: boolean;
  };
  muted: boolean;
  /** Connected WhatsApp lines the user may pick (leaders and admins; SDRs always get the automatic one). */
  lines: { id: string; label: string; phone: string }[];
  /** '' = automatic: the server picks the least recently used line. */
  lineId: string;
  postCall: null | { id: string; leadName?: string; leadPhone?: string; durationSeconds: number };
  savingPostCall: boolean;
  devices: AudioDeviceState;
  notice: string;
  error: string;
  /** Number sent from a page button (Kommo), waiting to be put in the dialer. */
  prefill?: { phone: string; name?: string; at: number };
};

export type PanelCommand =
  | { cmd: 'login'; email: string; password: string }
  | { cmd: 'logout' }
  | { cmd: 'selectTenant'; tenantId: string }
  | { cmd: 'dial'; phone: string; name?: string }
  | { cmd: 'hangup' }
  | { cmd: 'toggleMute' }
  | { cmd: 'selectLine'; lineId: string }
  | { cmd: 'refreshLines' }
  | { cmd: 'finishPostCall'; callResult: string; pipelineStage: string; notes: string; callbackAt?: string }
  | { cmd: 'takeOver' }
  | { cmd: 'setInput'; deviceId: string }
  | { cmd: 'setOutput'; deviceId: string }
  | { cmd: 'testSpeaker' }
  | { cmd: 'refreshPermission' }
  | { cmd: 'clearError' }
  | { cmd: 'clearPrefill' };

/** Tiny summary for the collapsed bubble in each tab. */
export type BubbleStatus = { inCall: boolean; label: string; answeredAt?: number; postCall: boolean };

export const PANEL_PORT = 'zapliga-panel';
export const BUBBLE_PORT = 'zapliga-bubble';
export const UI_STORAGE_KEY = 'zapliga_ui';
/** pinned = the window is out of the page, in an always-on-top picture-in-picture window. */
export type UiState = { visible: boolean; collapsed: boolean; left: number; top: number; width: number; height: number; pinned?: boolean;
  /** Chrome window (monitor) that shows the floating window; the other windows stay clean. */
  windowId?: number };
