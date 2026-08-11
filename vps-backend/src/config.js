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
  jwtSecret: process.env.JWT_SECRET ?? 'development-only-secret-change-me',
  // Firebase is retained only as the identity provider for the existing
  // dashboard and FCM. The operational data remains in PostgreSQL on the
  // VPS. Keeping the project id configurable lets the same bridge be used in
  // staging without copying any private Firebase credentials to the server.
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID ?? 'rastreoflota-53052',
  firebaseDashboardAuth: process.env.FIREBASE_DASHBOARD_AUTH !== 'false',
});

export { required };
