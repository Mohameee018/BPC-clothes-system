#!/usr/bin/env python3
"""Read-only inventory report for a local Clothes_system.db SQLite file.

This tool never writes to the database and deliberately omits business row values.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from urllib.parse import quote


def inspect_database(db_path: Path) -> dict:
    path = db_path.expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"SQLite database file does not exist: {path}")

    uri = "file:" + quote(str(path), safe="/:\\") + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    try:
        integrity_rows = [row[0] for row in connection.execute("PRAGMA integrity_check")]
        foreign_key_violations = [
            {"table": row[0], "rowid": row[1], "parent": row[2], "fkid": row[3]}
            for row in connection.execute("PRAGMA foreign_key_check")
        ]

        tables = {}
        image_audit = {"columns_checked": 0, "non_empty_paths": 0, "missing_paths": 0}
        table_names = [
            row[0] for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )
        ]
        for table_name in table_names:
            quoted_table = '"' + table_name.replace('"', '""') + '"'
            columns = list(connection.execute(f"PRAGMA table_info({quoted_table})"))
            count = connection.execute(f"SELECT COUNT(*) FROM {quoted_table}").fetchone()[0]
            tables[table_name] = {
                "row_count": count,
                "columns": [
                    {"name": column["name"], "type": column["type"], "not_null": bool(column["notnull"]),
                     "primary_key_position": column["pk"]}
                    for column in columns
                ],
            }
            for column in columns:
                column_name = column["name"]
                if column_name not in {"image_path"}:
                    continue
                image_audit["columns_checked"] += 1
                quoted_column = '"' + column_name.replace('"', '""') + '"'
                values = connection.execute(
                    f"SELECT {quoted_column} FROM {quoted_table} "
                    f"WHERE {quoted_column} IS NOT NULL AND TRIM({quoted_column}) <> ''"
                ).fetchall()
                for row in values:
                    image_audit["non_empty_paths"] += 1
                    image_value = Path(str(row[0])).expanduser()
                    if not image_value.is_absolute():
                        image_value = path.parent / image_value
                    if not image_value.is_file():
                        image_audit["missing_paths"] += 1

        return {
            "report_version": 1,
            "database": {"file_name": path.name, "size_bytes": path.stat().st_size},
            "read_only": True,
            "integrity_check": integrity_rows,
            "integrity_ok": integrity_rows == ["ok"],
            "foreign_key_violation_count": len(foreign_key_violations),
            "foreign_key_violations": foreign_key_violations,
            "image_path_audit": image_audit,
            "tables": tables,
            "safety_note": "No business row values or image paths are included in this report.",
        }
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path, help="Path to the existing local clothes_system.db file")
    parser.add_argument("--output", type=Path, help="Optional JSON report path (written separately; DB remains read-only)")
    args = parser.parse_args()

    try:
        report = inspect_database(args.database)
    except (OSError, sqlite3.Error, ValueError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, indent=2), file=sys.stderr)
        return 2

    rendered = json.dumps(report, indent=2, ensure_ascii=False)
    if args.output:
        args.output.expanduser().resolve().write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0 if report["integrity_ok"] and report["foreign_key_violation_count"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
