import "dotenv/config";
import Fastify from "fastify";
import { registerProductRoutes } from "./routes/products.js";
import { registerQuoteRoutes } from "./routes/quotes.js";
import { registerOrderRoutes } from "./routes/orders.js";

const app = Fastify({ logger: true });

app.get("/health", async () => ({ status: "ok" }));

registerProductRoutes(app);
registerQuoteRoutes(app);
registerOrderRoutes(app);

const port = Number(process.env.PORT ?? 8080);
app
  .listen({ port, host: "0.0.0.0" })
  .then(() => app.log.info(`aimo-api listening on ${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
