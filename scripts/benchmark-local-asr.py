"""开放环本地 ASR 压测。只使用用户指定的授权 PCM WAV，不调用付费 API。"""
import argparse
import hashlib
import json
import math
import os
import queue
import statistics
import threading
import time
import unicodedata
import urllib.error
import urllib.request
import uuid
import wave
from pathlib import Path

BYTES_PER_SECOND = 32000


def request(url, pcm=None, stream=None, sequence=0, final=False, timeout=110):
    headers = {}
    if pcm is not None:
        headers = {'Content-Type': 'application/octet-stream', 'X-ASR-Stream': stream,
                   'X-ASR-Sequence': str(sequence), 'X-ASR-Final': '1' if final else '0'}
    req = urllib.request.Request(url, data=pcm, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.load(error)
        except (ValueError, OSError):
            return error.code, {'error': 'http_error'}
    except (OSError, TimeoutError) as error:
        return 0, {'error': type(error).__name__}


def cancel(url, stream):
    try:
        urllib.request.urlopen(urllib.request.Request(f'{url}/streams/{stream}', method='DELETE'), timeout=3).close()
    except OSError:
        pass


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[min(len(ordered)-1, math.ceil(len(ordered)*fraction)-1)], 3)


def latency_summary(values):
    return {'count': len(values), 'p50Ms': percentile(values, .5),
            'p95Ms': percentile(values, .95), 'maxMs': round(max(values), 3) if values else None}


def run_load(url, source, streams, seconds, chunk_seconds, drain_seconds, max_pending):
    chunk_bytes = round(chunk_seconds * BYTES_PER_SECOND / 2) * 2
    chunks = math.ceil(seconds / chunk_seconds)
    ids = [uuid.uuid4().hex for _ in range(streams)]
    inboxes = [queue.Queue(maxsize=max_pending) for _ in ids]
    lock, stop_monitor = threading.Lock(), threading.Event()
    records, samples, failures = [], [], []
    first_text_ms = {}
    failed_streams = set()
    counters = {'generated': 0, 'clientQueueDropped': 0, 'completed': 0, 'httpFailed': 0,
                'audioSecondsCompleted': 0, 'active': 0}
    started = time.monotonic()
    last_finished = [started]

    def worker(index):
        stream, sequence = ids[index], 0
        while True:
            item = inboxes[index].get()
            if item is None:
                inboxes[index].task_done()
                return
            scheduled, pcm, final = item
            with lock:
                already_failed = index in failed_streams
                if not already_failed:
                    counters['active'] += 1
            if already_failed:
                inboxes[index].task_done()
                continue
            sent = time.monotonic()
            status, result = request(f'{url}/transcribe', pcm, stream, sequence, final)
            finished = time.monotonic()
            with lock:
                counters['active'] -= 1
                last_finished[0] = finished
                if status == 200:
                    counters['completed'] += 1
                    counters['audioSecondsCompleted'] += len(pcm)/BYTES_PER_SECOND
                    text_characters = sum(len(item.get('text', '').strip()) for item in result.get('segments', []))
                    if text_characters and index not in first_text_ms:
                        first_text_ms[index] = (finished-started)*1000
                    records.append({'stream': index, 'sequence': sequence,
                                    'endToEndMs': (finished-scheduled)*1000,
                                    'clientQueueMs': (sent-scheduled)*1000,
                                    'requestMs': (finished-sent)*1000,
                                    'textCharacters': text_characters,
                                    **result.get('metrics', {})})
                    sequence += 1
                else:
                    counters['httpFailed'] += 1
                    failed_streams.add(index)
                    failures.append({'stream': index, 'sequence': sequence, 'status': status,
                                     'error': result.get('error', 'unknown')})
            if status != 200:
                cancel(url, stream)
            inboxes[index].task_done()

    def monitor():
        while not stop_monitor.is_set():
            status, health = request(f'{url}/status', timeout=3)
            with lock:
                samples.append({'atSeconds': round(time.monotonic()-started, 3),
                                'clientQueuedJobs': sum(q.qsize() for q in inboxes),
                                'clientActive': counters['active'],
                                'serverQueuedJobs': health.get('queuedJobs') if status == 200 else None,
                                'serverQueuedAudioSeconds': health.get('queuedAudioSeconds') if status == 200 else None,
                                'serverOldestQueuedSeconds': health.get('oldestQueuedSeconds') if status == 200 else None})
            stop_monitor.wait(.5)

    workers = [threading.Thread(target=worker, args=(i,), daemon=True) for i in range(streams)]
    for thread in workers:
        thread.start()
    monitoring = threading.Thread(target=monitor, daemon=True)
    monitoring.start()
    # 时间表只依据墙钟推进，不等待任何响应；每路 worker 保持序号和缓存顺序。
    for sequence in range(chunks):
        audio_end = min(seconds, (sequence+1)*chunk_seconds)
        scheduled = started + audio_end
        time.sleep(max(0, scheduled-time.monotonic()))
        size = round((audio_end-sequence*chunk_seconds)*BYTES_PER_SECOND/2)*2
        source_start = (sequence*chunk_bytes) % len(source)
        pcm = source[source_start:source_start+size]
        remainder = size-len(pcm)
        if remainder:
            pcm += (source*math.ceil(remainder/len(source)))[:remainder]
        for index, inbox in enumerate(inboxes):
            with lock:
                counters['generated'] += 1
                failed = index in failed_streams
            if failed:
                continue
            try:
                inbox.put_nowait((scheduled, pcm, sequence == chunks-1))
            except queue.Full:
                with lock:
                    counters['clientQueueDropped'] += 1
                    failed_streams.add(index)
                    failures.append({'stream': index, 'sequence': sequence, 'status': 0, 'error': 'client_queue_full'})
                cancel(url, ids[index])
    input_ended = time.monotonic()
    deadline = input_ended + drain_seconds
    while time.monotonic() < deadline and any(inbox.unfinished_tasks for inbox in inboxes):
        time.sleep(.1)
    stop_monitor.set()
    monitoring.join(timeout=4)
    with lock:
        pending = sum(q.unfinished_tasks for q in inboxes)
        duration = max(.001, last_finished[0]-started)
        result = {'streams': streams, 'inputSecondsPerStream': seconds,
                  'inputAudioSeconds': streams*seconds, 'wallSeconds': round(time.monotonic()-started, 3),
                  'drainSecondsUsed': round(time.monotonic()-input_ended, 3),
                  **counters, 'failedStreams': len(failed_streams), 'unfinishedJobs': pending,
                  'unprocessedJobs': counters['generated']-counters['completed'],
                  'completionRatio': round(counters['completed']/max(1, counters['generated']), 6),
                  'textResponseCount': sum(r['textCharacters'] > 0 for r in records),
                  'firstTextFromRecordingStart': latency_summary(list(first_text_ms.values())),
                  'latencyDefinition': 'endToEnd 从分段采集完毕到响应，包含客户端与服务端排队；首字从录音开始算起',
                  'throughputAudioSecondsPerWallSecond': round(counters['audioSecondsCompleted']/duration, 3),
                  'endToEnd': latency_summary([r['endToEndMs'] for r in records]),
                  'clientQueue': latency_summary([r['clientQueueMs'] for r in records]),
                  'serverQueue': latency_summary([r['queueMs'] for r in records if 'queueMs' in r]),
                  'inference': latency_summary([r['inferenceMs'] for r in records if 'inferenceMs' in r]),
                  'backlogSamples': list(samples), 'failures': list(failures),
                  'requests': list(records)}
    for index, inbox in enumerate(inboxes):
        cancel(url, ids[index])
        # 未完成任务不掩盖；下一档并发前取消剩余缓存和队列。
        while True:
            try:
                inbox.get_nowait()
                inbox.task_done()
            except queue.Empty:
                break
        inbox.put(None)
    for thread in workers:
        thread.join(timeout=4)
    result['workersStillRunning'] = sum(thread.is_alive() for thread in workers)
    return result


def normalized(text):
    return ''.join(c for c in unicodedata.normalize('NFKC', text).lower()
                   if not c.isspace() and not unicodedata.category(c).startswith('P'))


def character_error_rate(reference, hypothesis):
    reference, hypothesis = normalized(reference), normalized(hypothesis)
    if not reference:
        raise ValueError('标注文本归一化后为空，不能计算 CER')
    previous = list(range(len(reference)+1))
    for i, h in enumerate(hypothesis, 1):
        current = [i]
        for j, r in enumerate(reference, 1):
            current.append(min(current[-1]+1, previous[j]+1, previous[j-1]+(h != r)))
        previous = current
    return {'cer': previous[-1]/len(reference), 'editDistance': previous[-1],
            'referenceCharacters': len(reference), 'hypothesisCharacters': len(hypothesis),
            'normalization': 'NFKC、小写、去空白和 Unicode 标点'}


def run_quality(url, source, chunk_seconds, reference_path):
    stream, texts = uuid.uuid4().hex, []
    size = round(chunk_seconds*BYTES_PER_SECOND/2)*2
    try:
        for sequence, start in enumerate(range(0, len(source), size)):
            pcm = source[start:start+size]
            status, result = request(f'{url}/transcribe', pcm, stream, sequence, start+size >= len(source))
            if status != 200:
                return {'cer': None, 'error': result.get('error'), 'status': status}
            texts.extend(item.get('text', '') for item in result.get('segments', []))
        reference = Path(reference_path).read_text(encoding='utf-8-sig')
        return character_error_rate(reference, ''.join(texts))
    finally:
        cancel(url, stream)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wav', required=True, help='已获授权的 16 kHz、单声道、16-bit PCM WAV')
    parser.add_argument('--url', default='http://127.0.0.1:4318')
    parser.add_argument('--streams', default='1,5,10,20,50,100')
    parser.add_argument('--seconds', type=float, default=120)
    parser.add_argument('--drain-seconds', type=float, default=120)
    parser.add_argument('--max-client-pending', type=int, default=200)
    parser.add_argument('--reference', help='与整个 WAV 对应的人工标注 UTF-8 文本；另跑一次 CER 评测')
    parser.add_argument('--sample-kind', choices=('authorized-classroom', 'synthetic', 'public-licensed'), default='authorized-classroom')
    parser.add_argument('--output', default='output/local-asr-benchmark.json')
    args = parser.parse_args()
    streams = [int(n) for n in args.streams.split(',')]
    if not streams or min(streams) <= 0 or min(args.seconds, args.drain_seconds, args.max_client_pending) <= 0:
        parser.error('时长和并发参数必须大于零')
    with wave.open(args.wav, 'rb') as wav:
        if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth(), wav.getcomptype()) != (16000, 1, 2, 'NONE'):
            parser.error('WAV 必须为 16 kHz、单声道、16-bit PCM，请先在本机转换格式')
        source = wav.readframes(wav.getnframes())
    if not source:
        parser.error('音频为空')
    status, health = request(args.url+'/health', timeout=5)
    if status != 200 or health.get('ready') is not True:
        parser.error('本地 ASR 未就绪')
    chunk_seconds = health.get('chunkSeconds', 10)
    report = {'schemaVersion': 1, 'createdAtUtc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
              'mode': 'open-loop-per-stream-ordered', 'sampleKind': args.sample_kind,
              'sampleSha256': hashlib.sha256(source).hexdigest(), 'sourceSeconds': len(source)/BYTES_PER_SECOND,
              'server': health, 'chunkSeconds': chunk_seconds,
              'quality': {'cer': None, 'reason': '未提供人工标注，不报告准确率'}, 'runs': []}
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    if args.reference:
        report['quality'] = run_quality(args.url, source, chunk_seconds, args.reference)
    for count in streams:
        result = run_load(args.url, source, count, args.seconds, chunk_seconds, args.drain_seconds, args.max_client_pending)
        report['runs'].append(result)
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({key: result[key] for key in ('streams', 'completed', 'httpFailed', 'failedStreams', 'unfinishedJobs', 'throughputAudioSecondsPerWallSecond', 'endToEnd')}, ensure_ascii=False), flush=True)
        if result['workersStillRunning']:
            print('本档仍有请求未结束；停止后续档位，避免混入前一档积压。', flush=True)
            break
    print(f'报告已保存：{output.resolve()}；短测与合成音频不能证明长期课堂容量或准确率。', flush=True)


if __name__ == '__main__':
    main()
