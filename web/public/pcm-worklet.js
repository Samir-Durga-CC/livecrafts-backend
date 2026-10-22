/**
 * Microphone -> 16-bit PCM at the rate the speech service expects, plus a loudness reading, on the audio thread.
 *
 * RESAMPLING IS NOT OPTIONAL. Chrome honours `new AudioContext({ sampleRate: 24000 })`; Safari and some Android
 * devices quietly give you 44100 or 48000 instead. Sending 48kHz audio while telling the service it is 24kHz
 * plays it back at half speed, and what comes back is fluent nonsense in whatever language the model guesses -
 * which looks exactly like a broken model and is in fact a broken pipe. So the real rate is read here and the
 * audio is converted, whatever the browser decided to give us.
 *
 * Running on the audio thread means a busy page cannot stall the microphone, which is how recordings get holes.
 */
class PcmWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const target = options?.processorOptions?.targetRate || 24000;
    // `sampleRate` is the context's real rate, available to every worklet. 1 means no conversion is needed.
    this.ratio = sampleRate / target;
    this.pos = 0;                      // read position in the source, carried across blocks
    this.carry = new Float32Array(0);  // the tail of the last block: interpolation needs the sample before
    this.out = new Int16Array(1024);
    this.n = 0;
    this.port.postMessage({ rate: sampleRate, target, resampling: this.ratio !== 1 });
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    // No input at all (a stalled device, a source that ended) is still a reading. A detector that stops being
    // told anything keeps whatever state it was in - mid-sentence that is "still talking", and the turn never ends.
    if (!input) { this.port.postMessage({ db: -100 }); return true; }

    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    this.port.postMessage({ db: 20 * Math.log10(Math.sqrt(sum / input.length) + 1e-9) });

    const src = this.carry.length ? concat(this.carry, input) : input;
    let p = this.pos;
    while (p + 1 < src.length) {
      const i = p | 0, frac = p - i;
      const s = Math.max(-1, Math.min(1, src[i] * (1 - frac) + src[i + 1] * frac));
      this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.out.length) {
        const frame = this.out.slice();
        this.port.postMessage({ pcm: frame.buffer }, [frame.buffer]);
        this.n = 0;
      }
      p += this.ratio;
    }
    // Keep from the last sample we still need, so the next block interpolates across the seam instead of clicking.
    const keep = p | 0;
    this.carry = src.slice(keep);
    this.pos = p - keep;
    return true;
  }
}

function concat(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

registerProcessor("pcm-worklet", PcmWorklet);
