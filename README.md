# jq MCP Server

## 项目背景

一位老师联系作者后，作者完成了这个个人前置探索项目，用于理解相关领域并判断自己是否感兴趣。本项目不代表参加过任何夏令营，也不是夏令营准备项目。

## 当前范围

服务当前提供一个手工设计的 `jq_query` 工具。它不包含 LLM、自动生成工具、自主评估或纠错循环，也尚未提供完整的临时沙箱。

## 前置条件

- Node.js 24 LTS
- npm
- jq 1.8.2，或兼容的 jq 1.8.x

当前运行与测试验证覆盖 Linux 和 WSL 环境，尚未验证 Windows 原生环境。

可通过以下命令确认版本：

```bash
node --version
jq --version
```

## 安装与验证

在项目根目录执行：

```bash
npm install
npm run build
npm test
```

需要使用锁定依赖进行可重复安装时，改用 `npm ci`。

## 启动与 Inspector

构建完成后，在项目根目录使用配置文件启动 MCP Inspector：

```bash
npx @modelcontextprotocol/inspector@2.0.0 --web --config ./inspector.config.json
```

打开 Inspector 后，切换并连接 `jq-mcp-server`，再打开 **Tools** 并选择 `jq_query`。`source` 是同一个字段的两个可选分支，内联数据和文件数据是替代关系，不是需要连续执行的两次调用。

### Inspector 2.0.0 兼容性说明

Inspector 2.0.0 将判别式 `source` 联合渲染为一个通用 JSON 文本框，而不是分别显示 inline/file 控件。请在该文本框粘贴完整的 `source` 对象，例如 `{"type":"inline","data":{"users":[1,2,3]}}` 或 `{"type":"file","path":"orders.json"}`。直接在 Web 命令后附加 node 目标不会预填服务列表，请使用上面的配置文件命令。

内联 JSON：

```json
{"filter":".users | length","source":{"type":"inline","data":{"users":[1,2,3]}}}
```

受限根目录中的文件：

```json
{"filter":"[.orders[] | select(.total >= 100)] | length","source":{"type":"file","path":"orders.json"}}
```

## 手动示例

使用内联输入和过滤器 `.users | length`，结果为 `3`。

服务以上述命令启动时，文件输入 `orders.json` 位于 `fixtures` 中。过滤器 `[.orders[] | select(.total >= 100)] | length` 的结果为 `3`：四笔订单中金额分别为 120、80、100、250，满足 `total >= 100` 的有三笔。

## 错误示例

- 文件路径 `../outside.json` 会返回 `PATH_NOT_ALLOWED`。
- 过滤器 `if` 会返回 `JQ_SYNTAX_ERROR`。

## 安全模型

服务在启动时确定并规范化允许读取的根目录，文件路径只能位于该根目录以下。文件检查和有界读取绑定到同一个打开的文件句柄；在支持 `O_NOFOLLOW` 的平台上，最终路径分量为符号链接时会被拒绝，包括仍指向根目录内部的链接。允许根目录在服务运行期间不得由不受信任的进程并发修改，因为 Node.js 没有提供可移植的 `openat` 祖先路径遍历，当前实现不保证抵御可变祖先目录上的所有竞争条件。JSON 通过标准输入传给 jq；子进程使用 `shell: false`，不接受任意 jq 标志。

限制如下：

- 过滤器最多 4 KiB（UTF-8）。
- 输入最多 1 MiB。
- 内联 JSON 和结构化输出最多嵌套 128 层（根值深度为 0）。
- 标准输出和标准错误的合计最多 1 MiB。
- jq 执行超时为 5 秒。
- 子进程使用最小化环境变量。
- 未知错误会使用安全的通用信息，不暴露内部细节。

这些措施提供的是有边界的执行，并非完整的操作系统或容器沙箱。

## 架构

- `src/mcp/server.ts`：解析启动配置、验证 jq，并注册 MCP 服务和工具。
- `src/mcp/jq-tool.ts`：编排来源解析、jq 执行与 MCP 工具结果。
- `src/mcp/source-resolver.ts`：解析内联 JSON 或受限根目录下的文件。
- `src/mcp/jq-executor.ts`：以受限参数和资源限制启动 jq，处理输出及错误。
- `src/mcp/jq-schema.ts`：定义工具输入、输出和错误码的 Zod schema。
- `test/mcp/`：覆盖配置、schema、来源解析、jq 执行、工具处理与 MCP stdio 集成。

## 测试命令

完整测试：

```bash
npm test
```

构建后可运行聚焦测试，例如：

```bash
node --test dist/test/mcp/jq-executor.test.js
node --test dist/test/mcp/mcp-server.test.js
```
