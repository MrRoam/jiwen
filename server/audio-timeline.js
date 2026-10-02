// ASR 时间以收到的 PCM 长度累计；录音时间还包含采集中断，不能混用。
export class AudioTimeline {
  constructor(base = 0) { this.base = base; this.duration = 0; this.spans = []; }
  append(byteLength, offsetMs) {
    const duration = byteLength / 32;
    const previous = this.spans.at(-1);
    const offset = Math.max(previous ? previous.offset + previous.duration : this.base, offsetMs ?? (this.base + this.duration));
    if (previous && Math.abs(previous.offset + previous.duration - offset) < 2) previous.duration += duration;
    else this.spans.push({ audio: this.duration, offset, duration });
    this.duration += duration;
  }
  at(ms, end = false) {
    const span = this.spans.find(s => end ? ms <= s.audio + s.duration : ms < s.audio + s.duration) || this.spans.at(-1);
    return Math.round(span ? span.offset + Math.max(0, ms - span.audio) : this.base + ms);
  }
}
