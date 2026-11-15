-- Phase 1 tenancy: users, sessions, organizations, memberships, member invitations,
-- trading relationships, versioned tenant-owned policies and a tenant-scoped audit log.
--
-- Additive only: no existing table is altered, so the Junction26 demo flow is unaffected.
-- Every statement is idempotent because the Neon HTTP driver runs one statement per request
-- and cannot wrap a migration file in a transaction. Do not use semicolons inside a statement.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('buyer', 'supplier')),
  status TEXT NOT NULL DEFAULT 'onboarding' CHECK (status IN ('onboarding', 'active', 'suspended')),
  legal_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  profile JSONB NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  org_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('org_owner', 'org_admin', 'buyer_purchaser', 'buyer_approver', 'supplier_sales', 'supplier_approver', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_user_id ON memberships (user_id);

CREATE TABLE IF NOT EXISTS org_invitations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('org_owner', 'org_admin', 'buyer_purchaser', 'buyer_approver', 'supplier_sales', 'supplier_approver', 'viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  invited_by TEXT NOT NULL REFERENCES users(id),
  accepted_by TEXT REFERENCES users(id),
  accepted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_org_invitations_org_id ON org_invitations (org_id);

-- Schema only in this slice: no endpoint reads or writes trading relationships yet.
CREATE TABLE IF NOT EXISTS trading_relationships (
  id TEXT PRIMARY KEY,
  buyer_org_id TEXT NOT NULL REFERENCES organizations(id),
  supplier_org_id TEXT NOT NULL REFERENCES organizations(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'revoked')),
  initiated_by_org_id TEXT NOT NULL REFERENCES organizations(id),
  supplier_account_ref TEXT,
  access_scope JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (buyer_org_id, supplier_org_id),
  CHECK (buyer_org_id <> supplier_org_id)
);

CREATE INDEX IF NOT EXISTS idx_trading_relationships_supplier ON trading_relationships (supplier_org_id);

-- One row per immutable policy version. `side` is denormalized from the owning organization's
-- type so a decision record can cite (org_id, version) and know whose rules they were.
CREATE TABLE IF NOT EXISTS policy_versions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  side TEXT NOT NULL CHECK (side IN ('buyer', 'supplier')),
  version INTEGER NOT NULL CHECK (version > 0),
  rules JSONB NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  change_note TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, version)
);

CREATE TABLE IF NOT EXISTS org_audit_events (
  id BIGSERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  actor_user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  detail JSONB NOT NULL DEFAULT '{}',
  correlation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_org_audit_events_org_id ON org_audit_events (org_id, id);

-- Defense in depth for "append-only at the application level": UPDATE and DELETE on these two
-- tables are rewritten to nothing. A database owner can still drop the rules, so this is not
-- tamper-proof and must not be described as such.
CREATE OR REPLACE RULE policy_versions_no_update AS ON UPDATE TO policy_versions DO INSTEAD NOTHING;

CREATE OR REPLACE RULE policy_versions_no_delete AS ON DELETE TO policy_versions DO INSTEAD NOTHING;

CREATE OR REPLACE RULE org_audit_events_no_update AS ON UPDATE TO org_audit_events DO INSTEAD NOTHING;

CREATE OR REPLACE RULE org_audit_events_no_delete AS ON DELETE TO org_audit_events DO INSTEAD NOTHING;
