// Minimal structured logger (no dependency). One line per event: ISO time, level, scope, message, JSON context.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

let threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

export function setLogLevel(level) {
  if (!(level in LEVELS)) throw new Error(`unknown log level ${level}`);
  threshold = LEVELS[level];
}

function emit(level, scope, msg, ctx) {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}` +
    (ctx && Object.keys(ctx).length ? ` ${JSON.stringify(ctx)}` : '');
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export function createLogger(scope) {
  return {
    debug: (msg, ctx) => emit('debug', scope, msg, ctx),
    info: (msg, ctx) => emit('info', scope, msg, ctx),
    warn: (msg, ctx) => emit('warn', scope, msg, ctx),
    error: (msg, ctx) => emit('error', scope, msg, ctx),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}
