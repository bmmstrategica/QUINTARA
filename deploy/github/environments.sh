#!/usr/bin/env bash
# Creates the repository's two GitHub Environments for the release workflow (.github/workflows/release.yml):
#   staging     anyone with write access may release it; the default branch only
#   production  waits for approval by the reviewers named here; the default branch only
#
# Run by a repository admin, signed in with the GitHub CLI (gh auth login):
#   deploy/github/environments.sh <reviewer> [<reviewer> ...]
# For example:  deploy/github/environments.sh alice bob
#
# With two or more reviewers, whoever starts a production run cannot approve it themselves. Running it again updates
# the settings; it never deletes an environment or its secrets.
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Name at least one GitHub user who must approve production releases: $0 <reviewer> [<reviewer> ...]" >&2
  exit 2
fi
command -v gh >/dev/null || { echo "Install the GitHub CLI (https://cli.github.com) and run gh auth login first." >&2; exit 1; }

repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
branch=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)
echo "Repository: $repo (default branch: $branch)"

# Reviewers, as GitHub's numeric user ids.
reviewers=""
for login in "$@"; do
  id=$(gh api "users/$login" --jq .id) || { echo "No GitHub user named $login." >&2; exit 1; }
  reviewers="$reviewers{\"type\":\"User\",\"id\":$id},"
done
reviewers="[${reviewers%,}]"
self_review=false
[ "$#" -ge 2 ] && self_review=true

# Each environment may be deployed from the default branch only.
environment() {
  local name=$1 body=$2
  echo "$body" | gh api -X PUT "repos/$repo/environments/$name" --input - >/dev/null
  # Replace whatever branch rules it had with the default branch alone.
  for id in $(gh api "repos/$repo/environments/$name/deployment-branch-policies" --jq '.branch_policies[].id'); do
    gh api -X DELETE "repos/$repo/environments/$name/deployment-branch-policies/$id" >/dev/null
  done
  gh api -X POST "repos/$repo/environments/$name/deployment-branch-policies" -f name="$branch" -f type=branch >/dev/null
  echo "  $name: ready"
}

environment staging '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
environment production "{\"reviewers\":$reviewers,\"prevent_self_review\":$self_review,\"deployment_branch_policy\":{\"protected_branches\":false,\"custom_branch_policies\":true}}"

echo
echo "Production waits for: $*$([ "$self_review" = true ] && echo ' (the person who starts a run cannot approve it)')"
echo "Next: add each environment's secrets and variables (docs/DEPLOYMENT.md, \"Release workflow\")."
