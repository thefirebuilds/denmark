from __future__ import annotations

import csv
import os
import sys
from pathlib import Path

import psycopg2


def load_env(env_path: Path) -> None:
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def main() -> int:
    scripts_dir = Path(__file__).resolve().parent
    repo_root = scripts_dir.parent.parent
    load_env(repo_root / ".env")

    year_arg = sys.argv[1] if len(sys.argv) > 1 else "2025"
    try:
        year = int(year_arg)
    except ValueError as exc:
        raise SystemExit(f"Invalid year: {year_arg}") from exc

    if year < 2000 or year > 2100:
        raise SystemExit(f"Invalid year: {year_arg}")

    output_path = (
        Path(sys.argv[2])
        if len(sys.argv) > 2
        else scripts_dir / "tmp" / f"expenses_{year}_turbotax_export.csv"
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)

    conn = psycopg2.connect(
        host=os.getenv("PGHOST", "localhost"),
        port=int(os.getenv("PGPORT", "5432")),
        dbname=os.getenv("PGDATABASE", "denmark"),
        user=os.getenv("PGUSER", "postgres"),
        password=os.getenv("PGPASSWORD", ""),
    )

    start_date = f"{year}-01-01"
    end_date = f"{year + 1}-01-01"

    query = """
        SELECT
          TO_CHAR(e.date, 'YYYY-MM-DD') AS date,
          COALESCE(NULLIF(TRIM(e.vendor), ''), '') AS vendor,
          COALESCE(NULLIF(TRIM(e.category), ''), '') AS category,
          COALESCE(NULLIF(TRIM(e.notes), ''), '') AS notes,
          COALESCE(e.price, 0)::numeric(12,2) AS price,
          COALESCE(e.tax, 0)::numeric(12,2) AS tax,
          (COALESCE(e.price, 0) + COALESCE(e.tax, 0))::numeric(12,2) AS total,
          COALESCE(e.is_capitalized, false) AS is_capitalized,
          COALESCE(NULLIF(TRIM(e.expense_scope), ''), '') AS expense_scope,
          COALESCE(e.trip_id::text, '') AS trip_id,
          COALESCE(v.nickname, '') AS vehicle_nickname,
          COALESCE(v.year::text, '') AS vehicle_year,
          COALESCE(v.make, '') AS vehicle_make,
          COALESCE(v.model, '') AS vehicle_model,
          COALESCE(v.vin, '') AS vehicle_vin,
          e.id AS expense_id
        FROM expenses e
        LEFT JOIN vehicles v ON v.id = e.vehicle_id
        WHERE e.date >= %s::date
          AND e.date < %s::date
        ORDER BY e.date ASC, e.id ASC
    """

    headers = [
        "date",
        "vendor",
        "category",
        "notes",
        "price",
        "tax",
        "total",
        "is_capitalized",
        "expense_scope",
        "trip_id",
        "vehicle_nickname",
        "vehicle_year",
        "vehicle_make",
        "vehicle_model",
        "vehicle_vin",
        "expense_id",
    ]

    subtotal = 0.0
    tax_total = 0.0
    grand_total = 0.0

    try:
        with conn, conn.cursor() as cur:
            cur.execute(query, (start_date, end_date))
            rows = cur.fetchall()

        with output_path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(headers)
            for row in rows:
                writer.writerow(row)
                subtotal += float(row[4] or 0)
                tax_total += float(row[5] or 0)
                grand_total += float(row[6] or 0)
    finally:
        conn.close()

    print(f"Exported {len(rows)} expenses for {year}.")
    print(f"CSV written to: {output_path}")
    print(
        f"Totals: subtotal=${subtotal:.2f}, tax=${tax_total:.2f}, total=${grand_total:.2f}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
