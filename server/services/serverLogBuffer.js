const util = require("util");

const MAX_LOG_LINES = 1000;
const LEVELS = ["log", "info", "warn", "error", "debug"];
const originalConsole = {};
const entries = [];
let installed = false;
let nextId = 1;

function formatArg(arg) {
  if (arg instanceof Error) {
    return arg.stack || arg.message;
  }

  if (typeof arg === "string") return arg;

  return util.inspect(arg, {
    depth: 5,
    colors: false,
    breakLength: 140,
    maxArrayLength: 80,
  });
}

function append(level, args) {
  entries.push({
    id: nextId++,
    at: new Date().toISOString(),
    level,
    message: args.map(formatArg).join(" "),
  });

  if (entries.length > MAX_LOG_LINES) {
    entries.splice(0, entries.length - MAX_LOG_LINES);
  }
}

function installConsoleLogBuffer() {
  if (installed) return;
  installed = true;

  for (const level of LEVELS) {
    originalConsole[level] = console[level].bind(console);
    console[level] = (...args) => {
      append(level, args);
      originalConsole[level](...args);
    };
  }

  append("info", ["Server log buffer attached"]);
}

function getLogEntries(options = {}) {
  const limit = Math.min(
    MAX_LOG_LINES,
    Math.max(1, Number.parseInt(options.limit, 10) || 250)
  );
  const afterId = Number.parseInt(options.afterId, 10);
  const filtered = Number.isInteger(afterId)
    ? entries.filter((entry) => entry.id > afterId)
    : entries;

  return filtered.slice(-limit);
}

module.exports = {
  getLogEntries,
  installConsoleLogBuffer,
};
