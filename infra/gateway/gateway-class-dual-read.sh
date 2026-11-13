dual_read_gateway_class() {
  case "$1" in
    isolated) printf '%s\n' builder ;;
    *) printf '%s\n' "$1" ;;
  esac
}
