#!/usr/bin/env bash

octogee_oauth_provider_requirement() {
  case "$1" in
    github|google) printf '%s' launch ;;
    microsoft) printf '%s' disabled ;;
    *) return 2 ;;
  esac
}

octogee_secret_completeness_entry() {
  local label="$1" value="$2" requirement="$3" lifecycle="$4" phase="${5:-launch}"

  if [[ "$requirement" == "disabled" ]]; then
    echo -e "  ${YELLOW}↷${NC} $label — skipped (provider disabled)"
    return 0
  fi

  if [[ "$requirement" == "post-bootstrap" ]]; then
    if [[ "$phase" == "bootstrap" ]]; then
      echo -e "  ${YELLOW}↷${NC} $label — skipped (created after service bootstrap)"
      return 0
    fi
    requirement="launch"
  fi

  if [[ "$requirement" == "launch" ]]; then
    case "$lifecycle" in
      active|candidate) requirement="required" ;;
      *)
        echo -e "  ${YELLOW}↷${NC} $label — skipped (target is not launchable)"
        return 0
        ;;
    esac
  fi

  if [[ -n "$value" && "$value" != "placeholder" ]]; then
    echo -e "  ${GREEN}✓${NC} $label"
    return 0
  fi

  if [[ "$requirement" == "required" ]]; then
    echo -e "  ${RED}✗${NC} $label — ${RED}MISSING${NC}"
    OCTOGEE_SECRET_COMPLETENESS_FAILURES=$((OCTOGEE_SECRET_COMPLETENESS_FAILURES + 1))
    return 0
  fi

  echo -e "  ${YELLOW}↷${NC} $label — skipped (optional)"
}
