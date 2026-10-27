---
id: image-xapp-v1
version: 1.0.2
name: image-xapp-v1
description: Use when the user wants to generate or edit images via ry.live from an X Workbench panel — 5 models (Grok standard/v2/quality for text-to-image; Eliroot eliroot-image-2.1 / eliroot-turbo for text-to-image AND image-to-image editing with 1-4 reference images). Fill prompt/model/ratio, optionally upload 1-4 reference images, click generate, see the image directly in the panel. Requires the local bridge service (engine/grok_image.mjs --serve on 127.0.0.1:8788, auto-falls back to 8789-8792 if taken). Panel auto-starts the bridge via app-task; it exits 60s after the panel closes.
---

# GROK + Eliroot 生图/改图（面板版）

X Workbench 面板：填 prompt/模型/宽高比（Eliroot 可选 1-4 张参考图做图生图/改图）→ 点击「生成图片」→ 面板直接显示图。无 Agent 介入，同步等待，同时落盘到 `engine/grok-images/`。

## 模型

| 模型 | 能力 | 特点 |
|---|---|---|
| standard / v2 / quality | GROK 文生图 | 任务端点，1K/1.5K(仅v2)/2K |
| eliroot | Eliroot 2.1 文生图+图生图 | 同步接口，约 170s，尺寸 32 倍数 ≤1M 像素 |
| eliroot-turbo | 同上 | 快速版，约 45-55s |

## 首次安装（用户必读）

1. 本包为**自包含 SKILL**：面板 + 引擎（`engine/grok_image.mjs`）一起分发，无需外部目录。
2. **配置密钥**：把你的 ry.live API KEY 填入 `engine/key.txt`（一行，无换行/空格）。也可以设置环境变量 `NEW_API_KEY`。Eliroot 与 GROK 共用同一把 KEY。
3. 依赖 Node.js（面板自动拉起时使用系统 `node` 命令）。Windows 用户建议确认 `node --version` 可用。

## 打开前

桥接服务必须在线（面板是沙箱，无法自行启动进程）。面板打开后会自动检测并拉起服务，无需手动操作：

- 自动：面板探测 `/health` 离线 → 发送 app-task 给 Agent → Agent 在 `engine/` 目录运行 `node grok_image.mjs --serve` → 面板轮询到在线。
- 手动（自动启动超时/失败时）：打开终端，cd 到本 SKILL 的 `engine/` 目录（`~/.xuanji/skills/image-xapp-v1/engine`），运行 `node grok_image.mjs --serve`。

服务监听 127.0.0.1:8788（被占自动切 8789-8792），面板关闭后 60s 无心跳自动退出。

## 打开面板

对话中说「打开生图」，或「+ → Skills → image-xapp-v1 → Open」。

## 多参考图用法

Eliroot 图生图支持 1-4 张参考图，**按上传顺序编号**（面板缩略图左上角标注「图1」「图2」…）。在提示词中用「图 1」「图 2」指代各图，明确要改哪张、保留哪张。例：

> 按照图2的配色和光影风格，把图1中的红色杯子改为蓝色，杯柄、构图和背景保持不变。

## 密钥

- 共用一把 KEY：填到 `engine/key.txt`（或环境变量 `NEW_API_KEY`）。
- 引擎每次请求读文件（无缓存），改 key 后立即生效，无需重启服务。
