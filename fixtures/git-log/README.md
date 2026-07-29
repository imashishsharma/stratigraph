# git log fixtures

`mixed.log.txt` is the exact output of

```
git log -M --numstat -z --pretty=format:'%x01%H%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%s'
```

run against the repository that `build-probe-repo.sh` creates. It is the contract
the history parser is tested against.

Three bytes in that stream are invisible in an editor and would be lost by any
tool that normalises whitespace, so the fixture writes them as escapes and the
test decodes them:

| escape  | byte   | meaning                                        |
| ------- | ------ | ---------------------------------------------- |
| `<SOH>` | `0x01` | our own record sentinel, from `%x01`           |
| `<US>`  | `0x1f` | field separator inside a commit header, `%x1f` |
| `<NUL>` | `0x00` | git's own separator under `-z`                 |

Keeping the fixture readable matters more than keeping it byte-literal: a
reviewer has to be able to see, in a diff, what the parser is being held to.

## Why it is captured rather than hand-written

Everything else in `fixtures/` is hand-written, because there the fixture asserts
what *our* extractor should produce. This one asserts what *git* produces, and
inventing that from memory is exactly how a parser ends up handling a format
nobody emits. It was captured from git by running the script.

## Reproducing it

`build-probe-repo.sh` pins author and committer names, emails and dates, so every
commit sha is deterministic and a rebuild produces byte-identical output. Verified
against git 2.51. To regenerate after a git upgrade:

```sh
bash fixtures/git-log/build-probe-repo.sh          # writes fixtures/git-log/repo
cd fixtures/git-log/repo && git log -M --numstat -z \
  --pretty=format:'%x01%H%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%s'
```

then re-escape the three bytes above. If the output differs, the parser is what
needs to change — not the fixture.

## What each commit covers

Newest first, which is also the order `git log` emits them.

| commit                              | exercises                                                        |
| ----------------------------------- | ---------------------------------------------------------------- |
| reuse the side path for something else | a path re-created after deletion — git reports no rename, and the two lives merge under one path |
| delete side                         | deletion (`0` insertions)                                          |
| add a non-ascii path                | `src/café.txt` — `-z` emits it verbatim instead of quoting it      |
| *(empty subject)*                   | an empty commit: empty `%s`, and no `\n` before the record separator |
| merge side into main                | two parents, and **no numstat output at all** — git shows no diff for a merge unless asked |
| edit delta on main                  | ordinary edit                                                      |
| add side on a branch                | a commit that is not on the first-parent line                      |
| delete beta                         | deletion                                                           |
| add a binary file                   | `-` in place of both counts                                        |
| rename the spaced directory         | rename where both paths contain spaces                             |
| add a path with spaces              | space in a path, no quoting under `-z`                             |
| rename gamma to delta and edit      | rename **with** an edit: real counts plus a rename pair            |
| rename alpha to gamma               | pure rename: `0 0`, then old and new as two separate NUL fields    |
| add alpha and beta                  | root commit — empty parents field — and two files in one commit    |

The rename entries are the reason for `-z`. Without it git writes them as
`src/{alpha.txt => gamma.txt}`, which has to be un-braced by hand and is
ambiguous for any path containing ` => `. With it, the counts are followed by an
empty path field and then the old and new paths as separate fields.
