import "dotenv/config";
import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";

const config = loadConfig();
const app = buildApp(config);
for (const warning of config.warnings) app.log.warn(warning);

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then(() => app.log.info({ environment: config.environment, features: config.features }, `aimo-api listening on ${config.port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
