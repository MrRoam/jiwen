"""验证开放环工具会真实显示慢服务积压，并仅用人工标注计算 CER。"""
import importlib.util
import pathlib
import threading
import time
import unittest

root = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('asr_benchmark', root / 'scripts' / 'benchmark-local-asr.py')
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)
asr_spec = importlib.util.spec_from_file_location('asr_benchmark_server', root / 'server' / 'local_asr.py')
asr = importlib.util.module_from_spec(asr_spec)
import sys
sys.modules[asr_spec.name] = asr
asr_spec.loader.exec_module(asr)


class SlowEngine:
    metadata = {'engine': 'test'}
    streaming, chunk_seconds = True, .6

    def infer(self, pcm, state, final):
        time.sleep(.18)
        return {'segments': []}


class BenchmarkTests(unittest.TestCase):
    def test_open_loop_generates_without_waiting_for_slow_inference(self):
        scheduler = asr.Scheduler(SlowEngine())
        server = asr.ASRHTTPServer(('127.0.0.1', 0), asr.make_handler(scheduler))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            report = benchmark.run_load(f'http://127.0.0.1:{server.server_port}', bytes(32000), 5, 1.2, .6, 5, 20)
            self.assertEqual(report['generated'], 10)
            self.assertEqual(report['completed'], 10)
            self.assertEqual(report['failedStreams'], 0)
            self.assertEqual(report['workersStillRunning'], 0)
            self.assertGreater(report['clientQueue']['maxMs'], 100)
            self.assertGreater(max(item['serverQueuedJobs'] or 0 for item in report['backlogSamples']), 0)
        finally:
            scheduler.close();server.shutdown();server.server_close()

    def test_cer_requires_actual_reference_and_counts_edits(self):
        self.assertEqual(benchmark.character_error_rate('你好，课堂！', '你好课堂')['cer'], 0)
        self.assertEqual(benchmark.character_error_rate('课堂', '课题')['cer'], .5)
        with self.assertRaises(ValueError):
            benchmark.character_error_rate('  ，', '课堂')


if __name__ == '__main__':
    unittest.main()
