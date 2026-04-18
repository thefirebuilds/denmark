require("dotenv").config({ path: "../.env" });
const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || "denmark",
  user: process.env.PGUSER || "postgres",
  password: String(process.env.PGPASSWORD || ""),
});

module.exports = pool;