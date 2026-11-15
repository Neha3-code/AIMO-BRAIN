import { z } from "zod";
import { ORG_ROLES } from "@aimo/shared";

const text = (max: number) => z.string().trim().min(1).max(max);

export const SignupSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(10, "Password must be at least 10 characters.").max(200),
    display_name: text(100)
  })
  .strict();

export const LoginSchema = z.object({ email: z.string().trim().toLowerCase().max(254), password: z.string().max(200) }).strict();

export const CreateOrgSchema = z.object({ type: z.enum(["buyer", "supplier"]), legal_name: text(200), display_name: text(100) }).strict();

const Location = z
  .object({
    label: text(100),
    address_line: text(200),
    postal_code: text(20),
    city: text(100),
    country: z.string().regex(/^[A-Z]{2}$/, "Use an ISO 3166-1 alpha-2 country code, e.g. FI."),
    notes: z.string().trim().max(500).optional()
  })
  .strict();

const ApprovalContact = z.object({ name: text(100), email: z.string().trim().toLowerCase().email().max(254) }).strict();

const commonProfile = {
  business_id: z.string().trim().max(50).optional(),
  contact_email: z.string().trim().toLowerCase().email().max(254).optional(),
  approval_contacts: z.array(ApprovalContact).max(20).optional()
};

// .strict(): a buyer organization cannot smuggle supplier-only fields into its profile, or the
// other way round.
export const ProfileSchemas = {
  buyer: z.object({ ...commonProfile, delivery_locations: z.array(Location).max(50).optional() }).strict(),
  supplier: z.object({ ...commonProfile, service_regions: z.array(text(100)).max(100).optional(), fulfilment_locations: z.array(Location).max(50).optional() }).strict()
};

export const UpdateOrgSchema = z.object({ display_name: text(100).optional(), legal_name: text(200).optional(), profile: z.unknown().optional() }).strict();

export const RoleSchema = z.enum(ORG_ROLES);
export const InviteSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254), role: RoleSchema }).strict();
export const ChangeRoleSchema = z.object({ role: RoleSchema }).strict();
export const AcceptInviteSchema = z.object({ token: z.string().min(20).max(200) }).strict();

const grams = z.number().min(0).max(100);

export const PolicyRulesSchemas = {
  buyer: z
    .object({
      banned_allergen_codes: z.array(z.string().regex(/^[A-Z0-9]{1,8}$/, "Allergen codes are short upper-case GS1 codes, e.g. AW.")).max(100),
      max_budget_eur: z.number().min(0).max(10_000_000).nullable(),
      max_delivery_deviation_days: z.number().int().min(0).max(30),
      min_delivery_reliability: z.number().min(0).max(1),
      max_substitute_carbon_increase_pct: z.number().min(0).max(1000),
      recipe_tolerance: z
        .object({
          absolute: z.object({ fat_g: grams, protein_g: grams, carbohydrate_g: grams, sugar_g: grams, salt_g: grams }).strict(),
          relative: z.number().min(0).max(1)
        })
        .strict()
    })
    .strict(),
  supplier: z
    .object({
      default_credit_limit_eur: z.number().min(0).max(100_000_000),
      auto_approve_limit_eur: z.number().min(0).max(100_000_000)
    })
    .strict()
};

export const CreatePolicyVersionSchema = z
  .object({
    /** Optional and never trusted: the side is the owning organization's type. Sending the other
     *  side is rejected explicitly instead of being silently ignored. */
    side: z.enum(["buyer", "supplier"]).optional(),
    rules: z.unknown(),
    effective_from: z.string().datetime({ offset: true }).optional(),
    change_note: z.string().trim().max(500).optional()
  })
  .strict();

export function issues(error: z.ZodError) {
  return error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}
