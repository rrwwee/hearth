import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path


TEMP_DIR = tempfile.TemporaryDirectory()
os.environ["HEARTH_BASE_DIR"] = TEMP_DIR.name
sys.dont_write_bytecode = True
MODULE_PATH = Path(__file__).parents[1] / "pi" / "dashboard" / "dashboard_agent.py"
SPEC = importlib.util.spec_from_file_location("dashboard_agent", MODULE_PATH)
dashboard_agent = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dashboard_agent)


class AccountingParserTests(unittest.TestCase):
    def test_friend_colors_are_loaded_from_private_cluster_config(self):
        config_path = dashboard_agent.CONFIG_DIR / "cluster.json"
        config_path.write_text(json.dumps({
            "sshHost": "compute",
            "jumpHost": "cluster-jump",
            "user": "researcher",
            "friends": ["researcher", "collaborator"],
            "friendColors": {"researcher": "red", "collaborator": "blue"},
        }), encoding="utf-8")

        config = dashboard_agent.load_cluster_config()

        self.assertEqual(config["friendColors"], {"researcher": "red", "collaborator": "blue"})

    def test_unavailable_accounting_is_explicit(self):
        self.assertEqual(dashboard_agent.parse_accounting(["__UNAVAILABLE__"]), (False, []))

    def test_terminal_rows_are_parsed_and_nonterminal_rows_ignored(self):
        available, jobs = dashboard_agent.parse_accounting([
            "__AVAILABLE__",
            "420|researcher|COMPLETED|00:02:00|2026-07-21T10:00:00|2026-07-21T10:01:00|2026-07-21T10:03:00|good-job",
            "421|researcher|OUT_OF_MEMORY+|00:01:00|2026-07-21T10:00:00|2026-07-21T10:01:00|2026-07-21T10:02:00|large-job",
            "422|researcher|RUNNING|00:00:10|2026-07-21T10:00:00|2026-07-21T10:01:00|Unknown|live-job",
        ])

        self.assertTrue(available)
        self.assertEqual([job["id"] for job in jobs], ["420", "421"])
        self.assertEqual(jobs[1]["state"], "OUT_OF_MEMORY")
        self.assertEqual(jobs[0]["name"], "good-job")
        self.assertEqual(jobs[0]["startedAt"], "2026-07-21T10:01:00")


if __name__ == "__main__":
    unittest.main()
