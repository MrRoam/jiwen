"""无需模型依赖，验证真实调度和 HTTP 接收层；不是容量/准确率评测。"""
import importlib.util
import json
import pathlib
import sys
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

path = pathlib.Path(__file__).resolve().parents[1] / 'server' / 'local_asr.py'
spec = importlib.util.spec_from_file_location('local_asr', path)
asr = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = asr
spec.loader.exec_module(asr)


class FakeEngine:
    metadata = {'engine': 'test'}
    streaming, chunk_seconds = True, .6

    def __init__(self):
        self.started, self.release = threading.Event(), threading.Event()
        self.caches = []

    def infer(self, pcm, state, final):
        self.started.set()
        self.release.wait(5)
        self.caches.append(state.cache)
        state.cache['calls'] = state.cache.get('calls', 0)+1
        return {'segments': []}


class SchedulerTests(unittest.TestCase):
    def test_queue_bounded_and_sequence_and_cache_isolation(self):
        engine = FakeEngine()
        scheduler = asr.Scheduler(engine, max_jobs=1, max_audio_seconds=1, max_streams=3)
        try:
            first = scheduler.submit(bytes(19200), 'a', 0, False)
            self.assertTrue(engine.started.wait(1))
            second = scheduler.submit(bytes(19200), 'b', 0, False)
            with self.assertRaises(asr.ASRError) as duplicate:
                scheduler.submit(bytes(19200), 'a', 0, False)
            self.assertEqual(duplicate.exception.status, 409)
            with self.assertRaises(asr.ASRError) as overload:
                scheduler.submit(bytes(19200), 'c', 0, False)
            self.assertEqual(overload.exception.code, 'queue_full')
            engine.release.set()
            self.assertTrue(first.done.wait(2));self.assertTrue(second.done.wait(2))
            self.assertIsNot(engine.caches[0], engine.caches[1])
            self.assertEqual(first.result['metrics']['audioSeconds'], .6)
            tail = scheduler.submit(b'', 'a', 1, True)
            self.assertTrue(tail.done.wait(2))
            self.assertEqual(engine.caches[0]['calls'], 2)
            self.assertNotIn('a', scheduler.streams)
        finally:
            engine.release.set();scheduler.close()

    def test_health_remains_responsive_during_inference(self):
        engine = FakeEngine()
        scheduler = asr.Scheduler(engine)
        server = ThreadingHTTPServer(('127.0.0.1', 0), asr.make_handler(scheduler))
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            job = scheduler.submit(bytes(19200), 'a', 0, True)
            self.assertTrue(engine.started.wait(1))
            with urllib.request.urlopen(f'http://127.0.0.1:{server.server_port}/health', timeout=1) as response:
                health = json.load(response)
            self.assertTrue(health['ready'])
            self.assertEqual(health['activeAudioSeconds'], .6)
            self.assertFalse(job.done.is_set())
        finally:
            engine.release.set();scheduler.close();server.shutdown();server.server_close()

    def test_stream_capacity_and_cancellation(self):
        engine = FakeEngine();engine.release.set()
        scheduler = asr.Scheduler(engine, max_streams=1)
        try:
            first = scheduler.submit(bytes(19200), 'a', 0, False)
            self.assertTrue(first.done.wait(2))
            with self.assertRaises(asr.ASRError) as error:
                scheduler.submit(bytes(19200), 'b', 0, False)
            self.assertEqual(error.exception.code, 'stream_capacity')
            scheduler.cancel('a')
            self.assertTrue(scheduler.submit(bytes(19200), 'b', 0, True).done.wait(2))
        finally:
            scheduler.close()


if __name__ == '__main__':
    unittest.main()
