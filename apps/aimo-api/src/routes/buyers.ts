import type { FastifyInstance } from "fastify";
import { getBuyer } from "../buyers.js";
import { requireBuyerAuth, type AuthedRequest } from "../auth.js";

/** Read-only view of a buyer's own commercial guardrail thresholds, so a UI can render
 *  "what Aimo's side will auto-approve" without hardcoding it. Invented demo data (spec §9). */
export function registerBuyerRoutes(app: FastifyInstance) {
  app.get("/v1/buyers/:id", { preHandler: requireBuyerAuth }, async (request: AuthedRequest, reply) => {
    const { id } = request.params as { id: string };
    if (id !== request.buyerId) {
      return reply.code(403).send({ error: "forbidden", message: "A buyer can only read its own guardrail profile." });
    }
    const buyer = await getBuyer(id);
    if (!buyer) return reply.code(404).send({ error: "not_found" });
    return reply.send(buyer);
  });
}
