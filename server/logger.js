'use strict';

function timestamp(date = new Date()) {
  return date.toTimeString().slice(0, 8);
}

function log(scope, ...args) {
  console.log(`[${timestamp()}] [${scope}]`, ...args);
}

function logError(scope, ...args) {
  console.error(`[${timestamp()}] [${scope}]`, ...args);
}

function truncate(text, max = 160) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return String(bytes);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

module.exports = { timestamp, log, logError, truncate, formatBytes };
