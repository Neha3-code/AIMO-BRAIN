import "dotenv/config";
import { aiSearch, planRecipe, seasonalSuggestions } from "../lib/llmCatalog";

const brief = (r: any) => `${r.envelope.claim.product_id} ${r.name} · ${r.envelope.claim.availability.status} · ${r.envelope.claim.price?.amount ?? "?"}`;
const t0 = Date.now();
const s = await aiSearch("something creamy and lactose-free for a dessert");
console.log("SEARCH", Date.now() - t0, "ms |", s.interpretation, s.queries);
s.results.forEach((r) => console.log("  ", brief(r), "—", r.ai_reason));
const t1 = Date.now();
const z = await seasonalSuggestions();
console.log("SEASONAL", Date.now() - t1, "ms |", z.season);
z.themes.forEach((t) => { console.log(" #", t.title, "—", t.pitch); t.products.forEach((r) => console.log("    ", brief(r))); });
const t2 = Date.now();
const p = await planRecipe("pan-seared seasonal salmon with creamy dill potatoes", 40);
console.log("RECIPE", Date.now() - t2, "ms |", p.summary);
p.lines.forEach((l) => console.log("  ", l.role, l.ingredient, l.quantity_needed, "→", l.product ? brief(l.product) : "NONE", "x", l.order_units, "|", l.note));
