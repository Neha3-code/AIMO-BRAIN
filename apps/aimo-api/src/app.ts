import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { registerProductRoutes } from "./routes/products.js";
import { registerQuoteRoutes } from "./routes/quotes.js";
import { registerOrderRoutes } from "./routes/orders.js";
import { registerBuyerRoutes } from "./routes/buyers.js";
import { registerPlatformAuthRoutes } from "./routes/platformAuth.js";
import { registerOrganizationRoutes } from "./routes/organizations.js";
import { registerPolicyRoutes } from "./routes/policies.js";

const CORRELATION_ID = /^[A-Za-z0-9._-]{8,64}$/;

export function buildApp(config: AppConfig, opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? true,
    // A caller may supply its own correlation id; anything malformed is replaced, because the
    // value is written to logs and audit records.
    genReqId: (req) => {
      const supplied = req.headers["x-correlation-id"];
      return typeof supplied === "string" && CORRELATION_ID.test(supplied) ? supplied : randomUUID();
    }
  });

  // Every response says which environment produced it, so a sandbox answer can never be
  // mistaken for a production one (PROJECT.md invariant 8).
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-aimo-environment", config.environment);
    reply.header("x-correlation-id", request.id);
  });

  app.get("/health", async () => ({ status: "ok", environment: config.environment, features: config.features }));

  // Junction26 demo routes: unchanged, always on.
  registerProductRoutes(app);
  registerQuoteRoutes(app);
  registerOrderRoutes(app);
  registerBuyerRoutes(app);

  // Phase 1 platform routes exist only when the flag is on; otherwise they are plain 404s.
  if (config.features.organizations) {
    registerPlatformAuthRoutes(app);
    // Encapsulated so each group's requireUser hook covers its own routes and nothing else.
    app.register(async (scope) => registerOrganizationRoutes(scope));
    app.register(async (scope) => registerPolicyRoutes(scope));
  }

  return app;
}
