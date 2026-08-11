const required = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

export const config = Object.freeze({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '0.0.0.0',
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: process.env.DATABASE_URL ?? '',
  redisUrl: process.env.REDIS_URL ?? '',
  s3Endpoint: process.env.S3_ENDPOINT ?? '',
  s3Bucket: process.env.S3_BUCKET ?? '',
});

export { required };
