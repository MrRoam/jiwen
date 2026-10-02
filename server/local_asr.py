"""本地转写服务：python server/local_asr.py（首次启动会下载模型）。"""
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np
from faster_whisper import WhisperModel

model = WhisperModel(os.getenv('LOCAL_ASR_MODEL', 'small'),
                     device=os.getenv('LOCAL_ASR_DEVICE', 'cpu'),
                     compute_type=os.getenv('LOCAL_ASR_COMPUTE', 'int8'))


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.reply(200 if self.path == '/health' else 404, {'ready': True})

    def do_POST(self):
        if self.path != '/transcribe':
            return self.reply(404, {'error': 'not found'})
        if self.headers.get('Origin'):
            return self.reply(403, {'error': 'browser requests are not allowed'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size <= 0 or size > 32000 * 30 or size % 2:
                return self.reply(400, {'error': 'invalid PCM size'})
            pcm = self.rfile.read(size)
            audio = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768.0
            segments, _ = model.transcribe(audio, language='zh', beam_size=5,
                                          vad_filter=True, condition_on_previous_text=False)
            self.reply(200, {'segments': [{'start': s.start, 'end': s.end, 'text': s.text}
                                         for s in segments]})
        except Exception:
            self.reply(500, {'error': 'transcription failed'})


if __name__ == '__main__':
    port = int(os.getenv('LOCAL_ASR_PORT', '4318'))
    print(f'本地转写已启动：http://127.0.0.1:{port}', flush=True)
    HTTPServer(('127.0.0.1', port), Handler).serve_forever()
