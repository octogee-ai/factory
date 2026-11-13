#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 <source-repository> <commit> <destination>" >&2
  exit 1
}

is_excluded_path() {
  local path="$1"
  case "$path" in
    .git|.git/*|*/.git|*/.git/*|.env*|*/.env*|*.pem|*.key|*.p12|*.pfx) return 0 ;;
    *) return 1 ;;
  esac
}

archive_exact_commit() {
  local remote="$1"
  local commit="$2"
  local destination="$3"
  local source
  local resolved_commit
  local path

  if ! [[ "$commit" =~ ^[0-9a-f]{40}$ ]]; then
    echo "source commit must be a lowercase 40-character SHA: $commit" >&2
    return 1
  fi
  if [ -e "$destination" ]; then
    echo "evidence destination must not exist: $destination" >&2
    return 1
  fi

  mkdir -p "$destination"
  source="$(mktemp -d)"
  trap "rm -rf -- $(printf '%q' "$source")" EXIT

  git init --bare --quiet "$source"
  git -C "$source" fetch --quiet --depth 1 "$remote" "$commit"
  resolved_commit="$(git -C "$source" rev-parse --verify FETCH_HEAD^{commit})"
  if [ "$resolved_commit" != "$commit" ]; then
    echo "fetched source commit differs from requested commit" >&2
    return 1
  fi

  git -C "$source" archive --format=tar "$resolved_commit" | tar --extract --directory "$destination"
  while IFS= read -r -d '' path; do
    path="${path#"$destination"/}"
    if is_excluded_path "$path"; then
      rm -rf -- "$destination/$path"
    fi
  done < <(find "$destination" -depth -print0)

  while IFS= read -r -d '' path; do
    path="${path#"$destination"/}"
    if is_excluded_path "$path"; then
      echo "sensitive source content remained after evidence sanitization" >&2
      return 1
    fi
  done < <(find "$destination" -depth -print0)

  printf '%s\n' "$commit" > "$destination/.octogee-source-commit"
}

if [ "$#" -ne 3 ]; then
  usage
fi

archive_exact_commit "$1" "$2" "$3"
