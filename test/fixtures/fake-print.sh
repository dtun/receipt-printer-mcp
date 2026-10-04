#!/bin/bash
# Stand-in for print.sh: records what would have been printed.
cat > "$FAKE_OUT"
if [[ -n "${FAKE_FAIL:-}" ]]; then
  echo "$FAKE_FAIL" >&2
  exit 1
fi
echo "Sent to fake printer."
