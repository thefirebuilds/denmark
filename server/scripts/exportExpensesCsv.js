const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

const pool = require("../db");

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function toCsv(rows, headers) {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

async function main() {
  const yearArg = process.argv[2] || "2025";
  const year = Number.parseInt(yearArg, 10);

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error(`Invalid year: ${yearArg}`);
  }

  const startDate = `${year}-01-01`;
  const endDate = `${year + 1}-01-01`;
  const outputDir = path.join(__dirname, "tmp");
  const outputPath =
    process.argv[3] ||
    path.join(outputDir, `expenses_${year}_turbotax_export.csv`);

  const result = await pool.query(
    `
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
      WHERE e.date >= $1::date
        AND e.date < $2::date
      ORDER BY e.date ASC, e.id ASC
    `,
    [startDate, endDate]
  );

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const headers = [
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
  ];

  fs.writeFileSync(outputPath, toCsv(result.rows, headers), "utf8");

  const totals = result.rows.reduce(
    (acc, row) => {
      acc.price += Number(row.price || 0);
      acc.tax += Number(row.tax || 0);
      acc.total += Number(row.total || 0);
      return acc;
    },
    { price: 0, tax: 0, total: 0 }
  );

  console.log(`Exported ${result.rows.length} expenses for ${year}.`);
  console.log(`CSV written to: ${outputPath}`);
  console.log(
    `Totals: subtotal=$${totals.price.toFixed(2)}, tax=$${totals.tax.toFixed(
      2
    )}, total=$${totals.total.toFixed(2)}`
  );
}

main()
  .catch((error) => {
    console.error("Expense export failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
