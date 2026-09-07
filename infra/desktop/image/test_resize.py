import importlib.machinery
import importlib.util
from pathlib import Path
import unittest
import io
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader('desktop_control', str(Path(__file__).parents[1] / 'rootfs/usr/local/bin/octo-desktop-control'))
spec = importlib.util.spec_from_loader(loader.name, loader)
control = importlib.util.module_from_spec(spec)
loader.exec_module(control)

class ResizeTest(unittest.TestCase):
    def test_http_request_validation_and_dispatch(self):
        for raw, expected in [(b'{"width":800,"height":600}', 200), (b'[]', 400), (b'bad', 400), (b'', 400)]:
            with self.subTest(raw=raw), patch.object(control, 'resize', return_value={'width': 800, 'height': 600}) as resize:
                handler = object.__new__(control.Handler)
                handler.path = '/resize'
                handler.headers = {'Content-Length': str(len(raw))}
                handler.rfile = io.BytesIO(raw)
                with patch.object(handler, '_send') as send:
                    handler.do_POST()
                    self.assertEqual(send.call_args.args[0], expected)
                if expected == 200:
                    resize.assert_called_once_with(800, 600)
                else:
                    resize.assert_not_called()

    def test_rejects_invalid_dimensions_before_command(self):
        for width, height in [(True, 600), (0, 600), (800.5, 600), (800, 99999)]:
            with self.subTest(width=width, height=height), patch.object(control, 'run') as run:
                with self.assertRaises(ValueError):
                    control.resize(width, height)
                run.assert_not_called()

    def test_resizes_only_configured_output_and_verifies(self):
        with patch.object(control, 'run') as run, patch.object(control, 'hyprctl_json', return_value=[{'name': control.OUTPUT, 'width': 800, 'height': 600}]):
            run.return_value.returncode = 0
            self.assertEqual(control.resize(800, 600), {'width': 800, 'height': 600})
            self.assertIn('800x600@30', run.call_args.args[0][-1])
            self.assertIn(control.OUTPUT, run.call_args.args[0][-1])

    def test_waits_for_compositor_to_apply_mode(self):
        with patch.object(control, 'run') as run, patch.object(control.time, 'sleep'), patch.object(control, 'hyprctl_json', side_effect=[
            [{'name': control.OUTPUT, 'width': 1440, 'height': 900}],
            [{'name': control.OUTPUT, 'width': 800, 'height': 600}],
        ]):
            run.return_value.returncode = 0
            self.assertEqual(control.resize(800, 600), {'width': 800, 'height': 600})

    def test_rejects_unapplied_mode(self):
        with patch.object(control, 'run') as run, patch.object(control, 'hyprctl_json', return_value=[{'name': control.OUTPUT, 'width': 1440, 'height': 900}]), patch.object(control.time, 'sleep'):
            run.return_value.returncode = 0
            with self.assertRaises(RuntimeError):
                control.resize(800, 600)

if __name__ == '__main__':
    unittest.main()
