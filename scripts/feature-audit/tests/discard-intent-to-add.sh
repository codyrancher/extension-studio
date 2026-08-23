#!/bin/bash
# Discarding a file the assistant just created must remove it, not empty it.
#
# `workingDiff` runs `git add -A -N` over the whole tree so `git diff HEAD` can show new files at
# all. That leaves every new file intent-to-add: in the index against the empty blob. Such a path
# falls between the two halves of a discard - `git checkout --` restores it FROM the empty blob,
# truncating it to nothing, and `git clean` skips it because it is in the index.
#
# So "Discard all 5" emptied the assistant's new files and left them listed, still marked Unsaved.
# `discardChanges` now resets the pathspec out of the index first. This asserts both halves: that
# the old sequence really did truncate (so the test would have caught it) and that the new one
# removes the file while leaving tracked files alone.
set -u
fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1"; echo "        want $3, got $2"; fail=$((fail+1)); fi; }

setup() {
  D=$(mktemp -d); cd "$D"
  git init -q .; git config user.email t@t; git config user.name t
  echo base > kept.txt; git add .; git commit -qm base
  echo "the assistant's work" > new.vue
  git add -A -N >/dev/null 2>&1      # what workingDiff does on every review screen load
}

# The bug, so this test fails loudly if someone reverts the fix and reasons that it was harmless.
setup
git checkout -- . 2>/dev/null; git clean -fd >/dev/null 2>&1
if [ -f new.vue ]; then old="truncated-to-$(stat -c%s new.vue)"; else old="removed"; fi
check "the old sequence truncates a new file (the bug being guarded)" "$old" "truncated-to-0"
cd /; rm -rf "$D"

# The fix.
setup
git reset -q -- . 2>/dev/null; git checkout -- . 2>/dev/null; git clean -fd >/dev/null 2>&1
if [ -f new.vue ]; then new="still-present"; else new="removed"; fi
check "reset first removes the new file" "$new" "removed"
check "the tracked file is left alone" "$(cat kept.txt 2>/dev/null)" "base"
cd /; rm -rf "$D"

# And the same for a named pathspec, which is the per-file discard on the review screen.
setup
echo other > other.vue; git add -A -N >/dev/null 2>&1
git reset -q -- 'new.vue' 2>/dev/null; git checkout -- 'new.vue' 2>/dev/null; git clean -fd -- 'new.vue' >/dev/null 2>&1
if [ -f new.vue ]; then a="still-present"; else a="removed"; fi
check "a named discard removes just that file" "$a" "removed"
check "a file outside the pathspec is untouched" "$(cat other.vue 2>/dev/null)" "other"
cd /; rm -rf "$D"

echo
if [ $fail -eq 0 ]; then echo "ALL PASS"; else echo "$fail FAILED"; fi
exit $fail
