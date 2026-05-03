// ------------------------------------------------------------
// /server/services/expenses/expenseService.js
// Service layer for expense CRUD, filtering, and summary queries.
// Keeps SQL logic out of the router and normalizes validation / shaping.
// ------------------------------------------------------------

const pool = require("../../db");

const ALLOWED_SCOPES = new Set(["direct", "general", "shared", "apportioned"]);
const ALLOWED_SORT_FIELDS = new Set([
  "date",
  "created_at",
  "updated_at",
  "price",
  "tax",
  "vendor",
  "category",
  "id",
]);
const ALLOWED_SORT_DIRECTIONS = new Set(["asc", "desc"]);
const CANONICAL_VENDOR_MAP = new Map([
  ["amazon", "Amazon"],
  ["ebay", "eBay"],
  ["91280 - austin-bergstr austin tx", "ABIA"],
]);
const DEFAULT_EXPENSE_CATEGORIES = [
  "Vehicle Onboard",
  "Operating Expense",
  "Maintenance",
  "Insurance",
  "Cleaning",
  "Interest",
  "Fuel",
  "Tools",
  "Tolls",
  "Tires",
  "Hospitality",
  "Parking",
  "Research / Travel",
  "Delivery",
  "Marketing",
];

function titleCaseWords(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b([a-z])/g, (match) => match.toUpperCase());
}

function toNumberOrNull(value) {
  if (value === "" || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toBooleanOrNull(value) {
  if (value === "" || value == null) return null;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === 1) return true;
  if (value === "false" || value === "0" || value === 0) return false;
  return null;
}

function cleanString(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s || null;
}

function parseSearchNumber(value) {
  const cleaned = cleanString(value);
  if (!cleaned) return null;
  const normalized = cleaned.replace(/[$,]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function canonicalizeVendor(value) {
  const cleaned = cleanString(value);
  if (!cleaned) return null;
  const canonical = CANONICAL_VENDOR_MAP.get(cleaned.toLowerCase());
  if (canonical) return canonical;
  if (cleaned === cleaned.toUpperCase()) {
    return titleCaseWords(cleaned);
  }
  return cleaned;
}

function getSuggestionDedupKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function choosePreferredSuggestionLabel(current, candidate) {
  if (!current) return candidate;
  if (!candidate) return current;

  const currentLooksShouty = current === current.toUpperCase();
  const candidateLooksShouty = candidate === candidate.toUpperCase();

  if (currentLooksShouty && !candidateLooksShouty) return candidate;
  if (!currentLooksShouty && candidateLooksShouty) return current;

  return String(candidate).length < String(current).length ? candidate : current;
}

function dedupeDisplayValues(values = []) {
  const merged = new Map();

  for (const rawValue of values) {
    const value = cleanString(rawValue);
    if (!value) continue;

    const normalized = canonicalizeVendor(value) || value;
    const key = getSuggestionDedupKey(normalized);
    const existing = merged.get(key);
    merged.set(key, choosePreferredSuggestionLabel(existing, normalized));
  }

  return Array.from(merged.values()).sort((a, b) =>
    String(a).localeCompare(String(b))
  );
}

function mergeVendorSummaryRows(rows = []) {
  const merged = new Map();

  for (const row of rows) {
    const vendor = canonicalizeVendor(row?.vendor) || "Unknown vendor";
    const existing = merged.get(vendor) || {
      vendor,
      row_count: 0,
      total: 0,
    };

    existing.row_count += Number(row?.row_count || 0);
    existing.total += Number(row?.total || 0);
    merged.set(vendor, existing);
  }

  return Array.from(merged.values())
    .sort((a, b) => b.total - a.total || String(a.vendor).localeCompare(String(b.vendor)))
    .map((row) => ({
      ...row,
      total: Number(row.total).toFixed(2),
    }));
}

function normalizeScope(value, fallback = "direct") {
  const s = cleanString(value)?.toLowerCase();
  if (!s) return fallback;
  if (!ALLOWED_SCOPES.has(s)) {
    const err = new Error(
      `Invalid expense_scope. Allowed values: ${Array.from(ALLOWED_SCOPES).join(", ")}`
    );
    err.status = 400;
    throw err;
  }
  return s;
}

function normalizeDate(value, fieldName = "date") {
  const s = cleanString(value);
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const err = new Error(`${fieldName} must be in YYYY-MM-DD format`);
    err.status = 400;
    throw err;
  }
  return s;
}

function normalizeExpenseInput(input, { partial = false } = {}) {
  const normalized = {};

  if (!partial || Object.prototype.hasOwnProperty.call(input, "vehicle_id")) {
    normalized.vehicle_id = toNumberOrNull(input.vehicle_id);
  }

  if (!partial || Object.prototype.hasOwnProperty.call(input, "vendor")) {
    normalized.vendor = canonicalizeVendor(input.vendor);
  }

  if (!partial || Object.prototype.hasOwnProperty.call(input, "price")) {
    const price = toNumberOrNull(input.price);
    if (price == null) {
      const err = new Error("price is required and must be numeric");
      err.status = 400;
      throw err;
    }
    normalized.price = price;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(input, "tax")) {
    const tax = toNumberOrNull(input.tax);
    normalized.tax = tax == null ? 0 : tax;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(input, "is_capitalized")) {
    const cap = toBooleanOrNull(input.is_capitalized);
    normalized.is_capitalized = cap == null ? false : cap;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(input, "category")) {
    normalized.category = cleanString(input.category);
  }

  if (!partial || Object.prototype.hasOwnProperty.call(input, "notes")) {
    normalized.notes = cleanString(input.notes);
  }

  if (!partial || Object.prototype.hasOwnProperty.call(input, "date")) {
    const date = normalizeDate(input.date, "date");
    if (!date) {
      const err = new Error("date is required and must be YYYY-MM-DD");
      err.status = 400;
      throw err;
    }
    normalized.date = date;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(input, "expense_scope")) {
    normalized.expense_scope = normalizeScope(
      input.expense_scope,
      normalized.vehicle_id ? "direct" : "shared"
    );
  }

  if (!partial || Object.prototype.hasOwnProperty.call(input, "trip_id")) {
    normalized.trip_id = toNumberOrNull(input.trip_id);
  }

  return normalized;
}

function normalizeListFilters(raw = {}) {
  const page = Math.max(1, Number(raw.page) || 1);
  const limit = Math.min(250, Math.max(1, Number(raw.limit) || 50));
  const offset = (page - 1) * limit;

  const sortField = ALLOWED_SORT_FIELDS.has(String(raw.sort || "").toLowerCase())
    ? String(raw.sort).toLowerCase()
    : "date";

  const sortDirection = ALLOWED_SORT_DIRECTIONS.has(String(raw.direction || "").toLowerCase())
    ? String(raw.direction).toLowerCase()
    : "desc";

  return {
    vehicle_id: toNumberOrNull(raw.vehicle_id),
    trip_id: toNumberOrNull(raw.trip_id),
    category: cleanString(raw.category),
    vendor: cleanString(raw.vendor),
    amount: cleanString(raw.amount),
    expense_scope: cleanString(raw.expense_scope)?.toLowerCase() || null,
    is_capitalized: toBooleanOrNull(raw.is_capitalized),
    date_from: normalizeDate(raw.date_from, "date_from"),
    date_to: normalizeDate(raw.date_to, "date_to"),
    q: cleanString(raw.q),
    page,
    limit,
    offset,
    sortField,
    sortDirection,
  };
}

function buildWhereClause(filters) {
  const clauses = [];
  const values = [];

  function addClause(sql, value) {
    values.push(value);
    clauses.push(sql.replace("?", `$${values.length}`));
  }

  if (filters.vehicle_id != null) {
    addClause("e.vehicle_id = ?", filters.vehicle_id);
  }

  if (filters.trip_id != null) {
    addClause("e.trip_id = ?", filters.trip_id);
  }

  if (filters.category) {
    addClause("LOWER(e.category) = LOWER(?)", filters.category);
  }

  if (filters.vendor) {
    if (filters.vendor === "__unknown__") {
      clauses.push(`(e.vendor IS NULL OR TRIM(e.vendor) = '')`);
    } else {
      addClause("LOWER(e.vendor) = LOWER(?)", filters.vendor);
    }
  }

  if (filters.expense_scope) {
    if (!ALLOWED_SCOPES.has(filters.expense_scope)) {
      const err = new Error(
        `Invalid expense_scope. Allowed values: ${Array.from(ALLOWED_SCOPES).join(", ")}`
      );
      err.status = 400;
      throw err;
    }
    addClause("e.expense_scope = ?", filters.expense_scope);
  }

  if (filters.is_capitalized != null) {
    addClause("e.is_capitalized = ?", filters.is_capitalized);
  }

  if (filters.date_from) {
    addClause("e.date >= ?", filters.date_from);
  }

  if (filters.date_to) {
    addClause("e.date <= ?", filters.date_to);
  }

  if (filters.q) {
    values.push(`%${filters.q}%`);
    values.push(`%${filters.q}%`);
    values.push(`%${filters.q}%`);
    clauses.push(
      `(e.vendor ILIKE $${values.length - 2} OR e.category ILIKE $${values.length - 1} OR e.notes ILIKE $${values.length})`
    );
  }

  if (filters.amount) {
    const numericAmount = parseSearchNumber(filters.amount);
    if (numericAmount == null) {
      const err = new Error("amount filter must be a valid number or integer id");
      err.status = 400;
      throw err;
    }

    values.push(numericAmount);
    let numericClause = `(ROUND(COALESCE(e.price, 0)::numeric, 2) = ROUND($${values.length}::numeric, 2) OR ROUND(COALESCE(e.tax, 0)::numeric, 2) = ROUND($${values.length}::numeric, 2) OR ROUND((COALESCE(e.price, 0) + COALESCE(e.tax, 0))::numeric, 2) = ROUND($${values.length}::numeric, 2)`;

    if (Number.isInteger(numericAmount)) {
      values.push(numericAmount);
      numericClause += ` OR e.id = $${values.length}::int`;
    }

    numericClause += `)`;
    clauses.push(numericClause);
  }

  const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return { whereSql, values };
}

// ------------------------------------------------------------
// Capital Basis Breakdown
// ------------------------------------------------------------

async function getCapitalBasisBreakdown({
  vehicle_id,
  category = "Vehicle Onboard",
  include_line_items,
  include_purchase_price = "true",
}) {
  const params = [];
  const expenseFilters = [];
  const vehicleFilters = [];

  if (category) {
    params.push(category);
    expenseFilters.push(`e.category = $${params.length}`);
  }

  if (vehicle_id) {
    params.push(Number(vehicle_id));
    expenseFilters.push(`e.vehicle_id = $${params.length}`);
    vehicleFilters.push(`v.id = $${params.length}`);
  }

  const expenseFilterSql =
    expenseFilters.length > 0 ? `AND ${expenseFilters.join(" AND ")}` : "";

  const vehicleWhereSql =
    vehicleFilters.length > 0 ? `WHERE ${vehicleFilters.join(" AND ")}` : "";

  const aggregateQuery = `
    SELECT
      v.id AS vehicle_id,
      v.nickname,
      v.vin,
      COALESCE(v.acquisition_cost, 0) AS acquisition_cost,
      COALESCE(SUM(
        CASE 
          WHEN e.is_capitalized = true 
          THEN e.price + COALESCE(e.tax, 0)
          ELSE 0
        END
      ), 0) AS onboarding_expenses
    FROM vehicles v
    LEFT JOIN expenses e
      ON e.vehicle_id = v.id
      ${expenseFilterSql}
    ${vehicleWhereSql}
    GROUP BY v.id, v.nickname, v.vin, v.acquisition_cost
    ORDER BY v.id
  `;

  const { rows } = await pool.query(aggregateQuery, params);

  let lineItemsByVehicle = {};
  if (include_line_items === "true") {
    const lineQuery = `
      SELECT
        e.id,
        e.vehicle_id,
        e.date,
        e.vendor,
        e.category,
        e.price,
        e.tax,
        (e.price + COALESCE(e.tax, 0)) AS total,
        e.notes,
        e.expense_scope,
        e.trip_id,
        e.is_capitalized
      FROM expenses e
      WHERE 1=1
        ${expenseFilters.length > 0 ? `AND ${expenseFilters.join(" AND ")}` : ""}
        AND e.is_capitalized = true
      ORDER BY e.vehicle_id, e.date, e.id
    `;

    const { rows: lineRows } = await pool.query(lineQuery, params);

    for (const row of lineRows) {
      if (!lineItemsByVehicle[row.vehicle_id]) {
        lineItemsByVehicle[row.vehicle_id] = [];
      }
      lineItemsByVehicle[row.vehicle_id].push({
        id: row.id,
        vehicle_id: row.vehicle_id,
        date: row.date,
        vendor: canonicalizeVendor(row.vendor),
        category: row.category,
        price: Number(row.price ?? 0),
        tax: Number(row.tax ?? 0),
        total: Number(row.total ?? 0),
        notes: row.notes,
        expense_scope: row.expense_scope,
        trip_id: row.trip_id,
        is_capitalized: row.is_capitalized,
      });
    }
  }

  const vehicles = rows.map((v) => {
    const acquisitionCost =
      include_purchase_price === "true"
        ? Number(v.acquisition_cost ?? 0)
        : 0;

    const onboardingExpenses = Number(v.onboarding_expenses ?? 0);
    const capitalBasis = acquisitionCost + onboardingExpenses;

    return {
      vehicle_id: v.vehicle_id,
      nickname: v.nickname,
      vin: v.vin,
      acquisition_cost: acquisitionCost,
      onboarding_expenses: onboardingExpenses,
      capital_basis: capitalBasis,
      line_items:
        include_line_items === "true"
          ? lineItemsByVehicle[v.vehicle_id] || []
          : undefined,
    };
  });

  return {
    category_filter: category,
    vehicle_count: vehicles.length,
    vehicles,
  };
}


async function getExpenseSuggestions() {
  const [vendorsResult, categoriesResult, settingsResult] = await Promise.all([
    pool.query(`
      SELECT DISTINCT TRIM(vendor) AS value
      FROM expenses
      WHERE vendor IS NOT NULL
        AND TRIM(vendor) <> ''
      ORDER BY value ASC
    `),
    pool.query(`
      SELECT DISTINCT TRIM(category) AS value
      FROM expenses
      WHERE category IS NOT NULL
        AND TRIM(category) <> ''
      ORDER BY value ASC
    `),
    pool.query(`
      SELECT value
      FROM app_settings
      WHERE key = 'expenses.categories'
      LIMIT 1
    `),
  ]);

  const configuredCategories = Array.isArray(settingsResult.rows[0]?.value?.categories)
    ? settingsResult.rows[0].value.categories
    : DEFAULT_EXPENSE_CATEGORIES;

  return {
    vendors: dedupeDisplayValues(
      vendorsResult.rows.map((row) => row.value)
    ),
    categories: dedupeDisplayValues([
      ...configuredCategories,
      ...categoriesResult.rows.map((row) => row.value),
    ]),
  };
}

async function listExpenses(rawFilters = {}) {
  const filters = normalizeListFilters(rawFilters);
  const { whereSql, values } = buildWhereClause(filters);

  const baseFrom = `
    FROM expenses e
    LEFT JOIN vehicles v ON v.id = e.vehicle_id
    ${whereSql}
  `;

  const listQuery = `
    SELECT
      e.id,
      e.vehicle_id,
      v.nickname AS vehicle_nickname,
      v.make,
      v.model,
      v.year,
      e.vendor,
      e.price,
      e.tax,
      (COALESCE(e.price, 0) + COALESCE(e.tax, 0)) AS total_cost,
      e.is_capitalized,
      e.category,
      e.notes,
      TO_CHAR(e.date, 'YYYY-MM-DD') AS date,
      e.created_at,
      e.updated_at,
      e.expense_scope,
      e.trip_id
    ${baseFrom}
    ORDER BY e.${filters.sortField} ${filters.sortDirection}, e.id DESC
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
  `;

  const countQuery = `
    SELECT COUNT(*)::int AS total
    ${baseFrom}
  `;

  const totalQuery = `
    SELECT
      COUNT(*)::int AS row_count,
      COALESCE(SUM(e.price), 0)::numeric(12,2) AS subtotal,
      COALESCE(SUM(e.tax), 0)::numeric(12,2) AS tax_total,
      COALESCE(SUM(COALESCE(e.price, 0) + COALESCE(e.tax, 0)), 0)::numeric(12,2) AS grand_total
    ${baseFrom}
  `;

  const [listResult, countResult, totalsResult] = await Promise.all([
    pool.query(listQuery, [...values, filters.limit, filters.offset]),
    pool.query(countQuery, values),
    pool.query(totalQuery, values),
  ]);

  return {
    data: listResult.rows.map((row) => ({
      ...row,
      vendor: canonicalizeVendor(row.vendor),
    })),
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total: countResult.rows[0]?.total || 0,
    },
    totals: totalsResult.rows[0] || {
      row_count: 0,
      subtotal: "0.00",
      tax_total: "0.00",
      grand_total: "0.00",
    },
  };
}

async function getExpenseById(id) {
  const expenseId = Number(id);
  if (!Number.isInteger(expenseId) || expenseId <= 0) {
    const err = new Error("Invalid expense id");
    err.status = 400;
    throw err;
  }

  const result = await pool.query(
    `
      SELECT
        e.id,
        e.vehicle_id,
        e.vendor,
        e.price,
        e.tax,
        e.is_capitalized,
        e.category,
        e.notes,
        TO_CHAR(e.date, 'YYYY-MM-DD') AS date,
        e.created_at,
        e.updated_at,
        e.expense_scope,
        e.trip_id,
        v.nickname AS vehicle_nickname,
        v.make,
        v.model,
        v.year
        FROM expenses e
        LEFT JOIN vehicles v ON v.id = e.vehicle_id
        WHERE e.id = $1
        LIMIT 1
    `,
    [expenseId]
  );

  if (!result.rows[0]) return null;
  return {
    ...result.rows[0],
    vendor: canonicalizeVendor(result.rows[0].vendor),
  };
}

async function createExpense(input) {
  const data = normalizeExpenseInput(input, { partial: false });

  const result = await pool.query(
    `
      INSERT INTO expenses (
        vehicle_id,
        vendor,
        price,
        tax,
        is_capitalized,
        category,
        notes,
        date,
        expense_scope,
        trip_id,
        created_at,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      RETURNING *
    `,
    [
      data.vehicle_id,
      data.vendor,
      data.price,
      data.tax,
      data.is_capitalized,
      data.category,
      data.notes,
      data.date,
      data.expense_scope,
      data.trip_id,
    ]
  );

  return result.rows[0] ? { ...result.rows[0], vendor: canonicalizeVendor(result.rows[0].vendor) } : null;
}

async function updateExpense(id, input) {
  const expenseId = Number(id);
  if (!Number.isInteger(expenseId) || expenseId <= 0) {
    const err = new Error("Invalid expense id");
    err.status = 400;
    throw err;
  }

  const data = normalizeExpenseInput(input, { partial: true });

  const fields = [];
  const values = [];

  function addField(column, value) {
    values.push(value);
    fields.push(`${column} = $${values.length}`);
  }

  const updatableColumns = [
    "vehicle_id",
    "vendor",
    "price",
    "tax",
    "is_capitalized",
    "category",
    "notes",
    "date",
    "expense_scope",
    "trip_id",
  ];

  for (const column of updatableColumns) {
    if (Object.prototype.hasOwnProperty.call(data, column)) {
      addField(column, data[column]);
    }
  }

  if (!fields.length) {
    const existing = await getExpenseById(expenseId);
    if (!existing) return null;
    return existing;
  }

  fields.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(expenseId);

  const result = await pool.query(
    `
      UPDATE expenses
      SET ${fields.join(", ")}
      WHERE id = $${values.length}
      RETURNING *
    `,
    values
  );

  return result.rows[0]
    ? { ...result.rows[0], vendor: canonicalizeVendor(result.rows[0].vendor) }
    : null;
}

async function deleteExpense(id) {
  const expenseId = Number(id);
  if (!Number.isInteger(expenseId) || expenseId <= 0) {
    const err = new Error("Invalid expense id");
    err.status = 400;
    throw err;
  }

  const result = await pool.query(
    `
      DELETE FROM expenses
      WHERE id = $1
      RETURNING *
    `,
    [expenseId]
  );

  return result.rows[0] || null;
}

async function getExpenseSummary(rawFilters = {}) {
  const filters = normalizeListFilters(rawFilters);
  const { whereSql, values } = buildWhereClause(filters);

  const [result, byCategory, byVehicle, byScope, byVendor] = await Promise.all([
    pool.query(
      `
        SELECT
          COUNT(*)::int AS row_count,
          COALESCE(SUM(price), 0)::numeric(12,2) AS subtotal,
          COALESCE(SUM(tax), 0)::numeric(12,2) AS tax_total,
          COALESCE(SUM(COALESCE(price, 0) + COALESCE(tax, 0)), 0)::numeric(12,2) AS grand_total,
          COALESCE(SUM(CASE WHEN is_capitalized THEN COALESCE(price, 0) + COALESCE(tax, 0) ELSE 0 END), 0)::numeric(12,2) AS capitalized_total,
          COALESCE(SUM(CASE WHEN NOT is_capitalized THEN COALESCE(price, 0) + COALESCE(tax, 0) ELSE 0 END), 0)::numeric(12,2) AS non_capitalized_total
        FROM expenses e
        ${whereSql}
      `,
      values
    ),
    pool.query(
      `
        SELECT
          COALESCE(NULLIF(TRIM(category), ''), 'Uncategorized') AS category,
          COUNT(*)::int AS row_count,
          COALESCE(SUM(COALESCE(price, 0) + COALESCE(tax, 0)), 0)::numeric(12,2) AS total
        FROM expenses e
        ${whereSql}
        GROUP BY COALESCE(NULLIF(TRIM(category), ''), 'Uncategorized')
        ORDER BY total DESC, category ASC
      `,
      values
    ),
    pool.query(
      `
        SELECT
          e.vehicle_id,
          COALESCE(
            NULLIF(TRIM(v.nickname), ''),
            NULLIF(TRIM(CONCAT_WS(' ', v.year::text, v.make, v.model)), ''),
            'No vehicle'
          ) AS vehicle_label,
          COUNT(*)::int AS row_count,
          COALESCE(SUM(COALESCE(e.price, 0) + COALESCE(e.tax, 0)), 0)::numeric(12,2) AS total
        FROM expenses e
        LEFT JOIN vehicles v ON v.id = e.vehicle_id
        ${whereSql}
        GROUP BY e.vehicle_id, vehicle_label
        ORDER BY total DESC, vehicle_label ASC
      `,
      values
    ),
    pool.query(
      `
        SELECT
          e.expense_scope,
          COUNT(*)::int AS row_count,
          COALESCE(SUM(COALESCE(e.price, 0) + COALESCE(e.tax, 0)), 0)::numeric(12,2) AS total
        FROM expenses e
        ${whereSql}
        GROUP BY e.expense_scope
        ORDER BY total DESC, e.expense_scope ASC
      `,
      values
    ),
    pool.query(
      `
        SELECT
          COALESCE(NULLIF(TRIM(e.vendor), ''), 'Unknown vendor') AS vendor,
          COUNT(*)::int AS row_count,
          COALESCE(SUM(COALESCE(e.price, 0) + COALESCE(e.tax, 0)), 0)::numeric(12,2) AS total
        FROM expenses e
        ${whereSql}
        GROUP BY COALESCE(NULLIF(TRIM(e.vendor), ''), 'Unknown vendor')
        ORDER BY total DESC, vendor ASC
      `,
      values
    ),
  ]);

  const vendorSummaryRows = mergeVendorSummaryRows(byVendor.rows);

  return {
    totals: result.rows[0] || null,
    by_category: byCategory.rows,
    by_vehicle: byVehicle.rows,
    by_scope: byScope.rows,
    by_vendor: vendorSummaryRows,
    vendor_count: vendorSummaryRows.length,
  };
}

module.exports = {
  listExpenses,
  getExpenseById,
  createExpense,
  updateExpense,
  deleteExpense,
  getExpenseSummary,
  getExpenseSuggestions,
  getCapitalBasisBreakdown,
};
