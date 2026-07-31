# BIG-GOOSE开发 —— 一个CS机器人，宣传完我退出在进入宣传在退出机器人!

基于 OneBot v11 反向 WebSocket 协议，面向腾讯 QQ 的自动群发工具。

## 功能

- 向指定群聊循环发送消息（间隔 1 秒，每轮随机 1-5 次）
- 发完后自动退群 → 重新加群 → 下一轮（直到手动停止）
- 简易 WebUI 管理面板，支持配置消息内容、目标群、频率等
- 反向 WebSocket 和 WebUI 端口均可在配置文件中设置

## 支持的 OneBot 实现

| 实现 | 支持情况 |
|------|---------|
| [NapCat](https://github.com/NapNeko/NapCatQQ) | 完全支持（含加群 API） |
| [LLOneBot](https://github.com/LLOneBot/LLOneBot) | 完全支持（含加群 API） |
| go-cqhttp | 支持（加群需手动邀请） |

## 快速开始

### 1. 安装依赖

```bash
cd onebot-spammer
npm install
```

### 2. 配置 OneBot 反向 WebSocket

在你的 QQ OneBot 客户端中设置反向 WebSocket 地址，例如 NapCat 的 `napcat.json`：

```json
{
  "wsReverse": {
    "enable": true,
    "urls": ["ws://127.0.0.1:3001/"]
  }
}
```

### 3. 修改配置（可选）

编辑 `config.json`：

```json
{
  "ws": {
    "host": "0.0.0.0",
    "port": 3001,
    "access_token": ""
  },
  "webui": {
    "host": "0.0.0.0",
    "port": 3000
  },
  "bot": {
    "message": "这是一条测试消息",
    "target_group_id": "",
    "interval_ms": 1000,
    "min_times": 1,
    "max_times": 5
  }
}
```

| 字段 | 说明 |
|------|------|
| `ws.port` | 反向 WebSocket 服务端口 |
| `ws.access_token` | 鉴权 token（留空不校验） |
| `webui.port` | WebUI 管理面板端口 |
| `bot.message` | 要发送的消息内容 |
| `bot.target_group_id` | 目标群号（可在 WebUI 中选择） |
| `bot.interval_ms` | 每条消息间隔（毫秒） |
| `bot.min_times` | 每轮最少发送次数 |
| `bot.max_times` | 每轮最多发送次数 |

### 4. 启动

```bash
npm start
```

### 5. 打开 WebUI

浏览器访问 `http://localhost:3000`，选择目标群 → 设置消息 → 点击"开始"。

## 工作流程

```
开始 → 发消息×N（随机1~5次，间隔1秒）→ 退群 → 等待3秒 → 加群 → 等待2秒 → 下一轮 → ...
                                                                              ↑
                                                                   用户点"停止"终止
```

## 目录结构

```
onebot-spammer/
├── config.json      # 配置文件
├── package.json     # 依赖描述
├── main.js          # 主程序（OneBot WS + WebUI）
└── README.md        # 本文档
```

## 注意事项

- **加群功能**依赖 OneBot 实现提供的扩展 API（`set_group_add`），NapCat 和 LLOneBot 均支持。若你的实现不支持，程序会跳过加群步骤并打印日志，你可手动邀请机器人入群。
- 频繁退群/加群可能触发 QQ 安全机制，请谨慎使用。
- 仅用于学习研究，请勿用于骚扰或违规行为。
