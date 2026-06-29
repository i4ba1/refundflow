const log = (level: string, msg: string, meta?: unknown) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, meta }))

export const logger = {
  info: (msg: string, meta?: unknown) => log('info', msg, meta),
  warn: (msg: string, meta?: unknown) => log('warn', msg, meta),
  error: (msg: string, meta?: unknown) => log('error', msg, meta),
  debug: (msg: string, meta?: unknown) => {
    if (process.env.LOG_LEVEL === 'debug') log('debug', msg, meta)
  },
}