#!/usr/bin/env bash
# 全套 E2E：模板 / 商业能力 / 拟人输入 / 新功能 / 压测。
#
# 这些脚本各起一个独立的临时 userData，互不干扰，可以顺次跑；
# 都需要在**有 X server 的 Linux** 上跑（设 DISPLAY），
# 或在 Windows 上有可用的桌面会话。
#
# 跑法：
#   DISPLAY=:99 bash tools/e2e-all.sh
#
# 单个脚本失败不中断后续 —— 最后统一汇总退出码：
# 一处失败就 exit 1，全套过才 exit 0。

set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

if [[ "$(uname -s)" == Linux* && -z "${DISPLAY:-}" ]]; then
  echo "需要 DISPLAY（例如 DISPLAY=:99 bash tools/e2e-all.sh）" >&2
  exit 2
fi

scripts=(
  tools/e2e-templates.mjs
  tools/e2e-commercial.mjs
  tools/e2e-human-input.mjs
  tools/e2e-new-features.mjs
  tools/stress-features.mjs
)

fail=0
for s in "${scripts[@]}"; do
  echo ""
  echo "########## $s ##########"
  if node "$s"; then
    echo "===== OK: $s ====="
  else
    echo "===== FAILED: $s ====="
    fail=1
  fi
done

echo ""
if [[ $fail -eq 0 ]]; then
  echo "########## E2E ALL PASS ##########"
else
  echo "########## E2E HAS FAILURE ##########"
fi
exit "$fail"
