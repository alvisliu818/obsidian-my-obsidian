#!/usr/bin/env bash
# 从远端版本标签触发发布，并等待对应运行结束（需要 gh auth login）。
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="${1:-$(node -p "require('./manifest.json').version")}"
if [[ ! "$TAG" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "发布标签必须为 x.y.z 格式的正式版本。" >&2
  exit 1
fi

REPOSITORY="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
gh api "repos/$REPOSITORY/git/ref/tags/$TAG" --silent
# 历史标签中的旧发布流程不包含来源核验。
gh api "repos/$REPOSITORY/contents/scripts/verify-release.mjs?ref=refs/tags/$TAG" --silent
PREVIOUS_RUN="$(gh run list --repo "$REPOSITORY" --workflow release.yml \
  --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId // 0')"

RUN_URL="$(gh workflow run release.yml --repo "$REPOSITORY" --ref "$TAG")"
if [[ "$RUN_URL" =~ /actions/runs/([0-9]+)$ ]]; then
  RUN_ID="${BASH_REMATCH[1]}"
else
  # 旧版 gh 不返回运行链接，按本次触发前的运行编号查找新增运行。
  RUN_ID=""
  while [[ -z "$RUN_ID" ]]; do
    RUN_ID="$(gh run list --repo "$REPOSITORY" --workflow release.yml \
      --event workflow_dispatch --branch "$TAG" --limit 1 --json databaseId \
      --jq ".[0].databaseId | select(. > $PREVIOUS_RUN)")"
    if [[ -z "$RUN_ID" ]]; then sleep 3; fi
  done
  RUN_URL="https://github.com/$REPOSITORY/actions/runs/$RUN_ID"
fi

echo "发布运行：$RUN_URL"
gh run watch "$RUN_ID" --repo "$REPOSITORY" --exit-status
echo "发布完成：https://github.com/$REPOSITORY/releases/tag/$TAG"
