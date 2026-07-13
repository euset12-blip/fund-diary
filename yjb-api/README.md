# 养基宝 Python 工具

用于查询养基宝基金持仓和收益的命令行工具。扫码登录后，Node.js 端通过 `yjb-api.js` 共享同一个 Token。

## 快速开始

```bash
# 1. 装依赖
pip install requests qrcode Pillow

# 2. 扫码登录（Token 自动保存到 ~/.yjb_token.json）
python yjb_tool.py --login

# 3. 验证
python yjb_tool.py
```

> 💡 macOS/Linux 上如果 `pip` 找不到，用 `pip3`；如果 `python` 版本不对，用 `python3`。
>
> **不需要**配 API Secret —— 代码已内置默认值。

## 全部命令

| 命令 | 说明 |
|------|------|
| `python yjb_tool.py --login` | 扫码登录(加 `--debug` 看详细日志) |
| `python yjb_tool.py` | 仪表盘 — 指数行情 + 收益概览 |
| `python yjb_tool.py --search <代码>` | 搜索基金 |
| `python yjb_tool.py --accounts` | 列出所有账户 ID |
| `python yjb_tool.py --holdings <账户ID>` | 查看账户持仓 |
| `python yjb_tool.py --income-chart` | 收益曲线 |
| `python yjb_tool.py --income-data [账户ID]` | 收益数据 |
| `python yjb_tool.py --notice` | 系统公告 |

## 故障排查

### 二维码不显示

终端不支持 ASCII 二维码时会自动打印一个 URL 链接，复制到浏览器打开扫码。也可以试试装完整依赖：

```bash
pip install qrcode[pil]
```

### "未登录" 或 Token 过期

```bash
python yjb_tool.py --login
```

重新扫码即可。Token 有效期通常很长，不需要频繁登录。

### "401 未授权" 或其他网络错误

```bash
python test_api.py           # 测试 API 连通性
python yjb_tool.py --login --debug  # 登录 + 看详细日志
```

检查是否能访问 `http://browser-plug-api.yangjibao.com`。

## 注意事项

1. Token 保存在 `~/.yjb_token.json`，权限 600，Node.js (`yjb-api.js`) 和 Python 共享
2. 首次使用需要手机上的养基宝 APP 扫码登录
3. Token 过期后用 `--login` 重新扫码即可

## API 说明

- Base URL: `http://browser-plug-api.yangjibao.com`
- 认证方式：Token + MD5 签名（签名所需的 Secret 已内置默认值，无需手动配置）
- 所有请求通过 HTTPS 加密

## 许可证

仅供学习和个人使用。
