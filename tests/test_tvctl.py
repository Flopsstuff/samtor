import contextlib
import importlib
import io
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


TOOLS_DIR = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS_DIR))
sys.modules.setdefault(
    "samsungtvws",
    types.SimpleNamespace(SamsungTVWS=object),
)
tvctl = importlib.import_module("tvctl")


class PairingOutputTest(unittest.TestCase):
    def test_pair_does_not_print_token_contents(self):
        secret = "12345678"

        with tempfile.TemporaryDirectory() as directory:
            token_file = Path(directory) / "token.txt"

            class FakeTV:
                def open(self):
                    token_file.write_text(secret, encoding="utf-8")

                def send_key(self, key):
                    pass

                def close(self):
                    pass

            output = io.StringIO()
            with (
                mock.patch.object(tvctl, "TOKEN_FILE", str(token_file)),
                mock.patch.object(tvctl, "connect", return_value=FakeTV()),
                contextlib.redirect_stdout(output),
            ):
                tvctl.cmd_pair(types.SimpleNamespace())

        self.assertNotIn(secret, output.getvalue())


if __name__ == "__main__":
    unittest.main()
