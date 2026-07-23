from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from backend.builder.build import build_lock


class BuildLockTests(unittest.TestCase):
    def test_kernel_lock_blocks_concurrent_builder_despite_marker_rename(self) -> None:
        contender = """
import sys
from pathlib import Path
from backend.builder.build import BuildError, build_lock
try:
    with build_lock(Path(sys.argv[1])):
        pass
except BuildError:
    raise SystemExit(17)
"""
        with tempfile.TemporaryDirectory() as directory:
            output_root = Path(directory) / "builds"
            output_root.mkdir()
            with build_lock(output_root):
                # Reproduce the shape of a FileProvider conflict rename. The
                # authoritative lock is outside the synchronized output root.
                marker = output_root / ".annotation-build.lock"
                marker.write_text("legacy marker\n", encoding="ascii")
                marker.rename(output_root / ".annotation-build 2.lock")
                blocked = subprocess.run(
                    [sys.executable, "-c", contender, str(output_root)],
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    check=False,
                )
                self.assertEqual(blocked.returncode, 17, blocked.stderr)

            acquired = subprocess.run(
                [sys.executable, "-c", contender, str(output_root)],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
            self.assertEqual(acquired.returncode, 0, acquired.stderr)


if __name__ == "__main__":
    unittest.main()
