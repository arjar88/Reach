process.env.DATABASE_URL_SESSION ??= "postgres://reach:reach@127.0.0.1:5432/reach_test";
process.env.DATABASE_URL_POOLED ??= process.env.DATABASE_URL_SESSION;
process.env.REDIS_URL ??= "redis://127.0.0.1:6379";
process.env.SIGNING_SECRET ??= "test-signing-secret";
process.env.APP_URL ??= "http://localhost:3000";
process.env.CRON_SECRET ??= "test-cron-secret";
process.env.UNIPILE_WEBHOOK_SECRET ??= "test-unipile-secret";
process.env.OPS_ALERT_EMAIL ??= "ops@example.com";
