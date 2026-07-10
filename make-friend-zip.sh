#!/bin/bash
# 生成给朋友的干净分发包
# 用法: bash make-friend-zip.sh

set -e

TEMP=$(mktemp -d)
trap "rm -rf $TEMP" EXIT

echo "📦 正在生成干净分发包..."

# 复制仓库（排除 .git 和敏感文件）
rsync -av --exclude='.git' --exclude='node_modules' --exclude='.env' \
      --exclude='*.log' --exclude='.claude' \
      . "$TEMP/fund-diary/"

cd "$TEMP/fund-diary"

# 1. 清空真实持仓数据，替换为模板
cat > holdings.json << 'EOF'
[]
EOF

# 2. 清空交易记录
cat > 交易记录.json << 'EOF'
[]
EOF

# 3. 清空操作日志，只保留模板
cat > 操作日志.md << 'EOF'
# 养基日记 - 操作日志

> ⚠️ 此日志仅供个人记录，不构成投资建议。

---

## 操作记录模板

### YYYY-MM-DD
- **买入/加仓**: [基金代码] [名称] [金额] [理由]
- **卖出/减仓**: [基金代码] [名称] [金额] [理由]
EOF

# 4. fund-config.json 只保留 sectorMap（板块码映射），清空个人基金配置
cat > fund-config.json << 'EOF'
{
  "sectorMap": {
    "BK0457": "电网设备", "BK0458": "新能源车", "BK0459": "光伏设备",
    "BK0460": "白酒", "BK0461": "创新药", "BK0462": "半导体",
    "BK0463": "5G概念", "BK0464": "人工智能", "BK0465": "区块链",
    "BK0466": "虚拟现实", "BK0467": "无人驾驶", "BK0468": "工业互联",
    "BK0469": "网络安全", "BK0470": "在线教育", "BK0471": "远程办公",
    "BK0472": "网红直播", "BK0473": "免税概念", "BK0474": "地摊经济",
    "BK0475": "字节概念", "BK0476": "鸿蒙概念", "BK0477": "元宇宙",
    "BK0478": "东数西算", "BK0479": "ChatGPT", "BK0480": "CPO概念",
    "BK0481": "算力概念", "BK0482": "光通信模块", "BK0483": "星闪概念",
    "BK0484": "新质生产力", "BK0495": "医疗器械",
    "BK0501": "信创", "BK0514": "工业母机",
    "BK0521": "存储芯片", "BK0531": "数据要素",
    "BK0582": "商业航天", "BK0583": "飞行汽车",
    "BK0963": "有色铝", "BK1036": "半导体", "BK1038": "光学光电子",
    "BK1044": "通信设备", "BK1303": "锂电池", "BK1592": "通信线缆及配套",
    "BK1654": "新能源汽车", "BK1657": "充电桩",
    "BK1847": "储能", "BK1996": "国企改革", "BK2064": "低空经济"
  },
  "fundIndexMap": {},
  "fundStrategy": {},
  "indices": {
    "1.000001": "上证指数", "1.000300": "沪深300",
    "0.399001": "深证成指", "0.399006": "创业板指"
  },
  "email": {
    "user": "",
    "pass": "",
    "to": "",
    "host": "smtp.qq.com",
    "port": 465
  }
}
EOF

# 5. 打包
ZIPFILE="$OLDPWD/fund-diary-friend.zip"
zip -r "$ZIPFILE" . -x '.git/*' 'node_modules/*'

echo ""
echo "✅ 已生成: fund-diary-friend.zip"
echo "   位置: $(realpath "$ZIPFILE" 2>/dev/null || echo "$PWD/../fund-diary-friend.zip")"
echo ""
echo "📋 已清除的隐私数据:"
echo "   - holdings.json (替换为空模板)"
echo "   - 交易记录.json (替换为空模板)"
echo "   - 操作日志.md (替换为模板)"
echo "   - fund-config.json (只保留板块映射，清空个人基金和邮箱)"
echo "   - .env (不在包内)"
echo "   - .claude/ (不在包内)"
echo "   - yjb-api/ (不在包内 — 登录脚本见下方说明)"
echo ""
echo "⚠️  朋友需要手动下载养基宝登录脚本:"
echo "   你的 yjb-api/ 目录在 .gitignore，需要单独发给他"
echo "   或者让他从 https://github.com/euset12-blip/fund-diary 抄 yjb_tool.py"
echo ""
echo "📧 发给朋友时附上这段话:"
echo "   ─────────────────────────────────────────"
echo "   解压后打开 Codex，把这些话发给他："
echo ""
echo "   「帮我部署这个养基日记基金分析工具。"
echo "   先读 README.md、CLAUDE.md 和 SETUP.md。"
echo "   然后按 SETUP.md 里的步骤一步步来。"
echo "   第一步: npm install && cp .env.example .env"
echo "   我是小傻瓜用户，请每步解释清楚、不要跳步。」"
echo ""
echo "   ⚠️ 如果用的是 Codex："
echo "   Codex 不会自动读项目说明，所以你的第一条消息必须是："
echo "   「先读 README.md 和 CLAUDE.md 了解这个项目。然后帮我部署。」""
echo "   ─────────────────────────────────────────"
