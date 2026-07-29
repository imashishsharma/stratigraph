#!/bin/bash
# Build a synthetic repo covering every shape the history miner must parse,
# then dump what `git log -M --numstat -z` actually emits.
set -euo pipefail

REPO="$(dirname "$0")/repo"
rm -rf "$REPO"
mkdir -p "$REPO"
cd "$REPO"

git init -q -b main
git config user.name "Ada Probe"
git config user.email "ada@example.invalid"
git config commit.gpgsign false
git config core.autocrlf false

commit() {
  local when="$1" msg="$2"
  GIT_AUTHOR_DATE="$when" GIT_COMMITTER_DATE="$when" \
    git commit -q --no-gpg-sign -m "$msg"
}

# 1 — plain commit, two files
mkdir -p src
printf 'one\ntwo\nthree\n' > src/alpha.txt
printf 'a\n' > src/beta.txt
git add -A
commit "2024-01-01T10:00:00+00:00" "add alpha and beta"

# 2 — pure rename, no content change
git mv src/alpha.txt src/gamma.txt
git add -A
commit "2024-01-02T10:00:00+00:00" "rename alpha to gamma"

# 3 — rename with an edit (below git's similarity threshold break point)
git mv src/gamma.txt src/delta.txt
printf 'one\ntwo\nthree\nfour\n' > src/delta.txt
git add -A
commit "2024-01-03T10:00:00+00:00" "rename gamma to delta and edit"

# 4 — a path containing a space, and a directory rename
mkdir -p "docs/old notes"
printf 'note\n' > "docs/old notes/read me.md"
git add -A
commit "2024-01-04T10:00:00+00:00" "add a path with spaces"

git mv "docs/old notes" "docs/new notes"
git add -A
commit "2024-01-05T10:00:00+00:00" "rename the spaced directory"

# 5 — a binary file
printf '\x00\x01\x02\x03binary\x00' > src/blob.bin
git add -A
commit "2024-01-06T10:00:00+00:00" "add a binary file"

# 6 — delete
git rm -q src/beta.txt
commit "2024-01-07T10:00:00+00:00" "delete beta"

# 7 — a merge commit
git checkout -q -b side
printf 'side\n' > src/side.txt
git add -A
commit "2024-01-08T10:00:00+00:00" "add side on a branch"
git checkout -q main
printf 'one\ntwo\nthree\nfour\nfive\n' > src/delta.txt
git add -A
commit "2024-01-09T10:00:00+00:00" "edit delta on main"
GIT_AUTHOR_DATE="2024-01-10T10:00:00+00:00" GIT_COMMITTER_DATE="2024-01-10T10:00:00+00:00" \
  git merge -q --no-ff --no-gpg-sign -m "merge side into main" side

# 8 — empty subject, and an empty commit (no files at all)
GIT_AUTHOR_DATE="2024-01-11T10:00:00+00:00" GIT_COMMITTER_DATE="2024-01-11T10:00:00+00:00" \
  git commit -q --no-gpg-sign --allow-empty --allow-empty-message -m ""

# 9 — non-ASCII path, to check quoting
printf 'accents\n' > "src/café.txt"
git add -A
commit "2024-01-12T10:00:00+00:00" "add a non-ascii path"

# 10 — path reused after deletion, for the documented over-merge case
git rm -q "src/side.txt"
commit "2024-01-13T10:00:00+00:00" "delete side"
printf 'completely different content here\nnothing like the original\n' > src/side.txt
git add -A
commit "2024-01-14T10:00:00+00:00" "reuse the side path for something else"

echo "built $(git rev-list --count HEAD) commits in $PWD" >&2
