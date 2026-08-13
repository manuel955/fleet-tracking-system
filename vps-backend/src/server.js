import { createApp, detectStaleDrivers, dispatchScheduledTrips } from './app.js';
import { closeDatabase } from './db.js';
import { config } from './config.js';

const server = createApp();
const dispatchTimer = setInterval(async () => {
  try {
    const dispatched = await dispatchScheduledTrips();
    if (dispatched > 0) console.log(`Scheduled trips dispatched: ${dispatched}`);
    const alerted = await detectStaleDrivers();
    if (alerted > 0) console.log(`Stale driver signals alerted: ${alerted}`);
  } catch (error) {
    console.error('scheduled dispatch failed', error?.message ?? error);
  }
}, 15_000);
dispatchTimer.unref?.();

server.listen(config.port, config.host, () => {
  console.log(`APL VPS backend listening on http://${config.host}:${config.port}`);
});

async function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  clearInterval(dispatchTimer);
  server.close(async () => {
    await closeDatabase();
    process.exit(0);
  });
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
