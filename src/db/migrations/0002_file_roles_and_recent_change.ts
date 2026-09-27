export const name = 'file_roles_and_recent_change';

/**
 * v2.0: what each file is (ADR-0030), and the recent-change measure hotspots
 * rank by (ADR-0031).
 */
export const up = /* sql */ `
-- One row per tracked file. "rule" is the citation: the rule that assigned the
-- role, e.g. 'name:package-lock.json' or 'header:@generated'; "line" is set
-- only for header rules.
CREATE TABLE file_role (
  id      INTEGER PRIMARY KEY,
  run_id  INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  path    TEXT    NOT NULL,
  role    TEXT    NOT NULL CHECK (role IN (
            'source','test','generated','vendored','lockfile','manifest',
            'migration','config','docs','asset','other')),
  rule    TEXT    NOT NULL,
  line    INTEGER,
  UNIQUE (run_id, path)
);
CREATE INDEX file_role_by_role ON file_role(run_id, role);

-- Non-merge commits in the hotspot window, excluding bulk commits and
-- .git-blame-ignore-revs.
ALTER TABLE file_metric ADD COLUMN recent_commits INTEGER NOT NULL DEFAULT 0;
-- The file's own indent unit, in columns (a tab counts as one unit). Null when
-- the file was not measured or has no indentation.
ALTER TABLE file_metric ADD COLUMN indent_unit INTEGER;

-- How recent_commits was measured, so every view that ranks by it can state
-- the window and what was left out — including when that was everything.
CREATE TABLE history_window (
  run_id            INTEGER PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  window_start      TEXT,                 -- null when the run has no commits
  window_end        TEXT,
  months            INTEGER NOT NULL,
  max_files         INTEGER NOT NULL,
  commits           INTEGER NOT NULL,     -- non-merge commits in the window
  excluded_bulk     INTEGER NOT NULL,
  excluded_ignored  INTEGER NOT NULL
);
`;
