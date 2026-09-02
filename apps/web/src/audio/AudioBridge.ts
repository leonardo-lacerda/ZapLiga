export class AudioBridge {
  private context?: AudioContext;
  private stream?: MediaStream;
  private processor?: ScriptProcessorNode;
  private playbackGain?: GainNode;
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
  private playbackPeak = 0;

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

  private async startInternal() {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          sampleRate: { ideal: 16000 },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : 'AudioError';
      let inputs = 0;
      try { inputs = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput').length; } catch { /* diagnóstico opcional */ }
      if (name === 'NotAllowedError' || name === 'SecurityError') throw new Error('O acesso ao microfone está bloqueado. Libere a permissão do microfone para este site e tente conectar novamente.');
      if (name === 'NotFoundError' || !inputs) throw new Error('Nenhum microfone foi encontrado. Conecte um headset ou microfone e tente novamente.');
      if (name === 'NotReadableError' || name === 'AbortError') throw new Error('O microfone está sendo usado ou bloqueado por outro aplicativo. Feche o outro aplicativo e tente novamente.');
      throw new Error('Não foi possível preparar o áudio. Verifique o dispositivo de entrada do Windows e tente novamente.');
    }
    if (this.stopRequested) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    // Keep the physical output at the device's native sample rate. Forcing a
    // 16 kHz context can be silent with some Chrome/Windows audio drivers.
    // Web Audio resamples the 16 kHz call buffers to this output rate.
    const context = new AudioContext({ latencyHint: 'interactive' });
    await context.resume();
    if (context.state !== 'running') {
      stream.getTracks().forEach((track) => track.stop());
      await context.close();
      throw new Error('O navegador bloqueou a reprodução de áudio. Clique novamente em Ligar agora.');
    }
    if (this.stopRequested) {
      stream.getTracks().forEach((track) => track.stop());
      await context.close();
      return;
    }

    this.stream = stream;
    this.context = context;
    this.captureSampleRate = context.sampleRate;
    this.sourceBuffer = [];
    this.sourceCursor = 0;
    this.outgoingSamples = [];
    const source = context.createMediaStreamSource(stream);
    // ScriptProcessor is retained for this MVP, but its output is reframed
    // below. Waxum/whatsapp-rust accepts exactly 960 mono samples per frame.
    this.processor = context.createScriptProcessor(1024, 1, 1);
    this.processor.onaudioprocess = (event) => {
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
    const silent = context.createGain();
    silent.gain.value = 0;
    source.connect(this.processor);
    this.processor.connect(silent);
    silent.connect(context.destination);
    this.playbackGain = context.createGain();
    this.playbackGain.gain.value = 1;
    this.playbackGain.connect(context.destination);
    const pending = this.pendingPlayback.splice(0);
    pending.forEach((frame) => this.enqueuePlayback(frame));
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.stream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
  }

  isMuted() {
    return this.muted;
  }

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
      const pending = this.pendingPlayback.splice(0);
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
    const buffer = this.context.createBuffer(1, sampleCount, 16000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x7fff;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.playbackGain);
    source.onended = () => { this.playbackFramesEnded += 1; };
    this.nextPlayTime = Math.max(this.nextPlayTime, this.context.currentTime);
    source.start(this.nextPlayTime);
    this.nextPlayTime += buffer.duration;
    this.playbackFramesScheduled += 1;
    if (this.playbackFramesScheduled === 1 || this.playbackFramesScheduled % 100 === 0) this.reportPlaybackStatus();
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
        peak: this.playbackPeak,
        queuedSeconds: this.context ? Math.max(0, this.nextPlayTime - this.context.currentTime) : 0,
      }));
    } catch { /* diagnostic reporting must never interrupt audio */ }
  }

  async stop() {
    this.stopRequested = true;
    this.reportPlaybackStatus(true);
    this.processor?.disconnect();
    this.playbackGain?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    await this.context?.close();
    this.processor = undefined;
    this.playbackGain = undefined;
    this.stream = undefined;
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
    this.playbackPeak = 0;
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
