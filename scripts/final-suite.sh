#!/usr/bin/env bash
# Runs the complete verification suite on the current tree, in order, and prints a PASS/FAIL ledger.
# Usage: bash scripts/final-suite.sh   (needs .env.local; touches only the dedicated Prism Studio project)
cd "$(dirname "$0")/.." || exit 1
declare -a LEDGER
run() {
  local name="$1"; shift
  echo; echo "################ $name"
  if "$@"; then LEDGER+=("PASS  $name"); else LEDGER+=("FAIL  $name"); fi
}

run "git status (must be inspected)"        git status --short
run "migration checksums"                    npm run db:migrate:check --silent
run "seed --reset (pristine demo)"           npm run db:seed --silent -- --reset
run "exercise: baseline"                     npm run db:exercise --silent -- baseline
run "exercise: mutate"                       npm run db:exercise --silent -- mutate
run "exercise: verify (new process)"         npm run db:exercise --silent -- verify
run "seed --reset (restore)"                 npm run db:seed --silent -- --reset
run "db structural validation"               npm run db:validate --silent
run "db behavioral tests"                    npm run db:behavior --silent
run "app RLS + storage policy tests"         npm run db:rls --silent
run "storage API smoke (anon part)"          npm run db:storage:smoke --silent
run "unit tests"                             npm run test --silent
run "typecheck"                              npm run typecheck --silent
run "eslint"                                 npm run lint --silent
run "prettier check"                         npm run format:check --silent
run "production build"                       npm run build --silent
run "playwright: memory mode"                npm run test:e2e --silent
run "playwright: supabase auth mode"         npm run test:e2e:supabase --silent

echo; echo "================ LEDGER"
printf '%s\n' "${LEDGER[@]}"
