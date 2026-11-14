import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Order, QuoteLine } from "@aimo/shared";
import { query } from "../db.js";
import { newId } from "../ids.js";
import { requireBuyerAuth, type AuthedRequest } from "../auth.js";
import { getBuyer } from "../buyers.js";
import { checkAimoGuardrail } from "../guardrail.js";
import { recordAuditEvent, getAuditTrail } from "../audit.js";

const OrderRequestSchema = z.object({ quote_id: z.string() });
const ApproveRequestSchema = z.object({ actor: z.enum(["human:buyer", "human:aimo"]) });

function rowToOrder(row: any): Order {
  return {
    order_id: row.id,
    quote_id: row.quote_id,
    buyer_id: row.buyer_id,
    status: row.status,
    approval: {
      required: row.approval_required,
      owner: row.approval_owner,
      reason: row.approval_reason,
      requested_amount_eur: row.requested_amount_eur !== null ? Number(row.requested_amount_eur) : null,
      approved_amount_eur: row.approved_amount_eur !== null ? Number(row.approved_amount_eur) : null
    },
    lines_confirmed: row.lines_confirmed,
    lines_held: row.lines_held,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString()
  };
}

export function registerOrderRoutes(app: FastifyInstance) {
  app.post("/v1/orders", { preHandler: requireBuyerAuth }, async (request: AuthedRequest, reply) => {
    const parsed = OrderRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_request" });
    const buyerId = request.buyerId!;

    const quoteRows = await query<any>("SELECT * FROM quotes WHERE id = $1 AND buyer_id = $2", [parsed.data.quote_id, buyerId]);
    const quoteRow = quoteRows[0];
    if (!quoteRow) return reply.code(404).send({ error: "quote_not_found" });

    if (quoteRow.status === "consumed") {
      return reply.code(409).send({ error: "quote_already_consumed" });
    }
    if (new Date(quoteRow.expires_at) < new Date()) {
      return reply.code(409).send({ error: "quote_expired", message: "Re-quote before ordering." });
    }

    const buyer = await getBuyer(buyerId);
    if (!buyer) return reply.code(404).send({ error: "unknown_buyer" });

    const lines: QuoteLine[] = quoteRow.lines;
    const totalEur = Number(quoteRow.total_eur);
    const guardrail = checkAimoGuardrail({
      totalEur,
      buyer: { credit_limit_eur: Number(buyer.credit_limit_eur), aimo_side_auto_approve_limit_eur: Number(buyer.aimo_side_auto_approve_limit_eur) }
    });

    const orderId = newId("o");
    const status = guardrail.requiresApproval ? "held_for_approval" : "confirmed";
    const linesConfirmed = guardrail.requiresApproval ? [] : lines;
    const linesHeld = guardrail.requiresApproval ? lines : [];

    await query(
      `INSERT INTO orders (id, quote_id, buyer_id, status, approval_required, approval_owner, approval_reason, requested_amount_eur, approved_amount_eur, lines_confirmed, lines_held)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        orderId,
        quoteRow.id,
        buyerId,
        status,
        guardrail.requiresApproval,
        guardrail.requiresApproval ? "aimo" : null,
        guardrail.reason,
        guardrail.requiresApproval ? totalEur : null,
        guardrail.requiresApproval ? null : totalEur,
        JSON.stringify(linesConfirmed),
        JSON.stringify(linesHeld)
      ]
    );
    await query("UPDATE quotes SET status = 'consumed' WHERE id = $1", [quoteRow.id]);

    await recordAuditEvent(orderId, "buyer_agent", "order_submitted", [`Quote ${quoteRow.id} committed by buyer agent.`], "buyer-policy-v1");
    await recordAuditEvent(
      orderId,
      "aimo_api",
      guardrail.requiresApproval ? "order_held" : "order_confirmed",
      guardrail.reason ? [guardrail.reason] : ["Within credit limit and auto-approval ceiling."],
      guardrail.policyVersion
    );

    const rows = await query<any>("SELECT * FROM orders WHERE id = $1", [orderId]);
    return reply.send(rowToOrder(rows[0]));
  });

  app.get("/v1/orders/:id", { preHandler: requireBuyerAuth }, async (request: AuthedRequest, reply) => {
    const { id } = request.params as { id: string };
    const rows = await query<any>("SELECT * FROM orders WHERE id = $1 AND buyer_id = $2", [id, request.buyerId]);
    if (!rows[0]) return reply.code(404).send({ error: "not_found" });
    return reply.send(rowToOrder(rows[0]));
  });

  app.post("/v1/orders/:id/approve", { preHandler: requireBuyerAuth }, async (request: AuthedRequest, reply) => {
    const { id } = request.params as { id: string };
    const parsed = ApproveRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_request" });

    const rows = await query<any>("SELECT * FROM orders WHERE id = $1 AND buyer_id = $2", [id, request.buyerId]);
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (!row.approval_required || row.status !== "held_for_approval") {
      return reply.code(409).send({ error: "nothing_to_approve" });
    }

    // Governance boundary from spec §0: a buyer's human can never clear an
    // Aimo-owned hold, and vice versa.
    const actorRole = parsed.data.actor === "human:aimo" ? "aimo" : "buyer";
    if (actorRole !== row.approval_owner) {
      await recordAuditEvent(
        id,
        parsed.data.actor,
        "approval_rejected_wrong_owner",
        [`Hold is owned by '${row.approval_owner}', actor '${parsed.data.actor}' is not authorized to clear it.`],
        "aimo-guardrail-v1"
      );
      return reply.code(403).send({ error: "forbidden", message: `This hold is owned by '${row.approval_owner}'.` });
    }

    const lines = row.lines_held as QuoteLine[];
    await query(
      `UPDATE orders SET status = 'confirmed', lines_confirmed = $1, lines_held = '[]', approved_amount_eur = requested_amount_eur, updated_at = now() WHERE id = $2`,
      [JSON.stringify(lines), id]
    );
    await recordAuditEvent(id, parsed.data.actor, "order_approved", [`Hold cleared by ${parsed.data.actor}.`], "aimo-guardrail-v1");

    const updated = await query<any>("SELECT * FROM orders WHERE id = $1", [id]);
    return reply.send(rowToOrder(updated[0]));
  });

  app.get("/v1/audit/:order_id", { preHandler: requireBuyerAuth }, async (request: AuthedRequest, reply) => {
    const { order_id } = request.params as { order_id: string };
    const owned = await query<any>("SELECT id FROM orders WHERE id = $1 AND buyer_id = $2", [order_id, request.buyerId]);
    if (!owned[0]) return reply.code(404).send({ error: "not_found" });
    const trail = await getAuditTrail(order_id);
    return reply.send({ order_id, events: trail });
  });
}
