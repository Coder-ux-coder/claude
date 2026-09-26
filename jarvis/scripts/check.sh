#!/usr/bin/env bash
# Full verification gate: every commit must pass this. Exits non-zero on the first failure.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== TypeScript build";      npx tsc -b packages/shared packages/core
echo "== Schema export check";   npx tsx packages/shared/scripts/export-schemas.ts --check
echo "== Spec conformance";      npx tsx tools/spec-conformance.ts > /tmp/jv-conf.txt || { cat /tmp/jv-conf.txt; exit 1; }; tail -1 /tmp/jv-conf.txt
if command -v dotnet >/dev/null; then
  echo "== .NET build + tests"; (cd native && dotnet build -nologo -v q >/dev/null && dotnet test -nologo -v q 2>&1 | tee /tmp/jv-net.txt | grep -E "Passed!|Failed!"; ! grep -q "Failed!" /tmp/jv-net.txt)
fi
echo "== TypeScript tests"
node --import tsx --test packages/*/test/*.test.ts > /tmp/jv-ts.txt 2>&1 || { grep -E "^not ok" /tmp/jv-ts.txt; exit 1; }
grep -E "^# (pass|fail)" /tmp/jv-ts.txt
echo "ALL CHECKS PASSED"
