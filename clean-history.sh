#!/bin/bash
# Git 历史敏感信息清洗脚本
# 用法: bash clean-history.sh
# 警告: 此操作会重写所有 git 历史，执行前请确保已备份！

set -e

echo "🔒 开始清洗 Git 历史中的敏感信息..."
echo "   将处理 $(git rev-list --count --all) 个提交"

# 使用 --tree-filter 在每个 commit 中替换敏感信息
git filter-branch -f --tree-filter '
  # ─── 替换 check-deepseek.py 中的 VPS 凭据 ───
  if [ -f check-deepseek.py ]; then
    sed -i "s/45\.202\.241\.42/YOUR_VPS_IP/g" check-deepseek.py 2>/dev/null || true
    sed -i "s/X@89Bk5oo2HmCqbrF\./YOUR_VPS_PASSWORD/g" check-deepseek.py 2>/dev/null || true
  fi

  # ─── 替换 yjb-api.js 中的 API Secret 和 Account ID ───
  if [ -f yjb-api.js ]; then
    sed -i "s/YxmKSrQR4uoJ5lOoWIhcbd7SlUEh9OOc/YOUR_YJB_API_SECRET/g" yjb-api.js 2>/dev/null || true
    sed -i "s/'\''7442900'\''/'\'''\''/g" yjb-api.js 2>/dev/null || true
  fi

  # ─── 替换 yjb-api/yjb_tool.py 中的 API Secret ───
  if [ -f yjb-api/yjb_tool.py ]; then
    sed -i "s/YxmKSrQR4uoJ5lOoWIhcbd7SlUEh9OOc/YOUR_YJB_API_SECRET/g" yjb-api/yjb_tool.py 2>/dev/null || true
  fi

  # ─── 替换 holdings-io.js 中的 Account ID ───
  if [ -f holdings-io.js ]; then
    sed -i "s/'\''7442900'\''/'\'''\''/g" holdings-io.js 2>/dev/null || true
  fi

  # ─── 替换 lib/data-layer.js 中的 Account ID ───
  if [ -f lib/data-layer.js ]; then
    sed -i "s/'\''7442900'\''/'\'''\''/g" lib/data-layer.js 2>/dev/null || true
  fi

  # ─── 替换 .env.example 中的 Account ID ───
  if [ -f .env.example ]; then
    sed -i "s/YJB_ACCOUNT_ID=7442900/YJB_ACCOUNT_ID=your_account_id/g" .env.example 2>/dev/null || true
  fi

  # ─── 替换 README.md 中的 Account ID ───
  if [ -f README.md ]; then
    sed -i "s/YJB_ACCOUNT_ID=7442900/YJB_ACCOUNT_ID=your_account_id/g" README.md 2>/dev/null || true
  fi

  # ─── 清除 holdings.json 中的真实持仓数据（替换为 []） ───
  if [ -f holdings.json ]; then
    echo "[]" > holdings.json
  fi

  # ─── 清除 交易记录.json 中的真实交易数据 ───
  if [ -f 交易记录.json ]; then
    echo "[]" > 交易记录.json
  fi

  # ─── 清除 操作日志.md 中的个人记录 ───
  if [ -f 操作日志.md ]; then
    cat > 操作日志.md << "TEMPLATE_EOF"
# 养基日记 - 操作日志

> ⚠️ 此日志仅供个人记录，不构成投资建议。投资有风险，买卖需谨慎。

---

## 操作记录模板

### YYYY-MM-DD
- **买入/加仓**: [基金代码] [名称] [金额] [理由]
- **卖出/减仓**: [基金代码] [名称] [金额] [理由]

---

- **市场点评**: [简要记录]
TEMPLATE_EOF
  fi

  # ─── 替换 setings.local.json 中的 VPS IP ───
  if [ -f .claude/settings.local.json ]; then
    sed -i "s/45\.202\.241\.42/YOUR_VPS_IP/g" .claude/settings.local.json 2>/dev/null || true
  fi
' -- --all

echo ""
echo "✅ 历史清洗完成！"
echo ""
echo "📋 已处理:"
echo "   - VPS IP / 密码 → YOUR_VPS_IP / YOUR_VPS_PASSWORD"
echo "   - YJB API Secret → YOUR_YJB_API_SECRET"
echo "   - YJB Account ID → 清空"
echo "   - holdings.json / 交易记录.json → []"
echo "   - 操作日志.md → 模板"
echo "   - settings.local.json → 替换 IP"
echo ""
echo "⚠️ 原始引用仍保留在 .git/refs/original/ 中"
echo "   确认无误后运行以下命令彻底删除："
echo "   git for-each-ref --format='%(refname)' refs/original/ | xargs -n 1 git update-ref -d"
echo "   git reflog expire --expire=now --all"
echo "   git gc --aggressive --prune=now"
