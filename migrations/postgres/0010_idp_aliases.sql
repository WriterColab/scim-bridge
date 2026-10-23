-- Public SCIM ids survive a switch of authoritative upstream. A pending alias
-- is not a native mapping: only a verified callback/reconcile may supply one.
CREATE TABLE idp_aliases (
  directory_id TEXT NOT NULL REFERENCES scim_directories(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('Users', 'Groups')),
  idp_id TEXT NOT NULL,
  workos_id TEXT NOT NULL,
  native_id TEXT,
  external_id TEXT,
  resource_name TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  PRIMARY KEY (directory_id, resource_type, idp_id),
  UNIQUE (directory_id, resource_type, workos_id),
  UNIQUE (directory_id, resource_type, native_id)
);

ALTER TABLE scim_directories ADD COLUMN rollback_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scim_directories ADD COLUMN rollback_verified_revision INTEGER;
