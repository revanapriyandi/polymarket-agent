import pino from 'pino';
export const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.body', 'res.headers["set-cookie"]', 'password', 'apiKey', 'privateKey', 'secrets', 'ciphertext', 'config.MASTER_KEY'], censor: '[REDACTED]' } });
export function safeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'ZodError') return 'Data tidak sesuai schema';
    return error.message.replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]').replace(/0x[a-f\d]{64}/gi, '[REDACTED]').slice(0, 1000);
  }
  return 'Kesalahan tidak dikenal';
}
