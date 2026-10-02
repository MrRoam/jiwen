// 只合并展示，原始句子和时间戳仍用于选取、回放及上下文快照。
export function questionAnchor(segments, fallbackMs, playbackMs = null) {
  if (playbackMs !== null) return playbackMs;
  const latest = segments.filter(s => s.text?.trim()).reduce((ms, s) => Math.max(ms, s.end_ms), -1);
  return latest < 0 ? fallbackMs : latest;
}

export function nearTranscriptBottom(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
}

export function groupTranscript(segments) {
  const groups=[];
  for(const segment of segments){
    const last=groups.at(-1),previous=last?.segments.at(-1);
    if(last&&previous.final&&previous.recording_id===segment.recording_id&&segment.start_ms-previous.end_ms<8000&&segment.end_ms-last.start_ms<=60000&&last.text.length+segment.text.length<=280){
      last.segments.push(segment);last.text+=segment.text;last.end_ms=segment.end_ms;
    }else groups.push({id:segment.id,start_ms:segment.start_ms,end_ms:segment.end_ms,text:segment.text,segments:[segment]});
  }
  return groups;
}
