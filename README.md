# LLM Agent 工具调用实验

## 项目背景

一位老师联系我后，我开始通过这个个人项目了解 LLM Agent、MCP、工具调用与行为评测，并判断自己是否对这一方向感兴趣。本项目不代表我参加过任何夏令营，也不是夏令营准备项目。

我的探索分成两个阶段：第一阶段先实现一个真实可用、边界明确的 `jq` MCP Server；第二阶段把它接入 Codex，观察提示方式如何影响 Agent 的工具选择、调用正确性和错误恢复。这样我先接触一线行为，再决定后续是否值得投入到自定义 API 实验执行器与更系统的重复评测中。

## 我完成了什么

### Stage 1：实现受限的 jq MCP Server

我使用 TypeScript 实现了一个通过 stdio 通信的 MCP Server，并提供 `jq_query` 工具。工具可以处理内联 JSON，也可以读取指定根目录内的 JSON 文件。

我没有把它当作任意命令执行器，而是限定了输入和执行边界：

- 文件路径只能位于启动时确定的允许根目录内；
- 文件检查和读取绑定到同一个文件句柄，并拒绝最终路径分量中的符号链接；
- JSON 通过标准输入传给 jq，子进程使用 `shell: false`；
- 过滤器、输入、输出、JSON 深度和执行时间均有限制；
- 错误以稳定的结构化错误码返回，不向调用方泄露内部路径和未知异常细节。

这些措施提供的是有边界的工具执行，不等同于完整的操作系统沙箱或容器隔离。允许根目录仍不应由不受信任的进程在服务运行期间并发修改。

当前资源限制为：

- jq 过滤器最多 4 KiB（UTF-8）；
- 输入、标准输出与标准错误分别受 1 MiB 上限约束；
- 内联 JSON 和结构化输出最多嵌套 128 层（根值深度为 0）；
- jq 执行超时为 5 秒；
- jq 子进程只继承最小化环境变量，也不能接收任意 jq 命令行标志。

### Stage 2A：观察 Agent 如何决定是否使用工具

我先选用 Codex CLI 作为现成 MCP 客户端，而没有立即自行实现 API Runner。这样可以先观察真实 Agent 在工具发现、工具选择、Shell 替代路径和错误恢复中的行为，把后续自定义执行器需要控制和记录的变量弄清楚。

我设计了三种条件：

| 条件 | Agent 获得的信息 |
|---|---|
| `Explicit` | 提示词明确要求使用或避免 `jq_query` |
| `Description` | 只提供 MCP Server 自带的工具描述 |
| `Skill` | 在相同任务提示和工具描述之外，再提供一份 jq 参考 Skill |

实验包含 8 个确定性任务，覆盖内联 JSON、文件查询、聚合、缺失文件、语法错误恢复和不应调用 jq 的文本任务。正式阶段对每个“任务 × 条件”执行一次，共得到 24 条观察。T3 和 T7 还额外用于人工 TUI 体验，但这两次体验不进入正式数据。

执行器会为每次运行创建隔离工作区，只复制该任务需要的输入文件；`Skill` 条件才会安装参考 Skill。它以只读沙箱启动 Codex，流式记录 JSONL 和 stderr，解析 MCP 调用、Shell 命令、最终答案与 Token 用量，并将模型行为错误和基础设施错误分开处理。

## 本次观察结果

我先按固定阶梯校准模型。较低配置在混合路径或错误恢复任务上没有全部达到门槛，最终选择了 `gpt-5.6-terra / medium`。正式运行使用 Codex CLI 0.147.0，24/24 条轨迹均有效且答案正确，没有基础设施失败或待人工复核项。

最值得注意的是非显式条件下的工具选择：

| 条件 | 任务成功 | T1-T6 主动选择 MCP | 主要替代路径 |
|---|---:|---:|---|
| `Description` | 8/8 | 0/6 | Shell、直接读文件、直接作答 |
| `Skill` | 8/8 | 5/6 | MCP 与 Shell 混合路径较多 |

`Explicit` 条件对 8/8 个任务都遵从了使用或避免工具的要求。三个条件在 T7 中都完成了“先触发 jq 语法错误，再修正调用”的恢复过程，也都在 T8 文本任务中避免了调用 `jq_query`。所有实际发生的 14 次首次 MCP 调用，其输入结构都符合工具 schema。

这些数据表明，在这组单次观察中，Skill 条件下出现了更多 MCP 选择，而只有工具描述时，模型更倾向于寻找其他可行路径。它不能证明 Skill 导致了这一差异：每个组合只有一次运行，任务集规模小，而且 Codex 本身还拥有 Shell 和文件读取能力。后续要进行统计比较，需要固定更多环境变量、重复采样并报告不确定性。

完整的公开结果位于：

- `experiments/stage-2a/results/observations.json`：24 条脱敏结构化观察；
- `experiments/stage-2a/results/report.zh.md`：指标、代表案例与局限说明。

原始 JSONL、stderr、临时工作区和校准记录位于本机 `.experiment-runs/`，不会提交到 GitHub。

## 环境与安装

我在 Linux/WSL 环境完成了当前验证，使用以下主要版本：

- Node.js 24 LTS；
- jq 1.8.2，或兼容的 jq 1.8.x；
- Codex CLI 0.147.0（仅 Stage 2A 实验需要）。

安装锁定依赖并运行完整测试：

```bash
npm ci
npm test
```

## 使用 jq MCP Server

构建后直接启动服务：

```bash
npm run build
npm start -- --root ./fixtures
```

也可以使用仓库中的配置打开 MCP Inspector 2.0.0：

```bash
npx @modelcontextprotocol/inspector@2.0.0 --web --config ./inspector.config.json
```

连接 `jq-mcp-server` 后，在 **Tools** 中选择 `jq_query`。Inspector 2.0.0 会把判别式 `source` 联合渲染成一个 JSON 文本框，需要粘贴完整的 `source` 对象。

内联 JSON 示例：

```json
{"filter":".users | length","source":{"type":"inline","data":{"users":[1,2,3]}}}
```

受限根目录中的文件示例：

```json
{"filter":"[.orders[] | select(.total >= 100)] | length","source":{"type":"file","path":"orders.json"}}
```

路径 `../outside.json` 会返回 `PATH_NOT_ALLOWED`，过滤器 `if` 会返回 `JQ_SYNTAX_ERROR`。

## 复现实验

以下命令会调用本机 Codex，并产生 Token 消耗。原始输出默认写入已忽略的 `.experiment-runs/`。

```bash
# 检查环境与 MCP 连通性
npm run experiment -- smoke

# 按预设阶梯选择首个通过 T1/T4/T7 的模型配置
npm run experiment -- calibrate

# 生成或启动不计分的人工体验任务
npm run experiment -- experience --task T3
npm run experiment -- experience --task T7 --launch

# 顺序执行正式观察；--resume 只补缺失或基础设施失败的组合
npm run experiment -- formal --resume

# 从本地结构化观察生成报告
npm run experiment -- report
```

`formal` 会校验请求配置与保存的校准结果是否一致，避免无意中混用模型。正式观察按顺序执行，不能把 24 次单次观察解释为独立重复试验。

## 项目结构

```text
src/mcp/                         jq MCP Server
src/experiment/                  Codex 实验执行、解析与评测
test/mcp/                        MCP Server 测试
test/experiment/                 实验基础设施测试
experiments/stage-2a/tasks/      任务定义与固定输入
experiments/stage-2a/prompts/    三种条件使用的提示材料
experiments/stage-2a/reference-skill/
                                 Skill 条件使用的 jq 参考 Skill
experiments/stage-2a/results/    可公开的脱敏观察与报告
docs/learning-notes/             前期学习材料
```

## 下一步

我计划在理解这批一线轨迹后，再实现自定义 API Runner。下一阶段重点不是简单增加任务数量，而是控制重复次数、随机性、可用工具和上下文，记录每次决策过程，并用置信区间等方式区分偶然行为与较稳定的条件差异。
