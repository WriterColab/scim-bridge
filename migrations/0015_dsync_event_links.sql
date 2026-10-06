-- Preserve authenticated event ownership after SCIM/native resource deletion.
-- Each id has one immutable owner within its directory and resource type.
CREATE TABLE dsync_event_links (
  directory_id TEXT NOT NULL REFERENCES scim_directories(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('Users', 'Groups')),
  dsync_id TEXT NOT NULL,
  native_id TEXT NOT NULL,
  workos_id TEXT NOT NULL,
  PRIMARY KEY (directory_id, resource_type, dsync_id),
  UNIQUE (directory_id, resource_type, native_id),
  UNIQUE (directory_id, resource_type, workos_id)
);
