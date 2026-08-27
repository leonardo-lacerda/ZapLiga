export class AudioBridge {
  private context?: AudioContext;
  private stream?: MediaStream;
  private processor?: ScriptProcessorNode;
  private nextPlayTime = 0;
  private captureSampleRate = 16000;
  private sourceBuffer: number[] = [];
  private sourceCursor = 0;

  async start(socket: WebSocket) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: { ideal: 16000 },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.context = new AudioContext({ sampleRate: 16000 });
    this.captureSampleRate = this.context.sampleRate;
    this.sourceBuffer = [];
    this.sourceCursor = 0;
    const source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (event) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const input = event.inputBuffer.getChannelData(0);
      const pcm = this.resampleToPcm16(input);
      if (pcm.length > 0) socket.send(pcm.buffer);
    };
    const silent = this.context.createGain();
    silent.gain.value = 0;
    source.connect(this.processor);
    this.processor.connect(silent);
    silent.connect(this.context.destination);
  }

  play(raw: ArrayBuffer) {
    if (!this.context || raw.byteLength < 2) return;
    const pcm = new Int16Array(raw);
    const buffer = this.context.createBuffer(1, pcm.length, 16000);
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
    this.processor?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    await this.context?.close();
    this.processor = undefined;
    this.stream = undefined;
    this.context = undefined;
    this.nextPlayTime = 0;
    this.captureSampleRate = 16000;
    this.sourceBuffer = [];
    this.sourceCursor = 0;
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


