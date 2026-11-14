import type { FastifyRequest, FastifyReply } from "fastify";

// Lightweight API-key -> buyer_id lookup table. Documented production path
// is OAuth2 client-credentials (spec §0) — this is the hackathon stand-in,
// cheap and explicit about what it is.
function loadKeyMap(): Map<string, string> {
  const raw = process.env.AIMO_BUYER_API_KEYS ?? "";
  const map = new Map<string, string>();
  for (const pair of raw.split(",")) {
    const [key, buyerId] = pair.split(":");
    if (key && buyerId) map.set(key.trim(), buyerId.trim());
  }
  return map;
}

const KEY_MAP = loadKeyMap();

export interface AuthedRequest extends FastifyRequest {
  buyerId?: string;
}

export async function requireBuyerAuth(request: AuthedRequest, reply: FastifyReply) {
  const apiKey = request.headers["x-api-key"];
  if (typeof apiKey !== "string" || !KEY_MAP.has(apiKey)) {
    reply.code(401).send({ error: "unauthorized", message: "Missing or invalid X-API-Key" });
    return;
  }
  request.buyerId = KEY_MAP.get(apiKey);
}
