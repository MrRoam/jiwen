"""本地 ASR：HTTP 接收和健康检查独立于有界推理队列。只监听本机。"""
import argparse
import hashlib
import json
import math
import os
import sys
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BYTES_PER_SECOND = 32000
STREAM_MODEL = 'funasr/paraformer-zh-streaming'
STREAM_REVISION = 'apache-2.0-20260804'
STREAM_COMMIT = 'fd2af606b37d7fb8b3b8a218c5be5b07b53ef6ba'


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024*1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


class ASRError(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


class WhisperEngine:
    chunk_seconds = 10
    streaming = False

    def __init__(self, model, device, compute):
        import numpy as np
        from faster_whisper import WhisperModel
        self.np = np
        self.model = WhisperModel(model, device=device, compute_type=compute)
        self.metadata = {'engine': 'whisper', 'model': model, 'device': device,
                         'compute': compute, 'timing': 'model-segments'}

    def infer(self, pcm, state, final):
        if not pcm:
            return {'segments': []}
        audio = self.np.frombuffer(pcm, dtype='<i2').astype(self.np.float32) / 32768.0
        segments, _ = self.model.transcribe(audio, language='zh', beam_size=5,
                                            vad_filter=True, condition_on_previous_text=False)
        return {'segments': [{'start': s.start, 'end': s.end, 'text': s.text}
                             for s in segments]}


class ParaformerEngine:
    chunk_seconds = .6
    streaming = True

    def __init__(self, device, model_path=None):
        import numpy as np
        from funasr import AutoModel
        from huggingface_hub import snapshot_download
        if model_path:
            path = os.path.abspath(model_path)
            with open(os.path.join(path, 'asr-source.json'), encoding='utf-8-sig') as handle:
                manifest = json.load(handle)
            if manifest.get('repository') != STREAM_MODEL or manifest.get('commit') != STREAM_COMMIT:
                raise ValueError('本地模型来源与固定许可快照不匹配')
        else:
            path = snapshot_download(STREAM_MODEL, revision=STREAM_COMMIT)
        license_sha = file_sha256(os.path.join(path, 'LICENSE'))
        model_sha = file_sha256(os.path.join(path, 'model.pt'))
        if model_path and manifest.get('modelSha256') != model_sha:
            raise ValueError('本地模型校验和不匹配，请重新下载完整文件')
        self.np = np
        self.model = AutoModel(model=path, device=device, disable_update=True,
                               disable_pbar=True, disable_log=True)
        actual_device = str(next(self.model.model.parameters()).device)
        if device == 'cuda' and not actual_device.startswith('cuda'):
            raise RuntimeError('请求 CUDA 但模型没有加载到 GPU')
        self.metadata = {'engine': 'paraformer-streaming', 'model': STREAM_MODEL,
                         'revision': STREAM_REVISION, 'commit': STREAM_COMMIT,
                         'license': 'Apache-2.0', 'licenseSha256': license_sha,
                         'modelSha256': model_sha,
                         'device': actual_device, 'timing': 'chunk-approximation', 'batchSize': 1}

    def infer(self, pcm, state, final):
        audio = self.np.frombuffer(pcm, dtype='<i2').astype(self.np.float32) / 32768.0
        result = self.model.generate(input=audio, cache=state.cache, is_final=final,
                                     chunk_size=[0, 10, 5], encoder_chunk_look_back=4,
                                     decoder_chunk_look_back=1, batch_size=1,
                                     disable_pbar=True)
        text = ''.join(item.get('text', '') for item in result).strip()
        state.audio_seconds += len(pcm) / BYTES_PER_SECOND
        segments = []
        if text:
            # 模型不提供逐词时间戳，使用上次出字到本次音频末尾的近似范围。
            segments.append({'start': state.text_start, 'end': state.audio_seconds,
                             'text': text, 'timing': 'chunk-approximation'})
            state.text_start = state.audio_seconds
        return {'segments': segments, 'timeline': 'stream', 'timing': 'chunk-approximation'}


@dataclass
class StreamState:
    next_sequence: int = 0
    busy: bool = False
    cancelled: bool = False
    updated: float = field(default_factory=time.monotonic)
    cache: dict = field(default_factory=dict)
    audio_seconds: float = 0
    text_start: float = 0


@dataclass
class Job:
    stream_id: str
    sequence: int
    pcm: bytes
    final: bool
    state: StreamState
    admitted: float = field(default_factory=time.monotonic)
    done: threading.Event = field(default_factory=threading.Event)
    result: dict = None
    error: ASRError = None


class Scheduler:
    """单个模型工作线程；各流只能有一个未完成请求，FIFO 避免共享缓存。"""
    def __init__(self, engine, max_jobs=128, max_audio_seconds=120, max_streams=20,
                 max_wait_seconds=60, stream_idle_seconds=180):
        self.engine = engine
        self.max_jobs, self.max_audio_seconds = max_jobs, max_audio_seconds
        self.max_streams, self.max_wait_seconds = max_streams, max_wait_seconds
        self.stream_idle_seconds = stream_idle_seconds
        self.condition = threading.Condition()
        self.jobs, self.streams = deque(), {}
        self.queued_audio, self.active_audio = 0, 0
        self.completed, self.failed, self.rejected = 0, 0, 0
        self.processed_audio, self.inference_seconds = 0, 0
        self.stopped = False
        self.worker = threading.Thread(target=self._run, daemon=True, name='asr-model')
        self.worker.start()

    def submit(self, pcm, stream_id, sequence, final):
        with self.condition:
            now = time.monotonic()
            for key, value in list(self.streams.items()):
                if not value.busy and now - value.updated > self.stream_idle_seconds:
                    del self.streams[key]
            state = self.streams.get(stream_id)
            if state and (state.busy or sequence != state.next_sequence):
                raise ASRError(409, 'invalid_stream_sequence')
            if not state and sequence != 0:
                raise ASRError(409, 'unknown_stream')
            seconds = len(pcm) / BYTES_PER_SECOND
            if self.stopped or len(self.jobs) >= self.max_jobs or self.queued_audio + seconds > self.max_audio_seconds:
                self.rejected += 1
                raise ASRError(429, 'queue_full')
            if not state and len(self.streams) >= self.max_streams:
                self.rejected += 1
                raise ASRError(429, 'stream_capacity')
            state = state or StreamState()
            self.streams[stream_id] = state
            state.busy, state.updated = True, now
            job = Job(stream_id, sequence, pcm, final, state)
            self.jobs.append(job)
            self.queued_audio += seconds
            self.condition.notify()
            return job

    def cancel(self, stream_id):
        with self.condition:
            state = self.streams.pop(stream_id, None)
            if state:
                state.cancelled = True
            self.condition.notify()

    def status(self):
        with self.condition:
            return {**self.engine.metadata, 'ready': not self.stopped,
                    'streaming': self.engine.streaming, 'chunkSeconds': self.engine.chunk_seconds,
                    'queuedJobs': len(self.jobs), 'queuedAudioSeconds': round(self.queued_audio, 3),
                    'activeAudioSeconds': round(self.active_audio, 3),
                    'oldestQueuedSeconds': round(time.monotonic() - self.jobs[0].admitted, 3) if self.jobs else 0,
                    'activeStreams': len(self.streams), 'maxStreams': self.max_streams,
                    'maxQueuedJobs': self.max_jobs, 'maxQueuedAudioSeconds': self.max_audio_seconds,
                    'completed': self.completed, 'failed': self.failed, 'rejected': self.rejected,
                    'processedAudioSeconds': round(self.processed_audio, 3),
                    'inferenceSeconds': round(self.inference_seconds, 3)}

    def _run(self):
        while True:
            with self.condition:
                self.condition.wait_for(lambda: self.jobs or self.stopped)
                if self.stopped:
                    return
                job = self.jobs.popleft()
                seconds = len(job.pcm) / BYTES_PER_SECOND
                self.queued_audio -= seconds
                self.active_audio = seconds
            started = time.monotonic()
            queue_ms = (started - job.admitted) * 1000
            try:
                if job.state.cancelled:
                    raise ASRError(409, 'stream_cancelled')
                if queue_ms > self.max_wait_seconds * 1000:
                    raise ASRError(503, 'queue_timeout')
                result = self.engine.infer(job.pcm, job.state, job.final)
                if job.state.cancelled:
                    raise ASRError(409, 'stream_cancelled')
                result['metrics'] = {'queueMs': round(queue_ms, 3),
                                     'inferenceMs': round((time.monotonic() - started) * 1000, 3),
                                     'audioSeconds': seconds}
                job.result = result
            except ASRError as error:
                job.error = error
            except Exception as error:
                print(json.dumps({'event': 'inference-failed', 'type': type(error).__name__}), flush=True)
                job.error = ASRError(500, 'inference_failed')
            finally:
                with self.condition:
                    self.active_audio = 0
                    job.state.busy = False
                    job.state.updated = time.monotonic()
                    if job.error:
                        self.failed += 1
                    else:
                        self.completed += 1
                        self.processed_audio += seconds
                        self.inference_seconds += time.monotonic() - started
                        job.state.next_sequence += 1
                    if job.error or job.final or job.state.cancelled:
                        if self.streams.get(job.stream_id) is job.state:
                            self.streams.pop(job.stream_id, None)
                job.done.set()

    def close(self):
        with self.condition:
            self.stopped = True
            for job in self.jobs:
                job.error = ASRError(503, 'service_stopped')
                job.done.set()
            self.jobs.clear()
            self.condition.notify_all()


class ASRHTTPServer(ThreadingHTTPServer):
    request_queue_size = 256
    daemon_threads = True


def make_handler(scheduler):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, status, data):
            body = json.dumps(data, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            if status in (429, 503):
                self.send_header('Retry-After', '5')
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

        def do_GET(self):
            if self.path not in ('/health', '/status'):
                return self.reply(404, {'error': 'not_found'})
            self.reply(200, scheduler.status())

        def do_DELETE(self):
            if not self.path.startswith('/streams/'):
                return self.reply(404, {'error': 'not_found'})
            scheduler.cancel(self.path[len('/streams/'):])
            self.reply(200, {'ok': True})

        def do_POST(self):
            if self.path != '/transcribe':
                return self.reply(404, {'error': 'not_found'})
            if self.headers.get('Origin'):
                return self.reply(403, {'error': 'browser_requests_not_allowed'})
            try:
                size = int(self.headers.get('Content-Length', '0'))
                stream_id = self.headers.get('X-ASR-Stream')
                sequence = int(self.headers.get('X-ASR-Sequence', '0'))
                final = self.headers.get('X-ASR-Final', '1' if not stream_id else '0') == '1'
                if size < 0 or size > BYTES_PER_SECOND * 30 or size % 2 or (size == 0 and not final):
                    raise ASRError(400, 'invalid_pcm_size')
                if stream_id and (len(stream_id) > 100 or not all(c.isalnum() or c in '-_' for c in stream_id)):
                    raise ASRError(400, 'invalid_stream_id')
                if sequence < 0:
                    raise ASRError(400, 'invalid_sequence')
                self.connection.settimeout(15)
                pcm = self.rfile.read(size)
                if len(pcm) != size:
                    raise ASRError(400, 'incomplete_pcm')
                job = scheduler.submit(pcm, stream_id or uuid.uuid4().hex, sequence, final)
                if not job.done.wait(scheduler.max_wait_seconds + 110):
                    scheduler.cancel(job.stream_id)
                    raise ASRError(503, 'processing_timeout')
                if job.error:
                    raise job.error
                self.reply(200, job.result)
            except ASRError as error:
                self.reply(error.status, {'error': error.code})
            except (ValueError, TimeoutError):
                self.reply(400, {'error': 'invalid_request'})
    return Handler


def main():
    if sys.platform == 'win32':
        # 使用 Windows 已有受信根证书，保留 TLS 校验，兼容本机管理的代理证书。
        try:
            import truststore
            truststore.inject_into_ssl()
        except ImportError:
            pass
    parser = argparse.ArgumentParser(description='本地 ASR 服务（不替换正在运行的应用服务）')
    parser.add_argument('--engine', choices=('whisper', 'paraformer-streaming'), default=os.getenv('LOCAL_ASR_ENGINE', 'whisper'))
    parser.add_argument('--device', choices=('cpu', 'cuda'), default=os.getenv('LOCAL_ASR_DEVICE', 'cpu'))
    parser.add_argument('--model', default=os.getenv('LOCAL_ASR_MODEL', 'small'))
    parser.add_argument('--model-path', default=os.getenv('LOCAL_ASR_MODEL_PATH'), help='安装脚本下载的固定流式模型目录')
    parser.add_argument('--compute', default=os.getenv('LOCAL_ASR_COMPUTE', 'int8'))
    parser.add_argument('--port', type=int, default=int(os.getenv('LOCAL_ASR_PORT', '4318')))
    parser.add_argument('--max-streams', type=int, default=int(os.getenv('LOCAL_ASR_MAX_STREAMS', '20')))
    parser.add_argument('--max-jobs', type=int, default=int(os.getenv('LOCAL_ASR_MAX_JOBS', '128')))
    parser.add_argument('--max-queued-seconds', type=float, default=float(os.getenv('LOCAL_ASR_MAX_QUEUED_SECONDS', '120')))
    parser.add_argument('--max-wait-seconds', type=float, default=float(os.getenv('LOCAL_ASR_MAX_WAIT_SECONDS', '60')))
    args = parser.parse_args()
    if not all(math.isfinite(n) and n > 0 for n in (args.max_streams, args.max_jobs, args.max_queued_seconds, args.max_wait_seconds)):
        parser.error('容量参数必须大于零')
    engine = ParaformerEngine(args.device, args.model_path) if args.engine == 'paraformer-streaming' else WhisperEngine(args.model, args.device, args.compute)
    scheduler = Scheduler(engine, args.max_jobs, args.max_queued_seconds, args.max_streams, args.max_wait_seconds)
    server = ASRHTTPServer(('127.0.0.1', args.port), make_handler(scheduler))
    print(json.dumps({'event': 'ready', 'port': args.port, **scheduler.status()}, ensure_ascii=False), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        scheduler.close()
        server.server_close()


if __name__ == '__main__':
    main()
