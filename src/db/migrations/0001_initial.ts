export const name = 'initial';

/**
 * Layer 2 (fact store), layer 3 (history) and layer 4 (interpretation) all live
 * in one SQLite file. Facts and interpretation are kept in physically separate
 * tables so that "which of these did a model produce?" is answerable by looking
 * at the table name, not at a flag someone might forget to set.
 */
export const up = /* sql */ `
-- ---------------------------------------------------------------- run metadata

CREATE TABLE run (
  id            INTEGER PRIMARY KEY,
  repo_path     TEXT    NOT NULL,
  repo_head     TEXT,                       -- commit sha of HEAD at analysis time
  tool_version  TEXT    NOT NULL,
  started_at    TEXT    NOT NULL,           -- ISO-8601 UTC
  finished_at   TEXT,
  status        TEXT    NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running','ok','failed'))
);

-- ------------------------------------------------------------ layer 1/2: facts

CREATE TABLE source_file (
  id        INTEGER PRIMARY KEY,
  run_id    INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  path      TEXT    NOT NULL,               -- repo-relative, forward slashes
  language  TEXT    NOT NULL,
  loc       INTEGER,
  sha       TEXT,
  UNIQUE (run_id, path)
);

CREATE TABLE node (
  id          INTEGER PRIMARY KEY,
  run_id      INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL,
  fqn         TEXT    NOT NULL,             -- identity, assigned by the extractor
  name        TEXT    NOT NULL,
  parent_id   INTEGER REFERENCES node(id),
  file_id     INTEGER REFERENCES source_file(id),
  start_line  INTEGER,
  end_line    INTEGER,
  extractor   TEXT,                         -- which extractor observed it
  -- 1 when the row exists only because an edge referenced it and no extractor
  -- ever declared it (e.g. a call into a third-party library).
  is_stub     INTEGER NOT NULL DEFAULT 0 CHECK (is_stub IN (0,1)),
  attrs       TEXT,                         -- JSON object
  UNIQUE (run_id, kind, fqn)
);

CREATE INDEX node_run_kind_idx ON node (run_id, kind);
CREATE INDEX node_parent_idx   ON node (parent_id);
CREATE INDEX node_file_idx     ON node (file_id);

CREATE TABLE edge (
  id          INTEGER PRIMARY KEY,
  run_id      INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL,
  src_id      INTEGER NOT NULL REFERENCES node(id),
  dst_id      INTEGER NOT NULL REFERENCES node(id),
  file_id     INTEGER REFERENCES source_file(id),
  line        INTEGER,
  weight      INTEGER NOT NULL DEFAULT 1,
  confidence  TEXT    NOT NULL DEFAULT 'fact'
                      CHECK (confidence IN ('fact','inferred')),
  extractor   TEXT,
  attrs       TEXT
);

-- The same call site observed twice is one edge with weight 2, not two edges.
-- Expression index rather than a plain UNIQUE because file_id and line are
-- nullable, and SQLite considers every NULL distinct in a UNIQUE constraint —
-- which would let derived edges (no file, no line) accumulate duplicates.
CREATE UNIQUE INDEX edge_identity_idx
  ON edge (run_id, kind, src_id, dst_id, ifnull(file_id, -1), ifnull(line, -1));

CREATE INDEX edge_src_idx ON edge (run_id, src_id, kind);
CREATE INDEX edge_dst_idx ON edge (run_id, dst_id, kind);

CREATE TABLE diagnostic (
  id         INTEGER PRIMARY KEY,
  run_id     INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  extractor  TEXT,
  level      TEXT    NOT NULL CHECK (level IN ('error','warn','info')),
  message    TEXT    NOT NULL,
  file_id    INTEGER REFERENCES source_file(id),
  line       INTEGER
);

-- ---------------------------------------------------------- layer 3: history

CREATE TABLE git_commit (
  id           INTEGER PRIMARY KEY,
  run_id       INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  sha          TEXT    NOT NULL,
  author_name  TEXT,
  author_email TEXT,
  authored_at  TEXT    NOT NULL,            -- ISO-8601 UTC
  subject      TEXT,
  is_merge     INTEGER NOT NULL DEFAULT 0 CHECK (is_merge IN (0,1)),
  UNIQUE (run_id, sha)
);

CREATE TABLE commit_file (
  id            INTEGER PRIMARY KEY,
  run_id        INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  commit_id     INTEGER NOT NULL REFERENCES git_commit(id) ON DELETE CASCADE,
  path          TEXT    NOT NULL,           -- path as of that commit
  canonical_path TEXT   NOT NULL,           -- path after --follow rename tracking
  insertions    INTEGER NOT NULL DEFAULT 0,
  deletions     INTEGER NOT NULL DEFAULT 0,
  change_type   TEXT
);

CREATE INDEX commit_file_commit_idx ON commit_file (commit_id);
CREATE INDEX commit_file_path_idx   ON commit_file (run_id, canonical_path);

-- Derived per-file history metrics. Every column is computed arithmetic over
-- git_commit / commit_file; nothing here is a judgement.
CREATE TABLE file_metric (
  id                  INTEGER PRIMARY KEY,
  run_id              INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  path                TEXT    NOT NULL,
  commits             INTEGER NOT NULL DEFAULT 0,
  churn               INTEGER NOT NULL DEFAULT 0,   -- insertions + deletions
  complexity          REAL,                          -- indentation-based proxy
  authors             INTEGER NOT NULL DEFAULT 0,
  top_author_share    REAL,                          -- 0..1
  first_change_at     TEXT,
  last_change_at      TEXT,
  UNIQUE (run_id, path)
);

-- Pairs of files that change together. "static_edges" is how many layer-2 edges
-- connect the two files; the interesting rows are the ones where it is 0.
CREATE TABLE temporal_coupling (
  id            INTEGER PRIMARY KEY,
  run_id        INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  path_a        TEXT    NOT NULL,
  path_b        TEXT    NOT NULL,
  shared        INTEGER NOT NULL,           -- commits touching both
  commits_a     INTEGER NOT NULL,
  commits_b     INTEGER NOT NULL,
  strength      REAL    NOT NULL,           -- shared / min(commits_a, commits_b)
  static_edges  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (run_id, path_a, path_b)
);

-- ---------------------------------------------------- layer 4: interpretation
-- Everything below this line may be model-authored. Nothing below this line is
-- a fact, and every row must be traceable through "citation" to something above.

CREATE TABLE cluster (
  id            INTEGER PRIMARY KEY,
  run_id        INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  algorithm     TEXT    NOT NULL,           -- e.g. 'louvain'
  label         INTEGER NOT NULL,           -- algorithm-assigned community id
  name          TEXT,                       -- model-authored, nullable under --no-llm
  description   TEXT,                       -- model-authored
  authored_by   TEXT    NOT NULL DEFAULT 'algorithm'
                        CHECK (authored_by IN ('algorithm','model')),
  model         TEXT,                       -- model id, when authored_by='model'
  UNIQUE (run_id, algorithm, label)
);

CREATE TABLE cluster_member (
  cluster_id  INTEGER NOT NULL REFERENCES cluster(id) ON DELETE CASCADE,
  node_id     INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  PRIMARY KEY (cluster_id, node_id)
);

CREATE TABLE finding (
  id            INTEGER PRIMARY KEY,
  run_id        INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  rule          TEXT    NOT NULL,           -- e.g. 'package-cycle', 'intent-mismatch'
  title         TEXT    NOT NULL,
  detail        TEXT,
  severity      TEXT    NOT NULL DEFAULT 'info'
                        CHECK (severity IN ('info','low','medium','high')),
  authored_by   TEXT    NOT NULL DEFAULT 'algorithm'
                        CHECK (authored_by IN ('algorithm','model')),
  model         TEXT,
  cluster_id    INTEGER REFERENCES cluster(id) ON DELETE SET NULL
);

-- The provenance join. A finding with no citations is not publishable; the
-- report layer enforces that, and the LLM layer rejects uncited model output.
CREATE TABLE citation (
  id          INTEGER PRIMARY KEY,
  finding_id  INTEGER NOT NULL REFERENCES finding(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL CHECK (kind IN ('node','edge','file','commit')),
  node_id     INTEGER REFERENCES node(id),
  edge_id     INTEGER REFERENCES edge(id),
  file_id     INTEGER REFERENCES source_file(id),
  line        INTEGER,
  commit_sha  TEXT,
  CHECK (
    (kind = 'node'   AND node_id   IS NOT NULL) OR
    (kind = 'edge'   AND edge_id   IS NOT NULL) OR
    (kind = 'file'   AND file_id   IS NOT NULL) OR
    (kind = 'commit' AND commit_sha IS NOT NULL)
  )
);

CREATE INDEX citation_finding_idx ON citation (finding_id);
`;
