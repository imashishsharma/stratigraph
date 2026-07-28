import type { Db } from '../db/database.js';
import type {
  DiagnosticFact,
  EdgeFact,
  Fact,
  FileFact,
  MetaFact,
  NodeFact,
  NodeKind,
} from './types.js';

export interface FactWriterStats {
  files: number;
  nodes: number;
  /** Nodes created only because an edge referred to them. */
  stubs: number;
  edges: number;
  diagnostics: number;
}

/**
 * The one door through which facts enter the store. Extractors never touch
 * SQLite; they emit NDJSON and something on this side of the boundary writes it.
 */
export interface FactWriter {
  write(fact: Fact): void;
  /** Commit what has been written so far. Safe to call at any point. */
  flush(): void;
  close(): FactWriterStats;
  readonly stats: FactWriterStats;
}

const BATCH_SIZE = 5_000;

export class SqliteFactWriter implements FactWriter {
  readonly stats: FactWriterStats = {
    files: 0,
    nodes: 0,
    stubs: 0,
    edges: 0,
    diagnostics: 0,
  };

  private readonly fileIds = new Map<string, number>();
  private readonly nodeIds = new Map<string, number>();
  private extractor: string | null = null;
  private pending = 0;
  private inTransaction = false;
  private closed = false;

  private readonly stmts: {
    insertFile: import('better-sqlite3').Statement;
    updateFile: import('better-sqlite3').Statement;
    insertNode: import('better-sqlite3').Statement;
    upgradeNode: import('better-sqlite3').Statement;
    insertEdge: import('better-sqlite3').Statement;
    insertDiagnostic: import('better-sqlite3').Statement;
  };

  constructor(
    private readonly db: Db,
    private readonly runId: number,
  ) {
    this.stmts = {
      insertFile: db.prepare(
        `INSERT INTO source_file (run_id, path, language, loc, sha)
         VALUES (@runId, @path, @language, @loc, @sha)
         ON CONFLICT (run_id, path) DO NOTHING`,
      ),
      updateFile: db.prepare(
        `UPDATE source_file SET language = @language, loc = @loc, sha = @sha
         WHERE run_id = @runId AND path = @path`,
      ),
      insertNode: db.prepare(
        `INSERT INTO node (run_id, kind, fqn, name, parent_id, file_id, start_line, end_line, extractor, is_stub, attrs)
         VALUES (@runId, @kind, @fqn, @name, @parentId, @fileId, @startLine, @endLine, @extractor, @isStub, @attrs)
         ON CONFLICT (run_id, kind, fqn) DO NOTHING`,
      ),
      upgradeNode: db.prepare(
        `UPDATE node
            SET name = @name, parent_id = @parentId, file_id = @fileId,
                start_line = @startLine, end_line = @endLine,
                extractor = @extractor, is_stub = 0, attrs = @attrs
          WHERE id = @id`,
      ),
      insertEdge: db.prepare(
        `INSERT INTO edge (run_id, kind, src_id, dst_id, file_id, line, confidence, extractor, attrs)
         VALUES (@runId, @kind, @srcId, @dstId, @fileId, @line, @confidence, @extractor, @attrs)
         ON CONFLICT (run_id, kind, src_id, dst_id, ifnull(file_id, -1), ifnull(line, -1))
           DO UPDATE SET weight = weight + 1
         RETURNING weight`,
      ),
      insertDiagnostic: db.prepare(
        `INSERT INTO diagnostic (run_id, extractor, level, message, file_id, line)
         VALUES (@runId, @extractor, @level, @message, @fileId, @line)`,
      ),
    };
  }

  write(fact: Fact): void {
    if (this.closed) throw new Error('FactWriter is closed');
    this.begin();
    switch (fact.type) {
      case 'meta':
        this.writeMeta(fact);
        return;
      case 'file':
        this.writeFile(fact);
        break;
      case 'node':
        this.writeNode(fact);
        break;
      case 'edge':
        this.writeEdge(fact);
        break;
      case 'diagnostic':
        this.writeDiagnostic(fact);
        break;
    }
    this.pending += 1;
    if (this.pending >= BATCH_SIZE) this.flush();
  }

  flush(): void {
    if (this.inTransaction) {
      this.db.exec('COMMIT');
      this.inTransaction = false;
    }
    this.pending = 0;
  }

  close(): FactWriterStats {
    this.flush();
    this.closed = true;
    return this.stats;
  }

  private begin(): void {
    if (!this.inTransaction) {
      this.db.exec('BEGIN');
      this.inTransaction = true;
    }
  }

  private writeMeta(fact: MetaFact): void {
    this.extractor = fact.extractor;
  }

  private writeFile(fact: FileFact): void {
    const params = {
      runId: this.runId,
      path: fact.path,
      language: fact.language,
      loc: fact.loc ?? null,
      sha: fact.sha ?? null,
    };
    const info = this.stmts.insertFile.run(params);
    if (info.changes === 0) {
      // Placeholder row created earlier by a node/edge that referenced the file.
      this.stmts.updateFile.run(params);
    } else {
      this.stats.files += 1;
      this.fileIds.set(fact.path, Number(info.lastInsertRowid));
    }
  }

  private writeNode(fact: NodeFact): void {
    const parentId = fact.parent ? this.nodeId(fact.parent.kind, fact.parent.fqn) : null;
    const params = {
      runId: this.runId,
      kind: fact.kind,
      fqn: fact.fqn,
      name: fact.name,
      parentId,
      fileId: fact.file === undefined ? null : this.fileId(fact.file),
      startLine: fact.startLine ?? null,
      endLine: fact.endLine ?? null,
      extractor: this.extractor,
      isStub: 0,
      attrs: fact.attrs ? JSON.stringify(fact.attrs) : null,
    };
    const info = this.stmts.insertNode.run(params);
    if (info.changes > 0) {
      this.nodeIds.set(key(fact.kind, fact.fqn), Number(info.lastInsertRowid));
      this.stats.nodes += 1;
      return;
    }
    // Already present: either a stub we can now fill in, or a duplicate emission.
    const id = this.nodeId(fact.kind, fact.fqn);
    const existing = this.db
      .prepare('SELECT is_stub FROM node WHERE id = ?')
      .get(id) as { is_stub: number } | undefined;
    if (existing?.is_stub === 1) {
      this.stmts.upgradeNode.run({ ...params, id });
      this.stats.stubs -= 1;
      this.stats.nodes += 1;
    }
  }

  private writeEdge(fact: EdgeFact): void {
    // RETURNING tells insert from bump: a fresh row always comes back weight 1.
    const row = this.stmts.insertEdge.get({
      runId: this.runId,
      kind: fact.kind,
      srcId: this.nodeId(fact.src.kind, fact.src.fqn),
      dstId: this.nodeId(fact.dst.kind, fact.dst.fqn),
      fileId: fact.file === undefined ? null : this.fileId(fact.file),
      line: fact.line ?? null,
      confidence: fact.confidence ?? 'fact',
      extractor: this.extractor,
      attrs: fact.attrs ? JSON.stringify(fact.attrs) : null,
    }) as { weight: number };
    if (row.weight === 1) this.stats.edges += 1;
  }

  private writeDiagnostic(fact: DiagnosticFact): void {
    this.stmts.insertDiagnostic.run({
      runId: this.runId,
      extractor: this.extractor,
      level: fact.level,
      message: fact.message,
      fileId: fact.file === undefined ? null : this.fileId(fact.file),
      line: fact.line ?? null,
    });
    this.stats.diagnostics += 1;
  }

  /**
   * Resolve a node reference to a row id, creating a stub if nothing has
   * declared it yet. Stubs are how we record edges into code we cannot see
   * (the JDK, a third-party jar) without pretending we parsed it.
   */
  private nodeId(kind: NodeKind, fqn: string): number {
    const cacheKey = key(kind, fqn);
    const cached = this.nodeIds.get(cacheKey);
    if (cached !== undefined) return cached;

    const found = this.db
      .prepare('SELECT id FROM node WHERE run_id = ? AND kind = ? AND fqn = ?')
      .get(this.runId, kind, fqn) as { id: number } | undefined;
    if (found) {
      this.nodeIds.set(cacheKey, found.id);
      return found.id;
    }

    const info = this.stmts.insertNode.run({
      runId: this.runId,
      kind,
      fqn,
      name: lastSegment(fqn),
      parentId: null,
      fileId: null,
      startLine: null,
      endLine: null,
      extractor: this.extractor,
      isStub: 1,
      attrs: null,
    });
    const id = Number(info.lastInsertRowid);
    this.nodeIds.set(cacheKey, id);
    this.stats.stubs += 1;
    return id;
  }

  private fileId(path: string): number {
    const cached = this.fileIds.get(path);
    if (cached !== undefined) return cached;

    const found = this.db
      .prepare('SELECT id FROM source_file WHERE run_id = ? AND path = ?')
      .get(this.runId, path) as { id: number } | undefined;
    if (found) {
      this.fileIds.set(path, found.id);
      return found.id;
    }

    const info = this.stmts.insertFile.run({
      runId: this.runId,
      path,
      language: 'unknown',
      loc: null,
      sha: null,
    });
    const id = Number(info.lastInsertRowid);
    this.fileIds.set(path, id);
    this.stats.files += 1;
    return id;
  }
}

function key(kind: string, fqn: string): string {
  return `${kind} ${fqn}`;
}

function lastSegment(fqn: string): string {
  const match = /[^.#/$]+$/.exec(fqn);
  return match ? match[0] : fqn;
}
