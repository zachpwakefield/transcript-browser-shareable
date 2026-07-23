from __future__ import annotations

import unittest

from backend.builder.build import parse_args, validate_reference


class OptionalReferenceTests(unittest.TestCase):
    def test_builder_accepts_annotation_only_invocation(self) -> None:
        args = parse_args(["--source", "data/cache", "--scope", "full"])
        self.assertIsNone(args.reference_fasta)

    def test_reference_validation_is_noop_when_not_supplied(self) -> None:
        self.assertIsNone(validate_reference(None))


if __name__ == "__main__":
    unittest.main()
