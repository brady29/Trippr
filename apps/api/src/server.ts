import { buildApp } from "./app";
import { connectWithRetry, prepareDatabase } from "./bootstrap";
import { loadConfig } from "./config";
import { startErrorReporting } from "./monitoring";

const config = loadConfig();
const errors = await startErrorReporting(config);
const startupLog = {
  info: (obj: unknown, msg?: string) => console.log(JSON.stringify({ level: 30, msg, ...(obj as object) })),
  warn: (obj: unknown, msg?: string) => console.warn(JSON.stringify({ level: 40, msg, ...(obj as object) })),
};

const db = await connectWithRetry(config, startupLog);
await prepareDatabase(db, config, startupLog);
const app = await buildApp({ config, db, onError: errors?.capture });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await db.close();
  await errors?.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: config.PORT, host: config.HOST });
