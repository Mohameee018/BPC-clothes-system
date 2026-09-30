import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "inspect_desktop_sqlite.py"


class InspectDesktopSqliteTests(unittest.TestCase):
    def test_reports_counts_without_row_values_and_does_not_mutate_database(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Path(directory) / "clothes_system.db"
            connection = sqlite3.connect(db)
            connection.executescript("""
                PRAGMA foreign_keys=ON;
                CREATE TABLE products (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    image_path TEXT
                );
                INSERT INTO products VALUES ('PRD-001', 'PRIVATE PRODUCT NAME', 'missing-image.png');
            """)
            connection.commit()
            connection.close()
            before = db.read_bytes()

            result = subprocess.run(
                [sys.executable, str(SCRIPT), str(db)],
                check=False, capture_output=True, text=True
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertTrue(report["read_only"])
            self.assertEqual(report["tables"]["products"]["row_count"], 1)
            self.assertEqual(report["image_path_audit"]["missing_paths"], 1)
            self.assertNotIn("PRIVATE PRODUCT NAME", result.stdout)
            self.assertNotIn("missing-image.png", result.stdout)
            self.assertEqual(before, db.read_bytes())

    def test_missing_database_fails_cleanly(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "absent.db"
            result = subprocess.run(
                [sys.executable, str(SCRIPT), str(missing)],
                check=False, capture_output=True, text=True
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("does not exist", result.stderr)


if __name__ == "__main__":
    unittest.main()
