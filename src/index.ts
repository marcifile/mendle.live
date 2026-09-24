import pino from "pino";
import { assertConfig, env } from "./config.js";
import { MendleEngine } from "./engine.js";

const log = pino({ level: env.logLevel });

process.on("unhandledRejection", (reason) => {
  log.fatal({ err: reason }, "unhandled rejection");
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  log.fatal({ err: error }, "uncaught exception");
  process.exit(1);
});

assertConfig();

const engine = new MendleEngine();
engine.start().catch((error) => {
  log.fatal({ err: error }, "engine failed to start");
  process.exit(1);
});
