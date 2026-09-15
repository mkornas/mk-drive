/**
 * mk-drive server: the JSON + file-streaming API over the configured
 * locations, and the built Angular app as a SPA. `node src/index.ts`
 * (Node ≥ 24 strips types).
 */
import { config } from './config.ts';
import { createApp } from './app.ts';

const app = await createApp(config);
await app.listen({ port: config.port, host: config.host });
app.log.info(`mk-drive ${config.version} (${config.build}) on http://${config.host}:${config.port}`);

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
