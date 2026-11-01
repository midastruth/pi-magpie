# pi-magpie

在 **只安装了 Pi、没有安装 Magpie** 的电脑上，使用 VPS 上的 Magpie 模型网关。

```text
本机 Pi → pi-magpie → HTTPS + gateway key → VPS Magpie → 模型服务商
```

插件只在 Pi 侧运行，不需要修改 Magpie。它把 Magpie 加为独立的 `magpie` provider，不替换其他 provider，不自动切换当前模型，也不改写 `models.json`、`auth.json` 或已有模型设置。

## 安装

需要 Pi（当前针对 `@earendil-works/pi-coding-agent` 1.4.0 测试）。在客户端电脑上直接从 GitHub 安装：

```sh
pi install git:github.com/midastruth/pi-magpie
```

也可以克隆后从本地目录安装：

```sh
pi install /绝对路径/pi-magpie
```

如果 Pi 已经在运行，执行 `/reload`。开发时也可以临时加载：

```sh
pi -e /绝对路径/pi-magpie/index.ts
```

**本项目尚未发布到 npm**，目前支持 GitHub 或本地目录安装。

## 方式一：在 Pi 内配置

运行：

```text
/magpie setup
```

依次填写：

1. Magpie API 地址，例如 `https://magpie.example.com` 或 `https://magpie.example.com/v1`。
2. Magpie 签发的 **gateway key**。

插件会先验证模型列表，成功后保存配置到 `~/.pi/agent/magpie.json`、模型缓存到 `~/.pi/agent/magpie-models.json`，文件权限均为 `0600`。如果设置了 `PI_CODING_AGENT_DIR`，使用该目录。密钥只保存在私有配置文件中，不写入模型缓存；不要提交或分享配置文件。

**Pi 的普通输入框不隐藏密钥字符，请勿在共享屏幕或终端录制时填写。** 不要把密钥写在聊天消息或 `/magpie ...` 命令参数里；也可以使用下方环境变量方式。

然后运行 `/model`，搜索 `magpie`，选择模型。模型选择器中按 `Ctrl+S` 可保存默认模型。

## 方式二：环境变量

```sh
export MAGPIE_BASE_URL='https://magpie.example.com/v1'
read -rsp 'Magpie gateway key: ' MAGPIE_API_KEY; echo
export MAGPIE_API_KEY
pi
```

以上 `read` 示例适用于 Bash。环境变量优先于配置文件。**首次配置后，先在交互式 Pi 中运行 `/magpie refresh` 建立本地模型缓存**，之后即可非交互运行：

```sh
pi --list-models magpie
pi --provider magpie --model '你的服务商/模型ID' -p '你好'
```

修改环境变量后重启 Pi；子进程不能修改正在运行的 Pi 的环境。设置了任意 Magpie 环境变量时，`/magpie setup` 会提示先移除变量，避免保存的设置被悄悄覆盖。

也可以手动创建私有配置（务必 `chmod 600 ~/.pi/agent/magpie.json`）：

```json
{
  "baseUrl": "https://magpie.example.com/v1",
  "apiKey": "替换为实际的 gateway key"
}
```

## 命令

| 命令 | 用途 |
| --- | --- |
| `/magpie` 或 `/magpie status` | 显示地址、已加载模型数、缓存更新时间及最近刷新错误，不显示密钥 |
| `/magpie setup` | 交互配置、验证连接并保存模型缓存 |
| `/magpie refresh` | 手动联网刷新并保存模型列表，失败时保留当前 provider 和旧缓存 |

### 缓存与启动

启动和 `/reload` **只读取本地模型缓存，不访问 Magpie 网络，也不后台刷新**。没有缓存、缓存损坏、或服务地址 / gateway key 发生变化时，不加载旧模型，并提示运行 `/magpie refresh`。首次使用默认 Magpie 模型或非交互命令前，需要先通过 `/magpie setup` 或 `/magpie refresh` 建立缓存。缓存没有有效期，更新模型目录须手动刷新。

`--help`、`--list-models`、离线启动以及 Pi 的自动模型目录刷新都不会向 Magpie 请求模型列表。显式 `/magpie setup` 和 `/magpie refresh` 是用户主动联网操作，即使 `PI_OFFLINE=1` 也可执行。缓存采用原子替换，保存模型元数据、更新时间和地址 / 凭据的 SHA-256 指纹，不含明文 gateway key。

手动刷新时读取 `/v1/models`，自动保留模型和路由组 ID，映射图片输入能力、上下文窗口、最大输出、思考级别和价格。只加载聊天模型，不把纯图片、视频、语音或分类模型放进 `/model`。未知窗口/输出上限使用 `128000` / `16384`；未知价格以 `0` 表示，**不代表实际免费**。实际账单以 Magpie / 上游为准。

第一版统一使用 `/v1/chat/completions`，复用 Pi 内置实现处理流式文本、工具调用、图片输入和取消。Magpie 负责上游协议转换；暂不按 `native_endpoints` 切换协议，不包含搜索、生图 MCP、额度面板或多网关管理。更改服务端目录后运行 `/magpie refresh`；不注册自动联网的 `refreshModels` 回调。手动请求模型列表超时为 10 秒，不自动跟随重定向，退出或重载时取消请求。

## VPS 端准备

在 VPS 上部署并运行 Magpie，配置好模型服务商，再开启网络共享并创建客户端 gateway key。上游供应商密钥留在 VPS，不需要复制到 Pi：

```sh
# 在 VPS 上执行；新凭证只显示一次，请妥善保存
magpie gateway-key add "Pi laptop"
```

本地 Magpie 接受的任意字符串 `magpie` **不是远程访问凭证**。远程必须使用实际签发的 gateway key，模型列表也受该 key 的模型权限限制。

**公网建议用 HTTPS 反向代理，或者通过 SSH 隧道访问。不要直接暴露管理后台，不要关闭鉴权来解决 401。** 代理要支持 SSE 流式响应，关闭缓冲，配置足够长的读取超时，并把 `/v1/*` 转发到网关。例如默认网关端口为 `3425`；自定义端口以 VPS 配置为准。

如果不想开放网关端口，可在客户端建立 SSH 隧道：

```sh
ssh -N -L 3425:127.0.0.1:3425 user@your-vps
```

然后在插件中使用 `http://127.0.0.1:3425/v1` 和 gateway key。HTTP 远程地址也可以使用，但插件会警告明文传输风险。

## 排错

- **401 / 403**：使用 VPS 签发的 gateway key，确认它未被禁用、未超预算，并有目标模型权限。
- **列表有模型但 `/model` 看不到**：检查 Pi 的模型范围设置；若已有 `models.json` 中的 `providers.magpie`，其地址、认证及模型覆盖可能优先于插件。先备份，再移除过期的 Magpie 条目，保留其他 provider，执行 `/reload`。
- **连接失败或不是 JSON**：使用网关地址而非后台页面地址，确认代理保留 `/v1/*`，地址不能是需要登录或跳转的网页。
- **能列模型但流式回复不正常**：检查代理的 SSE 缓冲和超时，再检查 Magpie 的请求日志及上游状态。

## 开发和验证

```sh
npm install --ignore-scripts
npm run check
```

测试覆盖配置优先级、私有凭证保存、模型元数据、缓存校验与隔离、零网络启动、手动刷新及失败保留、模型发现认证、超时/取消、重定向拒绝、错误脱敏、初始化和交互配置。流式测试通过模拟网关运行真实 Pi；不代替对实际 VPS 和各上游模型的联调。

服务端接口依据：Magpie 的 `docs/integrating.md` 和 `internal/gateway/gateway.go`。
