"""Static controls for the two self-provisioned browser lanes."""
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
EXCLUSION = "--exclude-migrations '2026093002*'"


def check_lane(source: str, phase: str) -> None:
    assert phase in {"pre", "post"}
    required = (f"HEAVY_LANE:-}}\" == outbox-{phase}", f"export HEAVY_PHASE={phase}", "google-chrome --version", "node scripts/outbox-run-record.mjs pre-merge")
    for token in required:
        if token not in source:
            raise ValueError(f"missing lane control: {token}")
    if (EXCLUSION in source) != (phase == "pre"):
        raise ValueError("wrong pre/post migration exclusion")


class LaneShapeTests(unittest.TestCase):
    def test_pre_and_post_lanes(self):
        for phase in ("pre", "post"):
            source = (HERE / f"outbox-{phase}.sh").read_text()
            check_lane(source, phase)
            with self.assertRaises(ValueError):
                check_lane(source.replace(f"export HEAVY_PHASE={phase}", "export HEAVY_PHASE=wrong"), phase)
        with self.assertRaises(ValueError):
            check_lane((HERE / "outbox-pre.sh").read_text().replace(EXCLUSION, ""), "pre")
        with self.assertRaises(ValueError):
            check_lane((HERE / "outbox-post.sh").read_text() + EXCLUSION, "post")

    def test_db_contract_pre_excludes_same_migrations(self):
        self.assertIn(EXCLUSION, (HERE / "db-contract-pre.sh").read_text())


if __name__ == "__main__":
    unittest.main()
