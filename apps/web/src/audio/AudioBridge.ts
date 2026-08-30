export class AudioBridge {
  private context?: AudioContext;
  private stream?: MediaStream;
  private processor?: ScriptProcessorNode;
  private starting?: Promise<void>;
  private socket?: WebSocket;
  private stopRequested = false;
  private nextPlayTime = 0;
  private captureSampleRate = 16000;
  private sourceBuffer: number[] = [];
  private sourceCursor = 0;
  private outgoingSamples: number[] = [];
  private readonly frameSamples = 960;
  private muted = false;

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

  async start(socket: WebSocket) {
    this.socket = socket;
    await this.prepare();
    if (this.context?.state === 'suspended') await this.context.resume();
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
      const detail = error instanceof Error ? error.message : String(error);
      let inputs = 0;
      try { inputs = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput').length; } catch { /* diagnóstico opcional */ }
      throw new Error(`${name}: ${detail}. Microfones detectados: ${inputs}. Verifique o dispositivo de entrada do Windows.`);
    }
    if (this.stopRequested) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    const context = new AudioContext({ sampleRate: 16000 });
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
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.stream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
  }

  isMuted() {
    return this.muted;
  }

  play(raw: ArrayBuffer) {
    if (!this.context || raw.byteLength < 2) return;
    if (this.context.state === 'suspended') void this.context.resume();
    const sampleCount = Math.floor(raw.byteLength / 2);
    const pcm = new Int16Array(sampleCount);
    const view = new DataView(raw);
    for (let i = 0; i < sampleCount; i++) pcm[i] = view.getInt16(i * 2, true);
    const buffer = this.context.createBuffer(1, sampleCount, 16000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x7fff;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    this.nextPlayTime = Math.max(this.nextPlayTime, this.context.currentTime);
    source.start(this.nextPlayTime);
    this.nextPlayTime += buffer.duration;
  }

  async stop() {
    this.stopRequested = true;
    this.processor?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    await this.context?.close();
    this.processor = undefined;
    this.stream = undefined;
    this.context = undefined;
    this.socket = undefined;
    this.nextPlayTime = 0;
    this.captureSampleRate = 16000;
    this.sourceBuffer = [];
    this.sourceCursor = 0;
    this.outgoingSamples = [];
    this.muted = false;
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
