import {
  type AudioDeviceOption,
  STORAGE_INPUT_KEY,
  STORAGE_OUTPUT_KEY,
  describeDevice,
  pickOutputForInput,
  readStoredDevice,
  resolveStoredSelection,
  toDeviceOptions,
  writeStoredDevice,
} from './audioDevices';

/** How playback reaches the chosen output device. */
export type SinkMode = 'context' | 'element' | 'default';

type SinkableAudioContext = AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };
type SinkableAudioElement = HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> };

export type AudioDeviceState = {
  inputs: AudioDeviceOption[];
  outputs: AudioDeviceOption[];
  /** '' = microfone padrão do sistema. */
  selectedInputId: string;
  /** '' = automático: a saída que pertence ao mesmo aparelho do microfone em uso. */
  selectedOutputId: string;
  activeInputId: string;
  activeInputLabel: string;
  /** '' = saída padrão do sistema. */
  activeOutputId: string;
  activeOutputLabel: string;
  outputSelectionSupported: boolean;
  sinkMode: SinkMode;
  /** Labels only appear after the microphone permission is granted. */
  permissionGranted: boolean;
  capturing: boolean;
};

export type InboundAudioLevel = { receiving: boolean; peak: number; updatedAt: number };

/** Below this the frame is comfort noise or digital silence, not the customer speaking. */
const INBOUND_SIGNAL_THRESHOLD = 200;
/** How long after the last audible frame the customer still counts as "being heard". */
const INBOUND_RECEIVING_WINDOW_MS = 2500;
const INBOUND_REPORT_INTERVAL_MS = 400;
/**
 * Playout backlog bounds. Frames are scheduled back-to-back from the moment they arrive, so any
 * clock drift between the server's 16 kHz pacing and the output device (or a jitter burst that is
 * never repaid) accumulates as delay for the rest of the call -- 1.45 s was measured after four
 * minutes. Above the high mark, frames are dropped until the backlog is back under the low mark:
 * a brief skip once, instead of a conversation that lags more every minute.
 *
 * Waxum already runs a ~120-150 ms jitter buffer and emits paced 20 ms frames, so this second
 * buffer only has to absorb WebSocket/scheduler jitter. The old 0.45/0.2 marks let the backlog
 * park anywhere up to 450 ms for the whole call, which stacked with the upstream buffer, the
 * WhatsApp network and Bluetooth output into ~1 s of mouth-to-ear delay.
 */
const PLAYBACK_BACKLOG_HIGH_S = 0.16;
const PLAYBACK_BACKLOG_LOW_S = 0.08;
/** Cushion when (re)starting playout after an underrun, so the next frame isn't already late. */
const PLAYBACK_START_LEAD_S = 0.04;
/** Frames queued before the AudioContext was ready are stale; replay only the most recent ones. */
const PENDING_PLAYBACK_REPLAY_FRAMES = 4;

function detectSinkMode(): SinkMode {
  if (typeof AudioContext !== 'undefined' && typeof (AudioContext.prototype as SinkableAudioContext).setSinkId === 'function') return 'context';
  if (typeof HTMLMediaElement !== 'undefined' && typeof (HTMLMediaElement.prototype as SinkableAudioElement).setSinkId === 'function') return 'element';
  return 'default';
}

export class AudioBridge {
  private context?: AudioContext;
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private processor?: ScriptProcessorNode;
  private silent?: GainNode;
  private playbackGain?: GainNode;
  private outputDestination?: MediaStreamAudioDestinationNode;
  private outputElement?: SinkableAudioElement;
  private starting?: Promise<void>;
  private resuming?: Promise<void>;
  private socket?: WebSocket;
  private stopRequested = false;
  private nextPlayTime = 0;
  private captureSampleRate = 16000;
  private sourceBuffer: number[] = [];
  private sourceCursor = 0;
  private outgoingSamples: number[] = [];
  private readonly frameSamples = 960;
  private muted = false;
  private pendingPlayback: ArrayBuffer[] = [];
  private activeCallId = '';
  private playbackFramesReceived = 0;
  private playbackFramesScheduled = 0;
  private playbackFramesEnded = 0;
  private playbackFramesDropped = 0;
  private playbackPeak = 0;
  /** True while the backlog is being drained by dropping frames (see PLAYBACK_BACKLOG_*). */
  private shedding = false;

  private readonly sinkMode: SinkMode = detectSinkMode();
  private deviceState: AudioDeviceState = {
    inputs: [],
    outputs: [],
    selectedInputId: readStoredDevice(STORAGE_INPUT_KEY),
    selectedOutputId: readStoredDevice(STORAGE_OUTPUT_KEY),
    activeInputId: '',
    activeInputLabel: '',
    activeOutputId: '',
    activeOutputLabel: '',
    outputSelectionSupported: detectSinkMode() !== 'default',
    sinkMode: detectSinkMode(),
    permissionGranted: false,
    capturing: false,
  };
  private deviceListener?: (state: AudioDeviceState) => void;
  private inboundListener?: (level: InboundAudioLevel) => void;
  private lastAudibleInboundAt = 0;
  private inboundWindowPeak = 0;
  private inboundReportTimer?: number;
  private refreshing?: Promise<void>;
  private readonly onDeviceChange = () => {
    void this.refreshDevices().then(() => this.applySink()).catch(() => undefined);
  };

  constructor() {
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
      // A headset that is plugged in, unplugged or switches Bluetooth profile mid-call changes which
      // endpoint can actually play; re-list and re-route rather than keep talking to a gone device.
      // The handler is a stored field so dispose() can remove it: this listener lives on a global
      // object and pins the whole bridge in memory for as long as it is registered.
      navigator.mediaDevices.addEventListener('devicechange', this.onDeviceChange);
    }
  }

  /** Release everything, including the global devicechange listener. Call when the owner unmounts. */
  async dispose() {
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.removeEventListener) {
      navigator.mediaDevices.removeEventListener('devicechange', this.onDeviceChange);
    }
    this.deviceListener = undefined;
    this.inboundListener = undefined;
    await this.stop();
  }

  // ---------------------------------------------------------------------------
  // Devices
  // ---------------------------------------------------------------------------

  onDeviceState(listener?: (state: AudioDeviceState) => void) {
    this.deviceListener = listener;
    listener?.(this.deviceState);
  }

  onInboundLevel(listener?: (level: InboundAudioLevel) => void) {
    this.inboundListener = listener;
  }

  getDeviceState() {
    return this.deviceState;
  }

  /** Re-list microphones and outputs. Labels are empty until the microphone permission is granted. */
  async refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const inputs = toDeviceOptions(devices, 'audioinput');
        const outputs = toDeviceOptions(devices, 'audiooutput');
        this.patchDeviceState({
          inputs,
          outputs,
          permissionGranted: devices.some((device) => Boolean(device.label)),
          activeInputLabel: this.labelFor(inputs, this.deviceState.activeInputId, 'input'),
        });
      } catch { /* enumeration is a diagnostic aid; a call must not fail because of it */ }
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  /** Choose the microphone. Takes effect immediately if the microphone is already open. */
  async setInputDevice(deviceId: string) {
    writeStoredDevice(STORAGE_INPUT_KEY, deviceId);
    this.patchDeviceState({ selectedInputId: deviceId });
    if (this.stream && this.context) await this.restartCapture();
  }

  /** Choose the output. '' returns to automatic routing (the output of the microphone's own device). */
  async setOutputDevice(deviceId: string) {
    writeStoredDevice(STORAGE_OUTPUT_KEY, deviceId);
    this.patchDeviceState({ selectedOutputId: deviceId });
    await this.applySink();
  }

  /**
   * A short tone through the exact path a call uses (same context, same gain, same sink), so
   * "I hear the tone" means "I will hear the customer" -- and silence here is diagnosed before a
   * lead is on the line instead of during the conversation.
   */
  async playTestTone() {
    const context = await this.ensureContext();
    if (context.state === 'suspended') await context.resume();
    if (context.state !== 'running') throw new Error('O navegador bloqueou a reprodução de áudio. Clique novamente em Testar som.');
    await this.applySink();
    if (!this.playbackGain) throw new Error('Saída de áudio não inicializada.');
    const playbackGain = this.playbackGain;
    await new Promise<void>((resolve) => {
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = 440;
      envelope.gain.value = 0.25;
      oscillator.connect(envelope);
      envelope.connect(playbackGain);
      oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); resolve(); };
      const now = context.currentTime;
      oscillator.start(now);
      oscillator.stop(now + 0.7);
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Opens the browser microphone from an explicit user action. Preparing it
   * when the SDR becomes available avoids discovering a missing device only
   * after WhatsApp has already answered.
   */
  async prepare() {
    if (this.context && this.processor && this.stream) {
      if (this.context.state === 'suspended') await this.context.resume();
      if (this.context.state !== 'running') throw new Error('O navegador bloqueou a reprodução de áudio. Clique novamente em Ligar agora.');
      return;
    }
    if (this.starting) return this.starting;

    this.stopRequested = false;
    this.starting = this.startInternal().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  async start(socket: WebSocket, callId: string) {
    this.socket = socket;
    this.activeCallId = callId;
    await this.prepare();
    if (this.context?.state === 'suspended') await this.context.resume();
    this.reportPlaybackStatus(true);
  }

  private async openMicrophone(): Promise<MediaStream> {
    const selected = this.deviceState.selectedInputId;
    const constraints = (deviceId?: string): MediaStreamConstraints => ({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 16000 },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    try {
      return await navigator.mediaDevices.getUserMedia(constraints(selected || undefined));
    } catch (error) {
      const name = error instanceof DOMException ? error.name : 'AudioError';
      // The remembered microphone is gone (unplugged, renamed after a driver update): fall back to
      // the system default rather than refusing to work until the SDR finds the setting.
      if (selected && (name === 'OverconstrainedError' || name === 'NotFoundError')) {
        writeStoredDevice(STORAGE_INPUT_KEY, '');
        this.patchDeviceState({ selectedInputId: '' });
        return this.openMicrophone();
      }
      let inputs = 0;
      try { inputs = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput').length; } catch { /* diagnóstico opcional */ }
      if (name === 'NotAllowedError' || name === 'SecurityError') throw new Error('O acesso ao microfone está bloqueado. Libere a permissão do microfone para este site e tente conectar novamente.');
      if (name === 'NotFoundError' || !inputs) throw new Error('Nenhum microfone foi encontrado. Conecte um headset ou microfone e tente novamente.');
      if (name === 'NotReadableError' || name === 'AbortError') throw new Error('O microfone está sendo usado ou bloqueado por outro aplicativo. Feche o outro aplicativo e tente novamente.');
      throw new Error('Não foi possível preparar o áudio. Verifique o dispositivo de entrada do Windows e tente novamente.');
    }
  }

  /** The AudioContext and playback graph, created once and shared by calls and the test tone. */
  private async ensureContext(): Promise<AudioContext> {
    if (this.context && this.context.state !== 'closed') return this.context;
    // Keep the physical output at the device's native sample rate. Forcing a
    // 16 kHz context can be silent with some Chrome/Windows audio drivers.
    // Web Audio resamples the 16 kHz call buffers to this output rate.
    const context = new AudioContext({ latencyHint: 'interactive' });
    await context.resume();
    if (context.state !== 'running') {
      await context.close();
      throw new Error('O navegador bloqueou a reprodução de áudio. Clique novamente em Ligar agora.');
    }
    this.context = context;
    this.captureSampleRate = context.sampleRate;
    this.playbackGain = context.createGain();
    this.playbackGain.gain.value = 1;
    if (this.sinkMode === 'element') {
      // No AudioContext.setSinkId here: route playback through a MediaStream into an <audio>
      // element, which can pick its output device on more browsers than the context can.
      this.outputDestination = context.createMediaStreamDestination();
      this.playbackGain.connect(this.outputDestination);
      const element = new Audio() as SinkableAudioElement;
      element.autoplay = true;
      element.srcObject = this.outputDestination.stream;
      this.outputElement = element;
      await element.play().catch(() => undefined);
    } else {
      this.playbackGain.connect(context.destination);
    }
    const pending = this.pendingPlayback.splice(0).slice(-PENDING_PLAYBACK_REPLAY_FRAMES);
    pending.forEach((frame) => this.enqueuePlayback(frame));
    return context;
  }

  private async startInternal() {
    const stream = await this.openMicrophone();
    if (this.stopRequested) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    let context: AudioContext;
    try {
      context = await this.ensureContext();
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      throw error;
    }
    if (this.stopRequested) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.attachCapture(context, stream);
    await this.refreshDevices();
    await this.applySink();
  }

  private attachCapture(context: AudioContext, stream: MediaStream) {
    this.stream = stream;
    this.sourceBuffer = [];
    this.sourceCursor = 0;
    this.outgoingSamples = [];
    const source = context.createMediaStreamSource(stream);
    // ScriptProcessor is retained for this MVP, but its output is reframed
    // below. Waxum/whatsapp-rust accepts exactly 960 mono samples per frame.
    const processor = context.createScriptProcessor(1024, 1, 1);
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const pcm = this.muted
        ? new Int16Array(Math.max(1, Math.round(input.length * 16000 / this.captureSampleRate)))
        : this.resampleToPcm16(input);
      this.outgoingSamples.push(...pcm);
      while (this.outgoingSamples.length >= this.frameSamples) {
        const frame = new Int16Array(this.outgoingSamples.splice(0, this.frameSamples));
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(frame.buffer);
      }
    };
    // A ScriptProcessor only runs while connected to the destination; the zero gain keeps the
    // microphone from being played back to the SDR.
    const silent = context.createGain();
    silent.gain.value = 0;
    source.connect(processor);
    processor.connect(silent);
    silent.connect(context.destination);
    this.source = source;
    this.processor = processor;
    this.silent = silent;
    stream.getAudioTracks().forEach((track) => { track.enabled = !this.muted; });
    const activeInputId = stream.getAudioTracks()[0]?.getSettings().deviceId ?? '';
    this.patchDeviceState({
      capturing: true,
      activeInputId,
      activeInputLabel: this.labelFor(this.deviceState.inputs, activeInputId, 'input'),
    });
  }

  private detachCapture() {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.silent?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.processor = undefined;
    this.source = undefined;
    this.silent = undefined;
    this.stream = undefined;
    this.patchDeviceState({ capturing: false, activeInputId: '', activeInputLabel: '' });
  }

  /** Swap microphones without tearing down the context, so playback never gaps. */
  private async restartCapture() {
    const context = this.context;
    if (!context || context.state === 'closed') return;
    this.detachCapture();
    const stream = await this.openMicrophone();
    if (this.stopRequested || !this.context) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.attachCapture(context, stream);
    await this.refreshDevices();
    await this.applySink();
  }

  /**
   * Point playback at the right output: the SDR's explicit choice, else the output that belongs to
   * the microphone's own device (see `pickOutputForInput`), else the system default.
   */
  private async applySink() {
    const { outputs, inputs, selectedOutputId, activeInputId } = this.deviceState;
    const explicit = resolveStoredSelection(selectedOutputId, outputs);
    const target = explicit || pickOutputForInput(outputs, inputs, activeInputId);
    const label = target ? this.labelFor(outputs, target, 'output') : '';
    if (this.sinkMode === 'default' || !this.context) {
      this.patchDeviceState({ activeOutputId: '', activeOutputLabel: '' });
      return;
    }
    try {
      if (this.sinkMode === 'context') {
        const context = this.context as SinkableAudioContext;
        await context.setSinkId?.(target);
      } else if (this.outputElement) {
        await this.outputElement.setSinkId?.(target);
        await this.outputElement.play().catch(() => undefined);
      }
      this.patchDeviceState({ activeOutputId: target, activeOutputLabel: label });
    } catch {
      // The endpoint refused (gone, or a permission the browser will not grant for it). Fall back
      // to the default so the call has *some* speaker rather than none, and say so in the state.
      try {
        if (this.sinkMode === 'context') await (this.context as SinkableAudioContext).setSinkId?.('');
        else await this.outputElement?.setSinkId?.('');
      } catch { /* default is where an unset sink already points */ }
      this.patchDeviceState({ activeOutputId: '', activeOutputLabel: '' });
    }
    this.reportPlaybackStatus();
  }

  private labelFor(devices: AudioDeviceOption[], deviceId: string, kind: 'input' | 'output') {
    if (!deviceId) return '';
    const index = devices.findIndex((device) => device.deviceId === deviceId);
    if (index < 0) return '';
    return describeDevice(devices[index], index, kind);
  }

  private patchDeviceState(patch: Partial<AudioDeviceState>) {
    this.deviceState = { ...this.deviceState, ...patch };
    this.deviceListener?.(this.deviceState);
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.stream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
  }

  isMuted() {
    return this.muted;
  }

  // ---------------------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------------------

  play(raw: ArrayBuffer | Blob) {
    // Depending on the browser/runtime, a binary WebSocket message can still
    // arrive as a Blob even when binaryType was set to arraybuffer. Convert it
    // before touching byteLength/DataView; otherwise the first inbound frame
    // throws and the SDR hears silence while the server keeps relaying audio.
    if (raw instanceof Blob) {
      void raw.arrayBuffer().then((buffer) => this.play(buffer)).catch(() => undefined);
      return;
    }
    if (raw.byteLength < 2) return;
    if (!this.context || this.context.state === 'suspended' || this.resuming) {
      // Media can arrive in the same turn as media_open, before getUserMedia
      // and the AudioContext have finished initializing. Keep a bounded queue
      // instead of dropping the first inbound voice frames.
      if (this.pendingPlayback.length < 100) this.pendingPlayback.push(raw.slice(0));
      if (this.context?.state === 'suspended') void this.resumeAndFlushPlayback();
      return;
    }
    this.enqueuePlayback(raw);
  }

  private async resumeAndFlushPlayback() {
    if (!this.context || this.context.state === 'closed') return;
    this.resuming ??= this.context.resume().then(() => {
      if (this.context?.state !== 'running') return;
      const pending = this.pendingPlayback.splice(0).slice(-PENDING_PLAYBACK_REPLAY_FRAMES);
      pending.forEach((frame) => this.enqueuePlayback(frame));
    }).catch(() => undefined).finally(() => { this.resuming = undefined; });
    await this.resuming;
  }

  private enqueuePlayback(raw: ArrayBuffer) {
    if (!this.context || !this.playbackGain || raw.byteLength < 2 || this.context.state === 'closed') return;
    const sampleCount = Math.floor(raw.byteLength / 2);
    const pcm = new Int16Array(sampleCount);
    const view = new DataView(raw);
    let peak = 0;
    for (let i = 0; i < sampleCount; i++) {
      pcm[i] = view.getInt16(i * 2, true);
      peak = Math.max(peak, Math.abs(pcm[i]));
    }
    this.playbackFramesReceived += 1;
    this.playbackPeak = Math.max(this.playbackPeak, peak);
    this.noteInbound(peak);
    const backlog = this.nextPlayTime - this.context.currentTime;
    if (backlog > PLAYBACK_BACKLOG_HIGH_S) this.shedding = true;
    else if (backlog < PLAYBACK_BACKLOG_LOW_S) this.shedding = false;
    if (this.shedding) {
      this.playbackFramesDropped += 1;
      return;
    }
    const buffer = this.context.createBuffer(1, sampleCount, 16000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x7fff;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.playbackGain);
    source.onended = () => { this.playbackFramesEnded += 1; };
    if (this.nextPlayTime < this.context.currentTime) this.nextPlayTime = this.context.currentTime + PLAYBACK_START_LEAD_S;
    source.start(this.nextPlayTime);
    this.nextPlayTime += buffer.duration;
    this.playbackFramesScheduled += 1;
    if (this.playbackFramesScheduled === 1 || this.playbackFramesScheduled % 100 === 0) this.reportPlaybackStatus();
  }

  /**
   * Track whether the customer is audibly coming through, and tell the UI at a bounded rate. This
   * is what separates "the customer's audio never reached this browser" from "it reached the
   * browser but is playing on a speaker the SDR is not wearing" -- the two look identical from the
   * headset and need opposite fixes.
   */
  private noteInbound(peak: number) {
    const now = Date.now();
    if (peak >= INBOUND_SIGNAL_THRESHOLD) {
      this.lastAudibleInboundAt = now;
      this.inboundWindowPeak = Math.max(this.inboundWindowPeak, peak);
    }
    if (this.inboundReportTimer !== undefined) return;
    this.inboundReportTimer = window.setTimeout(() => {
      this.inboundReportTimer = undefined;
      const at = Date.now();
      const receiving = at - this.lastAudibleInboundAt <= INBOUND_RECEIVING_WINDOW_MS;
      this.inboundListener?.({ receiving, peak: this.inboundWindowPeak, updatedAt: at });
      this.inboundWindowPeak = 0;
      // Keep reporting while frames flow so the indicator can fall back to "not receiving" once the
      // customer goes quiet, even if no further frame arrives to trigger this.
      if (receiving && this.context && this.context.state !== 'closed') this.noteInbound(0);
    }, INBOUND_REPORT_INTERVAL_MS);
  }

  private reportPlaybackStatus(force = false) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.activeCallId) return;
    if (!force && this.playbackFramesScheduled === 0) return;
    try {
      this.socket.send(JSON.stringify({
        type: 'audio_playback_status',
        callId: this.activeCallId,
        contextState: this.context?.state ?? 'missing',
        outputSampleRate: this.context?.sampleRate ?? 0,
        framesReceived: this.playbackFramesReceived,
        framesScheduled: this.playbackFramesScheduled,
        framesEnded: this.playbackFramesEnded,
        framesDropped: this.playbackFramesDropped,
        peak: this.playbackPeak,
        queuedSeconds: this.context ? Math.max(0, this.nextPlayTime - this.context.currentTime) : 0,
        outputDevice: this.deviceState.activeOutputLabel,
        sinkMode: this.deviceState.sinkMode,
        inputDevice: this.deviceState.activeInputLabel,
      }));
    } catch { /* diagnostic reporting must never interrupt audio */ }
  }

  async stop() {
    this.stopRequested = true;
    this.reportPlaybackStatus(true);
    if (this.inboundReportTimer !== undefined) { window.clearTimeout(this.inboundReportTimer); this.inboundReportTimer = undefined; }
    this.lastAudibleInboundAt = 0;
    this.inboundWindowPeak = 0;
    this.inboundListener?.({ receiving: false, peak: 0, updatedAt: Date.now() });
    this.detachCapture();
    this.playbackGain?.disconnect();
    this.outputDestination?.disconnect();
    if (this.outputElement) { this.outputElement.pause(); this.outputElement.srcObject = null; }
    await this.context?.close();
    this.playbackGain = undefined;
    this.outputDestination = undefined;
    this.outputElement = undefined;
    this.context = undefined;
    this.resuming = undefined;
    this.socket = undefined;
    this.nextPlayTime = 0;
    this.captureSampleRate = 16000;
    this.sourceBuffer = [];
    this.sourceCursor = 0;
    this.outgoingSamples = [];
    this.muted = false;
    this.pendingPlayback = [];
    this.activeCallId = '';
    this.playbackFramesReceived = 0;
    this.playbackFramesScheduled = 0;
    this.playbackFramesEnded = 0;
    this.playbackFramesDropped = 0;
    this.playbackPeak = 0;
    this.shedding = false;
    this.patchDeviceState({ activeOutputId: '', activeOutputLabel: '' });
  }

  /** Waxum expects mono PCM16 at exactly 16 kHz. Browsers may run the
   * AudioContext at 48 kHz even when 16 kHz was requested. */
  private resampleToPcm16(input: Float32Array) {
    if (this.captureSampleRate === 16000) return this.toPcm16(input);

    this.sourceBuffer.push(...input);
    const step = this.captureSampleRate / 16000;
    const output: number[] = [];

    // Keep one source sample at the end of each chunk for continuous
    // interpolation when the next ScriptProcessor event arrives.
    while (this.sourceCursor + 1 < this.sourceBuffer.length) {
      const index = Math.floor(this.sourceCursor);
      const fraction = this.sourceCursor - index;
      const current = this.sourceBuffer[index];
      const next = this.sourceBuffer[index + 1];
      output.push(current + (next - current) * fraction);
      this.sourceCursor += step;
    }

    // Never consume the final source sample: it is the interpolation anchor
    // for the next chunk. The cursor can be slightly past the buffer after
    // producing the last available output sample.
    const consumed = Math.min(Math.floor(this.sourceCursor), Math.max(0, this.sourceBuffer.length - 1));
    if (consumed > 0) {
      this.sourceBuffer = this.sourceBuffer.slice(consumed);
      this.sourceCursor -= consumed;
    }

    return this.toPcm16(output);
  }

  private toPcm16(input: ArrayLike<number>) {
    const pcm = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const sample = Math.max(-1, Math.min(1, input[i]));
      pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return pcm;
  }
}
