/**
 * Rename chains, resolved in one backwards pass. See ADR-0009.
 *
 * `git log` walks newest to oldest, so a rename `old → new` at commit C means
 * every `old` in a commit older than C is the same file as `new`. Feed renames
 * in the order git emits them and each superseded path maps straight to the
 * name the file carries today — no chain to walk at read time.
 */
export class RenameChain {
  private readonly alias = new Map<string, string>();

  /**
   * Record a rename, having already seen every later commit.
   *
   * The target is resolved through the map first, so `b → c` seen earlier in
   * the walk turns a subsequent `a → b` into `a → c` rather than into a link.
   */
  record(oldPath: string, newPath: string): void {
    const target = this.canonical(newPath);
    // A path renamed away and later renamed back would otherwise alias to
    // itself, which is at best noise and at worst a lookup that never settles.
    if (target === oldPath) return;
    this.alias.set(oldPath, target);
  }

  /** The name this path's content carries at HEAD. Itself, if never renamed. */
  canonical(path: string): string {
    return this.alias.get(path) ?? path;
  }

  /** How many paths were superseded. Reported, so a run says what it resolved. */
  get size(): number {
    return this.alias.size;
  }
}
