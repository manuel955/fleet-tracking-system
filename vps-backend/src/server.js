import { createApp } from './app.js';
import { closeDatabase } from './db.js';
import { config } from './config.js';

const server = createApp();
server.listen(config.port, config.host, () => {
  console.log(`APL VPS backend listening on http://${config.host}:${config.port}`);
});

async function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  server.close(async () => {
    await closeDatabase();
    process.exit(0);
  });
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
