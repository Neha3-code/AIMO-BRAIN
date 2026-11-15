"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  PRIVILEGED_ROLES,
  ROLES_BY_ORG_TYPE,
  roleHasPermission,
  type BuyerOrgProfile,
  type BuyerPolicyRules,
  type OnboardingChecklist,
  type OrgAuditEvent,
  type OrgInvitation,
  type OrgMember,
  type OrgRole,
  type OrgType,
  type OrganizationMembershipView,
  type PlatformUser,
  type PolicyVersion,
  type PostalLocation,
  type SupplierOrgProfile,
  type SupplierPolicyRules
} from "@aimo/shared";

// The UI only hides what the server would refuse anyway: every rule shown here is enforced by
// aimo-api (authentication, tenant membership, role permissions, policy side).

class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api/platform/${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined
  });
  if (res.status === 204) return null as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = Array.isArray(data?.details) ? ` ${data.details.map((d: any) => `${d.path ? d.path + ": " : ""}${d.message}`).join(" ")}` : "";
    throw new ApiError(res.status, data?.error ?? "error", `${data?.message ?? data?.error ?? "Request failed."}${detail}`);
  }
  return data as T;
}

type OrgDetail = OrganizationMembershipView & { onboarding: OnboardingChecklist };

const ROLE_LABELS: Record<OrgRole, string> = {
  org_owner: "Owner",
  org_admin: "Admin",
  buyer_purchaser: "Purchaser",
  buyer_approver: "Buyer approver",
  supplier_sales: "Sales",
  supplier_approver: "Supplier approver",
  viewer: "Viewer"
};

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="ws-field">
      <span className="ws-label">{label}</span>
      {children}
      {hint && <span className="ws-hint">{hint}</span>}
    </label>
  );
}

function Notice({ kind, children }: { kind: "error" | "ok" | "info"; children: ReactNode }) {
  return (
    <div className={`ws-notice ws-notice-${kind}`} role={kind === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

/** Runs an async action with busy and error state, so no form can swallow a failure. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}

// ---------------------------------------------------------------------------
// Sign in / sign up
// ---------------------------------------------------------------------------

function AuthPanel({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const { busy, error, run } = useAction();

  function submit(e: FormEvent) {
    e.preventDefault();
    run(async () => {
      await api(mode === "login" ? "auth/login" : "auth/signup", {
        method: "POST",
        body: mode === "login" ? { email, password } : { email, password, display_name: name }
      });
      onSignedIn();
    });
  }

  return (
    <div className="ws-card ws-narrow">
      <div className="ws-tabs" role="tablist">
        <button role="tab" aria-selected={mode === "login"} className={mode === "login" ? "ws-tab ws-tab-active" : "ws-tab"} onClick={() => setMode("login")}>
          Sign in
        </button>
        <button role="tab" aria-selected={mode === "signup"} className={mode === "signup" ? "ws-tab ws-tab-active" : "ws-tab"} onClick={() => setMode("signup")}>
          Create account
        </button>
      </div>
      <form onSubmit={submit} className="ws-form">
        {mode === "signup" && (
          <Field label="Your name">
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoComplete="name" />
          </Field>
        )}
        <Field label="Work email">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </Field>
        <Field label="Password" hint={mode === "signup" ? "At least 10 characters." : undefined}>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={mode === "signup" ? 10 : undefined}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
        </Field>
        {error && <Notice kind="error">{error}</Notice>}
        <button className="btn btn-petrol" disabled={busy}>
          {busy ? "Working…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
      </form>
      <p className="ws-hint">Sandbox accounts: there is no email verification, password reset or MFA yet. Do not reuse a real password.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create or join an organization
// ---------------------------------------------------------------------------

function CreateOrJoin({ onDone }: { onDone: (orgId: string) => void }) {
  const [type, setType] = useState<OrgType | null>(null);
  const [legalName, setLegalName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [token, setToken] = useState("");
  const create = useAction();
  const join = useAction();

  return (
    <div className="ws-grid-2">
      <div className="ws-card">
        <h2 className="ws-h2">Register an organization</h2>
        <p className="ws-muted">An organization is one side of a trade and owns its own rules. Choose which side this one is — it cannot be changed later.</p>
        <div className="ws-side-picker" role="radiogroup" aria-label="Organization type">
          {(
            [
              ["buyer", "Buyer", "Restaurant, hotel or caterer. Owns purchasing rules: allergens, budget, delivery tolerance, substitutes."],
              ["supplier", "Supplier", "Wholesaler or distributor. Owns commercial rules: credit limits and auto-approval ceilings."]
            ] as const
          ).map(([value, title, text]) => (
            <button key={value} type="button" role="radio" aria-checked={type === value} className={type === value ? "ws-side ws-side-active" : "ws-side"} onClick={() => setType(value)}>
              <strong>{title}</strong>
              <span>{text}</span>
            </button>
          ))}
        </div>
        <form
          className="ws-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!type) return;
            create.run(async () => {
              const org = await api<OrganizationMembershipView>("organizations", { method: "POST", body: { type, legal_name: legalName, display_name: displayName } });
              onDone(org.id);
            });
          }}
        >
          <Field label="Legal name">
            <input value={legalName} onChange={(e) => setLegalName(e.target.value)} required maxLength={200} />
          </Field>
          <Field label="Display name">
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={100} />
          </Field>
          {create.error && <Notice kind="error">{create.error}</Notice>}
          <button className="btn btn-petrol" disabled={!type || create.busy}>
            {create.busy ? "Creating…" : type ? `Create ${type} organization` : "Choose a side first"}
          </button>
        </form>
      </div>

      <div className="ws-card">
        <h2 className="ws-h2">Join with an invitation</h2>
        <p className="ws-muted">Paste the invitation token an owner or admin gave you. It only works while you are signed in with the email it was issued to.</p>
        <form
          className="ws-form"
          onSubmit={(e) => {
            e.preventDefault();
            join.run(async () => {
              const res = await api<{ org_id: string }>("invitations/accept", { method: "POST", body: { token: token.trim() } });
              onDone(res.org_id);
            });
          }}
        >
          <Field label="Invitation token">
            <input value={token} onChange={(e) => setToken(e.target.value)} required autoComplete="off" />
          </Field>
          {join.error && <Notice kind="error">{join.error}</Notice>}
          <button className="btn btn-petrol" disabled={join.busy}>
            {join.busy ? "Joining…" : "Join organization"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Onboarding (buyer and supplier screens differ)
// ---------------------------------------------------------------------------

const EMPTY_LOCATION: PostalLocation = { label: "", address_line: "", postal_code: "", city: "", country: "FI" };

function LocationsEditor({ title, hint, value, onChange, disabled }: { title: string; hint: string; value: PostalLocation[]; onChange: (v: PostalLocation[]) => void; disabled: boolean }) {
  const [draft, setDraft] = useState<PostalLocation>(EMPTY_LOCATION);
  const set = (k: keyof PostalLocation, v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const complete = draft.label && draft.address_line && draft.postal_code && draft.city && /^[A-Za-z]{2}$/.test(draft.country);
  return (
    <fieldset className="ws-fieldset">
      <legend>{title}</legend>
      <p className="ws-hint">{hint}</p>
      {value.length === 0 && <p className="ws-muted">None added yet.</p>}
      <ul className="ws-list">
        {value.map((l, i) => (
          <li key={i}>
            <span>
              <strong>{l.label}</strong> — {l.address_line}, {l.postal_code} {l.city}, {l.country}
            </span>
            {!disabled && (
              <button type="button" className="ws-link" onClick={() => onChange(value.filter((_, j) => j !== i))}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {!disabled && (
        <div className="ws-inline">
          <input placeholder="Label (e.g. Main kitchen)" value={draft.label} onChange={(e) => set("label", e.target.value)} />
          <input placeholder="Street address" value={draft.address_line} onChange={(e) => set("address_line", e.target.value)} />
          <input placeholder="Postal code" value={draft.postal_code} onChange={(e) => set("postal_code", e.target.value)} />
          <input placeholder="City" value={draft.city} onChange={(e) => set("city", e.target.value)} />
          <input placeholder="Country (FI)" value={draft.country} maxLength={2} onChange={(e) => set("country", e.target.value.toUpperCase())} />
          <button
            type="button"
            className="ws-btn-small"
            disabled={!complete}
            onClick={() => {
              onChange([...value, draft]);
              setDraft(EMPTY_LOCATION);
            }}
          >
            Add location
          </button>
        </div>
      )}
    </fieldset>
  );
}

function Onboarding({ org, canEdit, onChanged }: { org: OrgDetail; canEdit: boolean; onChanged: () => void }) {
  const isBuyer = org.type === "buyer";
  const initial = org.profile as BuyerOrgProfile & SupplierOrgProfile;
  const [businessId, setBusinessId] = useState(initial.business_id ?? "");
  const [contactEmail, setContactEmail] = useState(initial.contact_email ?? "");
  const [locations, setLocations] = useState<PostalLocation[]>((isBuyer ? initial.delivery_locations : initial.fulfilment_locations) ?? []);
  const [regions, setRegions] = useState((initial.service_regions ?? []).join(", "));
  const [approverName, setApproverName] = useState(initial.approval_contacts?.[0]?.name ?? "");
  const [approverEmail, setApproverEmail] = useState(initial.approval_contacts?.[0]?.email ?? "");
  const [saved, setSaved] = useState(false);
  const save = useAction();
  const complete = useAction();

  function submit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    save.run(async () => {
      const profile: Record<string, unknown> = {
        ...(businessId.trim() ? { business_id: businessId.trim() } : {}),
        ...(contactEmail.trim() ? { contact_email: contactEmail.trim() } : {}),
        ...(approverName.trim() && approverEmail.trim() ? { approval_contacts: [{ name: approverName.trim(), email: approverEmail.trim() }] } : {})
      };
      if (isBuyer) profile.delivery_locations = locations;
      else {
        profile.fulfilment_locations = locations;
        profile.service_regions = regions.split(",").map((r) => r.trim()).filter(Boolean);
      }
      await api(`organizations/${org.id}`, { method: "PATCH", body: { profile } });
      setSaved(true);
      onChanged();
    });
  }

  const steps: [string, boolean][] = [
    [isBuyer ? "At least one delivery location" : "A service region and a fulfilment location", org.onboarding.profile_complete],
    [isBuyer ? "A buyer policy version (Policy tab)" : "A supplier policy version (Policy tab)", org.onboarding.policy_configured]
  ];

  return (
    <div className="ws-stack">
      <div className="ws-card">
        <h2 className="ws-h2">{isBuyer ? "Buyer onboarding" : "Supplier onboarding"}</h2>
        <ul className="ws-checklist">
          {steps.map(([text, done]) => (
            <li key={text}>
              <span className={`pill ${done ? "pill-passed" : "pill-pending"}`}>{done ? "Done" : "To do"}</span> {text}
            </li>
          ))}
        </ul>
        {org.status === "onboarding" && canEdit && (
          <>
            {complete.error && <Notice kind="error">{complete.error}</Notice>}
            <button
              className="btn btn-lime"
              disabled={complete.busy || !steps.every(([, done]) => done)}
              onClick={() =>
                complete.run(async () => {
                  await api(`organizations/${org.id}/onboarding/complete`, { method: "POST" });
                  onChanged();
                })
              }
            >
              Complete onboarding
            </button>
          </>
        )}
        {org.status === "active" && <Notice kind="ok">Onboarding complete. Connecting to trading partners is the next platform milestone and is not available yet.</Notice>}
      </div>

      <form className="ws-card ws-form" onSubmit={submit}>
        <h2 className="ws-h2">{isBuyer ? "Business profile" : "Company profile"}</h2>
        <fieldset disabled={!canEdit} className="ws-plain">
          <div className="ws-grid-2">
            <Field label="Business ID" hint="Optional. Not verified by the platform.">
              <input value={businessId} onChange={(e) => setBusinessId(e.target.value)} maxLength={50} />
            </Field>
            <Field label="Contact email">
              <input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
            </Field>
          </div>
          {!isBuyer && (
            <Field label="Service regions" hint="Comma-separated, e.g. Uusimaa, Pirkanmaa.">
              <input value={regions} onChange={(e) => setRegions(e.target.value)} />
            </Field>
          )}
          <LocationsEditor
            title={isBuyer ? "Purchasing and delivery locations" : "Fulfilment locations"}
            hint={isBuyer ? "Where your orders are delivered." : "Where you ship from."}
            value={locations}
            onChange={setLocations}
            disabled={!canEdit}
          />
          <div className="ws-grid-2">
            <Field label={isBuyer ? "Buyer approval contact" : "Supplier approval contact"} hint="Who reviews holds your own policy raises.">
              <input placeholder="Name" value={approverName} onChange={(e) => setApproverName(e.target.value)} />
            </Field>
            <Field label="Approval contact email">
              <input type="email" value={approverEmail} onChange={(e) => setApproverEmail(e.target.value)} />
            </Field>
          </div>
        </fieldset>
        {!isBuyer && <Notice kind="info">Catalogue connector settings are not available yet. No supplier catalogue, pricing or stock can be connected in this build.</Notice>}
        {save.error && <Notice kind="error">{save.error}</Notice>}
        {saved && <Notice kind="ok">Profile saved.</Notice>}
        {canEdit ? (
          <button className="btn btn-petrol" disabled={save.busy}>
            {save.busy ? "Saving…" : "Save profile"}
          </button>
        ) : (
          <p className="ws-muted">Your role can view this profile but not change it.</p>
        )}
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Policy (the organization's own side only)
// ---------------------------------------------------------------------------

// Starting values for a first version. Examples carried over from the demo kitchen, not advice.
const EXAMPLE_BUYER_RULES: BuyerPolicyRules = {
  banned_allergen_codes: [],
  max_budget_eur: null,
  max_delivery_deviation_days: 1,
  min_delivery_reliability: 0.95,
  max_substitute_carbon_increase_pct: 20,
  recipe_tolerance: { absolute: { fat_g: 2, protein_g: 1.5, carbohydrate_g: 2.5, sugar_g: 2.5, salt_g: 0.3 }, relative: 0.1 }
};

const TOLERANCE_KEYS = ["fat_g", "protein_g", "carbohydrate_g", "sugar_g", "salt_g"] as const;

function NumberInput({ value, onChange, step = "any", min = 0, max }: { value: string; onChange: (v: string) => void; step?: string; min?: number; max?: number }) {
  return <input type="number" inputMode="decimal" value={value} step={step} min={min} max={max} onChange={(e) => onChange(e.target.value)} required />;
}

function BuyerRulesForm({ start, onSubmit, busy }: { start: BuyerPolicyRules; onSubmit: (rules: BuyerPolicyRules, note: string) => void; busy: boolean }) {
  const [codes, setCodes] = useState(start.banned_allergen_codes.join(", "));
  const [budget, setBudget] = useState(start.max_budget_eur === null ? "" : String(start.max_budget_eur));
  const [days, setDays] = useState(String(start.max_delivery_deviation_days));
  const [reliability, setReliability] = useState(String(Math.round(start.min_delivery_reliability * 1000) / 10));
  const [carbon, setCarbon] = useState(String(start.max_substitute_carbon_increase_pct));
  const [tol, setTol] = useState<Record<string, string>>(Object.fromEntries(TOLERANCE_KEYS.map((k) => [k, String(start.recipe_tolerance.absolute[k])])));
  const [relative, setRelative] = useState(String(Math.round(start.recipe_tolerance.relative * 1000) / 10));
  const [note, setNote] = useState("");

  return (
    <form
      className="ws-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(
          {
            banned_allergen_codes: codes.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean),
            max_budget_eur: budget.trim() === "" ? null : Number(budget),
            max_delivery_deviation_days: Number(days),
            min_delivery_reliability: Number(reliability) / 100,
            max_substitute_carbon_increase_pct: Number(carbon),
            recipe_tolerance: {
              absolute: Object.fromEntries(TOLERANCE_KEYS.map((k) => [k, Number(tol[k])])) as BuyerPolicyRules["recipe_tolerance"]["absolute"],
              relative: Number(relative) / 100
            }
          },
          note
        );
      }}
    >
      <Field label="Banned allergen codes" hint="GS1 codes, comma-separated (e.g. AW). Your own kitchen decides what each code means.">
        <input value={codes} onChange={(e) => setCodes(e.target.value)} />
      </Field>
      <div className="ws-grid-2">
        <Field label="Maximum order budget (€)" hint="Leave empty for no buyer-side cap.">
          <input type="number" min={0} step="any" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </Field>
        <Field label="Delivery lateness tolerated (days)">
          <NumberInput value={days} onChange={setDays} step="1" max={30} />
        </Field>
        <Field label="Minimum delivery reliability for auto-picked substitutes (%)">
          <NumberInput value={reliability} onChange={setReliability} max={100} />
        </Field>
        <Field label="Maximum carbon increase for a substitute (%)">
          <NumberInput value={carbon} onChange={setCarbon} max={1000} />
        </Field>
      </div>
      <fieldset className="ws-fieldset">
        <legend>Recipe tolerance for substitutes (g per 100 g)</legend>
        <div className="ws-grid-5">
          {TOLERANCE_KEYS.map((k) => (
            <Field key={k} label={k.replace("_g", "").replace(/^./, (c) => c.toUpperCase())}>
              <NumberInput value={tol[k]} onChange={(v) => setTol((t) => ({ ...t, [k]: v }))} max={100} />
            </Field>
          ))}
        </div>
        <Field label="…or this share of the original value, whichever is larger (%)">
          <NumberInput value={relative} onChange={setRelative} max={100} />
        </Field>
      </fieldset>
      <Field label="Change note" hint="Optional. Stored with the version.">
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </Field>
      <button className="btn btn-petrol" disabled={busy}>
        {busy ? "Saving…" : "Save as new version"}
      </button>
    </form>
  );
}

function SupplierRulesForm({ start, onSubmit, busy }: { start: SupplierPolicyRules | null; onSubmit: (rules: SupplierPolicyRules, note: string) => void; busy: boolean }) {
  const [credit, setCredit] = useState(start ? String(start.default_credit_limit_eur) : "");
  const [auto, setAuto] = useState(start ? String(start.auto_approve_limit_eur) : "");
  const [note, setNote] = useState("");
  return (
    <form
      className="ws-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ default_credit_limit_eur: Number(credit), auto_approve_limit_eur: Number(auto) }, note);
      }}
    >
      <div className="ws-grid-2">
        <Field label="Default credit limit per buyer (€)" hint="Orders above this are held for supplier review.">
          <NumberInput value={credit} onChange={setCredit} />
        </Field>
        <Field label="Auto-approval ceiling (€)" hint="Orders above this are held for supplier review.">
          <NumberInput value={auto} onChange={setAuto} />
        </Field>
      </div>
      <Field label="Change note" hint="Optional. Stored with the version.">
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </Field>
      <button className="btn btn-petrol" disabled={busy}>
        {busy ? "Saving…" : "Save as new version"}
      </button>
    </form>
  );
}

function Policy({ org, canWrite, onChanged }: { org: OrgDetail; canWrite: boolean; onChanged: () => void }) {
  const [versions, setVersions] = useState<PolicyVersion[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const save = useAction();
  const load = useCallback(() => {
    api<{ versions: PolicyVersion[] }>(`organizations/${org.id}/policy-versions`)
      .then((r) => setVersions(r.versions))
      .catch((e) => setLoadError(e.message));
  }, [org.id]);
  useEffect(load, [load]);

  const submit = (rules: BuyerPolicyRules | SupplierPolicyRules, note: string) =>
    save.run(async () => {
      await api(`organizations/${org.id}/policy-versions`, { method: "POST", body: { rules, ...(note.trim() ? { change_note: note.trim() } : {}) } });
      load();
      onChanged();
    });

  if (loadError) return <Notice kind="error">{loadError}</Notice>;
  if (!versions) return <p className="ws-muted">Loading policy…</p>;
  const latest = versions[0] ?? null;
  const other = org.type === "buyer" ? "supplier" : "buyer";

  return (
    <div className="ws-stack">
      <Notice kind="info">
        <strong>Recorded, not yet enforced.</strong> These rules are stored as your organization&apos;s own versioned policy. No quote or order reads them yet: the sandbox demo still runs on its built-in demo policy
        until the trade workflow is connected to organizations.
      </Notice>
      <div className="ws-card">
        <h2 className="ws-h2">{org.type === "buyer" ? "Buyer policy" : "Supplier policy"}</h2>
        <p className="ws-muted">
          Only {org.display_name}&apos;s owners and admins can change these rules. A {other} organization can never read or edit them, and you cannot see or edit a {other}&apos;s rules. Saving creates a new
          immutable version; earlier versions are kept.
        </p>
        {save.error && <Notice kind="error">{save.error}</Notice>}
        {canWrite ? (
          org.type === "buyer" ? (
            <BuyerRulesForm key={latest?.id ?? "new"} start={(latest?.rules as BuyerPolicyRules) ?? EXAMPLE_BUYER_RULES} onSubmit={submit} busy={save.busy} />
          ) : (
            <SupplierRulesForm key={latest?.id ?? "new"} start={(latest?.rules as SupplierPolicyRules) ?? null} onSubmit={submit} busy={save.busy} />
          )
        ) : (
          <p className="ws-muted">Your role can view this policy but not change it.</p>
        )}
        {canWrite && !latest && org.type === "buyer" && <p className="ws-hint">The starting values are examples from the demo kitchen, not recommendations. Review each one before saving.</p>}
      </div>
      <div className="ws-card">
        <h2 className="ws-h2">Version history</h2>
        {versions.length === 0 ? (
          <p className="ws-muted">No policy has been saved yet.</p>
        ) : (
          <div className="ws-table-wrap">
            <table className="ws-table">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Effective from</th>
                  <th>Note</th>
                  <th>Rules</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.id}>
                    <td>v{v.version}</td>
                    <td>{new Date(v.effective_from).toLocaleString()}</td>
                    <td>{v.change_note ?? "—"}</td>
                    <td>
                      <details>
                        <summary>Show</summary>
                        <pre className="ws-pre">{JSON.stringify(v.rules, null, 2)}</pre>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Members and invitations
// ---------------------------------------------------------------------------

function Members({ org, me }: { org: OrgDetail; me: PlatformUser }) {
  const canManage = roleHasPermission(org.my_role, "members:manage");
  const isOwner = org.my_role === "org_owner";
  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [invitations, setInvitations] = useState<OrgInvitation[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>("viewer");
  const [issued, setIssued] = useState<{ email: string; token: string } | null>(null);
  const action = useAction();

  const assignable = ROLES_BY_ORG_TYPE[org.type].filter((r) => isOwner || !PRIVILEGED_ROLES.includes(r));

  const load = useCallback(() => {
    action.run(async () => {
      setMembers((await api<{ members: OrgMember[] }>(`organizations/${org.id}/members`)).members);
      if (canManage) setInvitations((await api<{ invitations: OrgInvitation[] }>(`organizations/${org.id}/invitations`)).invitations);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org.id, canManage]);
  useEffect(load, [load]);

  const mutate = (fn: () => Promise<unknown>) =>
    action.run(async () => {
      await fn();
      load();
    });

  return (
    <div className="ws-stack">
      {action.error && <Notice kind="error">{action.error}</Notice>}
      <div className="ws-card">
        <h2 className="ws-h2">Members</h2>
        {!members ? (
          <p className="ws-muted">Loading members…</p>
        ) : (
          <div className="ws-table-wrap">
            <table className="ws-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  {canManage && <th />}
                </tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const editable = canManage && (isOwner || !PRIVILEGED_ROLES.includes(m.role));
                  return (
                    <tr key={m.user_id}>
                      <td>
                        {m.display_name} {m.user_id === me.id && <span className="ws-muted">(you)</span>}
                      </td>
                      <td>{m.email}</td>
                      <td>
                        {editable ? (
                          <select
                            aria-label={`Role for ${m.display_name}`}
                            value={m.role}
                            disabled={action.busy}
                            onChange={(e) => mutate(() => api(`organizations/${org.id}/members/${m.user_id}`, { method: "PATCH", body: { role: e.target.value } }))}
                          >
                            {assignable.map((r) => (
                              <option key={r} value={r}>
                                {ROLE_LABELS[r]}
                              </option>
                            ))}
                          </select>
                        ) : (
                          ROLE_LABELS[m.role]
                        )}
                      </td>
                      {canManage && (
                        <td>
                          {editable && m.user_id !== me.id && (
                            <button
                              className="ws-link"
                              disabled={action.busy}
                              onClick={() => {
                                if (window.confirm(`Remove ${m.display_name} from ${org.display_name}? They lose access immediately.`)) {
                                  mutate(() => api(`organizations/${org.id}/members/${m.user_id}`, { method: "DELETE" }));
                                }
                              }}
                            >
                              Remove
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {canManage && (
        <div className="ws-card">
          <h2 className="ws-h2">Invite a colleague</h2>
          <form
            className="ws-inline"
            onSubmit={(e) => {
              e.preventDefault();
              setIssued(null);
              mutate(async () => {
                const res = await api<{ accept_token: string }>(`organizations/${org.id}/invitations`, { method: "POST", body: { email, role } });
                setIssued({ email, token: res.accept_token });
                setEmail("");
              });
            }}
          >
            <input type="email" placeholder="colleague@company.com" aria-label="Email to invite" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as OrgRole)}>
              {assignable.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
            <button className="ws-btn-small" disabled={action.busy}>
              Create invitation
            </button>
          </form>
          {issued && (
            <Notice kind="ok">
              Invitation created for {issued.email}. Email delivery is not built yet, so send them this token yourself. It is shown only once and expires in 7 days:
              <pre className="ws-pre ws-token">{issued.token}</pre>
            </Notice>
          )}
          {invitations.filter((i) => i.status === "pending").length > 0 && (
            <ul className="ws-list">
              {invitations
                .filter((i) => i.status === "pending")
                .map((i) => (
                  <li key={i.id}>
                    <span>
                      {i.email} — {ROLE_LABELS[i.role]}, expires {new Date(i.expires_at).toLocaleDateString()}
                    </span>
                    <button className="ws-link" disabled={action.busy} onClick={() => mutate(() => api(`organizations/${org.id}/invitations/${i.id}`, { method: "DELETE" }))}>
                      Revoke
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Audit({ org }: { org: OrgDetail }) {
  const [events, setEvents] = useState<OrgAuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ events: OrgAuditEvent[] }>(`organizations/${org.id}/audit-events?limit=100`)
      .then((r) => setEvents(r.events))
      .catch((e) => setError(e.message));
  }, [org.id]);
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!events) return <p className="ws-muted">Loading audit log…</p>;
  return (
    <div className="ws-card">
      <h2 className="ws-h2">Organization audit log</h2>
      <p className="ws-muted">Administrative changes inside {org.display_name} only. Append-only at the application level; not cryptographically verified.</p>
      <div className="ws-table-wrap">
        <table className="ws-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Actor</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td>{new Date(e.created_at).toLocaleString()}</td>
                <td>
                  <code>{e.action}</code>
                </td>
                <td>
                  <code>{e.actor_user_id ?? "—"}</code>
                </td>
                <td>
                  <code>{JSON.stringify(e.detail)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

type Tab = "onboarding" | "policy" | "members" | "audit";

function OrgWorkspace({ orgId, me, onOrgChanged }: { orgId: string; me: PlatformUser; onOrgChanged: () => void }) {
  const [org, setOrg] = useState<OrgDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("onboarding");
  const load = useCallback(() => {
    api<OrgDetail>(`organizations/${orgId}`)
      .then(setOrg)
      .catch((e) => setError(e.message));
  }, [orgId]);
  useEffect(() => {
    setOrg(null);
    setError(null);
    load();
  }, [load]);

  if (error) return <Notice kind="error">{error}</Notice>;
  if (!org) return <p className="ws-muted">Loading organization…</p>;

  const tabs: [Tab, string][] = [
    ["onboarding", "Onboarding"],
    ["policy", "Policy"],
    ["members", "Members"]
  ];
  if (roleHasPermission(org.my_role, "audit:read")) tabs.push(["audit", "Audit"]);
  const changed = () => {
    load();
    onOrgChanged();
  };

  return (
    <div className="ws-stack">
      <div className="ws-org-head">
        <div>
          <h1 className="ws-h1">{org.display_name}</h1>
          <p className="ws-muted">{org.legal_name}</p>
        </div>
        <div className="ws-pills">
          <span className="pill pill-info">{org.type === "buyer" ? "Buyer organization" : "Supplier organization"}</span>
          <span className={`pill ${org.status === "active" ? "pill-passed" : "pill-pending"}`}>{org.status}</span>
          <span className="pill pill-info">Your role: {ROLE_LABELS[org.my_role]}</span>
        </div>
      </div>
      <div className="ws-tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "ws-tab ws-tab-active" : "ws-tab"} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "onboarding" && <Onboarding key={org.id} org={org} canEdit={roleHasPermission(org.my_role, "org:update")} onChanged={changed} />}
      {tab === "policy" && <Policy org={org} canWrite={roleHasPermission(org.my_role, "policy:write")} onChanged={changed} />}
      {tab === "members" && <Members org={org} me={me} />}
      {tab === "audit" && <Audit org={org} />}
    </div>
  );
}

const NEW_ORG = "__new__";

export default function WorkspaceApp() {
  const [state, setState] = useState<"loading" | "signed_out" | "ready" | "error">("loading");
  const [me, setMe] = useState<PlatformUser | null>(null);
  const [orgs, setOrgs] = useState<OrganizationMembershipView[]>([]);
  const [active, setActive] = useState<string>(NEW_ORG);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (preferOrg?: string) => {
    try {
      const data = await api<{ user: PlatformUser; organizations: OrganizationMembershipView[] }>("me");
      setMe(data.user);
      setOrgs(data.organizations);
      setActive((current) => {
        const wanted = preferOrg ?? (current !== NEW_ORG ? current : new URLSearchParams(window.location.search).get("org"));
        // Only ever select an organization the server says this user belongs to.
        if (wanted && data.organizations.some((o) => o.id === wanted)) return wanted;
        return preferOrg === NEW_ORG ? NEW_ORG : data.organizations[0]?.id ?? NEW_ORG;
      });
      setState("ready");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setState("signed_out");
      else {
        setError((err as Error).message);
        setState("error");
      }
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (state !== "ready") return;
    const url = new URL(window.location.href);
    if (active === NEW_ORG) url.searchParams.delete("org");
    else url.searchParams.set("org", active);
    window.history.replaceState(null, "", url);
  }, [active, state]);

  async function signOut() {
    await api("auth/logout", { method: "POST" }).catch(() => {});
    setMe(null);
    setOrgs([]);
    setActive(NEW_ORG);
    setState("signed_out");
  }

  return (
    <div className="ws">
      <header className="ws-bar">
        <div className="container ws-bar-inner">
          <a href="/" className="ws-brand">
            AIMO BRAIN
          </a>
          <span className="pill pill-pending" title="Nothing here places a real order or reaches a real supplier.">
            Sandbox
          </span>
          <span className="ws-spacer" />
          {state === "ready" && me && (
            <>
              <label className="ws-switch">
                <span className="ws-sr">Organization</span>
                <select value={active} onChange={(e) => setActive(e.target.value)}>
                  {orgs.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.display_name} ({o.type})
                    </option>
                  ))}
                  <option value={NEW_ORG}>+ Create or join…</option>
                </select>
              </label>
              <span className="ws-user">{me.email}</span>
              <button className="ws-link ws-link-light" onClick={signOut}>
                Sign out
              </button>
            </>
          )}
          <a className="ws-link ws-link-light" href="/">
            Demo
          </a>
        </div>
      </header>

      <main className="container ws-main">
        {state === "loading" && <p className="ws-muted">Loading…</p>}
        {state === "error" && <Notice kind="error">{error}</Notice>}
        {state === "signed_out" && (
          <>
            <h1 className="ws-h1">Organization workspace</h1>
            <p className="ws-lede">Register your buyer or supplier organization, invite colleagues and set your own rules. AI proposes the trade; each organization&apos;s own policy decides.</p>
            <AuthPanel onSignedIn={() => refresh()} />
          </>
        )}
        {state === "ready" && me && active === NEW_ORG && (
          <>
            <h1 className="ws-h1">{orgs.length === 0 ? "Set up your first organization" : "Create or join an organization"}</h1>
            <CreateOrJoin onDone={(orgId) => refresh(orgId)} />
          </>
        )}
        {state === "ready" && me && active !== NEW_ORG && <OrgWorkspace key={active} orgId={active} me={me} onOrgChanged={() => refresh()} />}
      </main>
    </div>
  );
}
