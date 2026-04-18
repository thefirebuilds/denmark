const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

const pool = require("../db");

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function extractListedLocation(rawText) {
  const text = cleanText(rawText);
  if (!text) return null;

  const patterns = [
    /\b([A-Za-z .'-]+,\s*[A-Z]{2})(?=\s+\d{1,3}(?:,\d{3})?\s*K?\s*miles?\b)/i,
    /\b([A-Za-z .'-]+,\s*[A-Z]{2})(?=\s+(?:Message|About this vehicle|Driven\b|Automatic transmission|Location is approximate|Seller information|Seller details)\b)/i,
    /\bListed\s+.+?\s+in\s+([A-Za-z .'-]+,\s*[A-Z]{2})\b/i,
    /\b([A-Za-z .'-]+,\s*[A-Z]{2})\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return cleanText(match[1]);
    }
  }

  return null;
}

async function main() {
  const result = await pool.query(
    `
      SELECT id, url, listed_location, raw_text_sample
      FROM marketplace_listings
      WHERE COALESCE(NULLIF(TRIM(listed_location), ''), '') = ''
        AND COALESCE(NULLIF(TRIM(raw_text_sample), ''), '') <> ''
      ORDER BY id ASC
    `
  );

  let updated = 0;

  for (const row of result.rows) {
    const listedLocation = extractListedLocation(row.raw_text_sample);
    if (!listedLocation) continue;

    await pool.query(
      `
        UPDATE marketplace_listings
        SET listed_location = $2,
            updated_at = NOW()
        WHERE id = $1
      `,
      [row.id, listedLocation]
    );

    updated += 1;
    console.log(`Updated ${row.id}: ${listedLocation}`);
  }

  console.log(`Scanned ${result.rows.length} marketplace rows with blank location.`);
  console.log(`Updated ${updated} rows.`);
}

main()
  .catch((error) => {
    console.error("Marketplace location repair failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
