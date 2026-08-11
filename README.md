# LLM Agent 工具调用实验

## 技术目标

本项目研究 LLM Agent 如何发现、选择和调用 MCP 工具，并逐步实现可控的工具调用执行器与行为评测流程。技术路线分为三个连续阶段：Stage 1 实现边界明确的 `jq` MCP Server；Stage 2A 使用 Codex 观察提示方式对工具选择、调用正确性和错误恢复的影响；Stage 2B 自行实现 API Agent Runner，控制模型调用、MCP 调用、上下文回放、结果校验和运行记录。

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

### Stage 2B：实现最小 DeepSeek API Agent Runner

在看完 Stage 2A 的轨迹后，我开始实现自己的 API Runner。当前目标不是立刻替代 Codex，也不是马上执行大规模统计实验，而是先把一次可控的“模型决策 -> MCP 调用 -> 工具结果回传 -> 最终答案校验”闭环跑通。

我把实现拆成几个边界明确的组件：

- 与供应商无关的 Agent 循环负责轮次、工具调用、历史回放、超时和错误分类；
- `McpToolBridge` 通过 stdio 连接仓库中的 `jq` MCP Server，并把发现到的工具转换为模型可用的函数工具；
- DeepSeek 适配器使用官方 OpenAI SDK 7.4.0，指向 `https://api.deepseek.com` 的 Responses API；
- Stage 2B 入口可为 T1、T2、T6、T7 准备隔离工作区，运行 `Explicit` 条件烟雾实验并写入本地记录；
- 本地 Schema 与 Zod 负责最终答案校验，供应商返回的内容不会未经验证直接成为实验结果。

当前真实运行固定使用 `deepseek-v4-flash`，关闭思考模式和 SDK 自动重试，并设置以下边界：最多 4 轮、最多 4 次 MCP 调用、单次模型请求 60 秒、整次运行 120 秒。只要一轮同时出现文本和函数调用，我会优先执行工具并丢弃该轮的未完成文本，等待后续纯文本终局。

联调过程中，我发现 DeepSeek 的 `json_schema` 请求虽然能被接口接受，但工具调用后的最终输出并不稳定，曾出现 Markdown 围栏、块外说明、额外字段、混合工具调用，甚至疑似复述 Schema。最终我改用 DeepSeek 官方 JSON Output 指南建议的 `json_object` 模式，在提示中给出不包含任务答案的三字段 JSON 示例，再由本地严格校验兜底。解析边界仍拒绝不合法 JSON、多个候选对象和多个答案对象。

T1 真实烟雾运行通过：模型用 2 轮完成 1 次 `jq_query` 调用，返回答案 `3`。本次输入为 1325 Token，其中缓存命中 640 Token；输出为 144 Token，总计 1469 Token，运行约 3.4 秒。T2 文件输入、T7 错误恢复和 T6 缺失文件路径目前已通过“模拟模型 + 真实 MCP Server”的离线集成测试，尚未据此宣称真实模型表现。

## Stage 2A 观察结果

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

Stage 2B 的工作区和运行记录同样位于 `.experiment-runs/stage-2b/`。目录权限会收紧为 `0700`，记录文件为 `0600`；记录包含工具事件、状态、用量和脱敏诊断，但不保存 API 密钥。ChatGPT Plus 与 DeepSeek API 计费相互独立，运行 Stage 2B 前需要单独准备 `DEEPSEEK_API_KEY`。

## 环境与安装

我在 Linux/WSL 环境完成了当前验证，使用以下主要版本：

- Node.js 24 LTS；
- jq 1.8.2，或兼容的 jq 1.8.x；
- Codex CLI 0.147.0（仅 Stage 2A 实验需要）。
- DeepSeek API 密钥（仅 Stage 2B 真实烟雾运行需要）。

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

### 运行 Stage 2B 代表任务

Stage 2B 支持 T1、T2、T6、T7 的 `Explicit` 烟雾任务。省略 `--task` 时默认运行 T1；为了避免密钥进入命令历史，我会先通过隐藏输入读取密钥，再仅为当前进程传入：

```bash
read -rsp "DeepSeek API key: " DEEPSEEK_API_KEY && printf '\n'
DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" npm run experiment:stage2b -- smoke --task T2
unset DEEPSEEK_API_KEY
```

`--task` 可取 `T1`、`T2`、`T6` 或 `T7`。命令会产生 DeepSeek API 费用；命令行只输出运行摘要，详细记录保存在已忽略的本地目录中。Stage 2B 不会自动重试失败请求，避免基础设施错误造成不可见的额外费用。

## 项目结构

```text
src/mcp/                         jq MCP Server
src/agent/                       Agent 循环、DeepSeek 适配器与 MCP 桥接
src/experiment/                  Stage 2A/2B 实验执行、解析与评测
test/mcp/                        MCP Server 测试
test/agent/                      Agent 循环与供应商适配测试
test/experiment/                 实验基础设施测试
experiments/stage-2a/tasks/      任务定义与固定输入
experiments/stage-2a/prompts/    三种条件使用的提示材料
experiments/stage-2a/reference-skill/
                                 Skill 条件使用的 jq 参考 Skill
experiments/stage-2a/results/    可公开的脱敏观察与报告
docs/learning-notes/             前期学习材料
```

## 下一步

Stage 2B 已覆盖内联 JSON、文件输入、错误恢复和缺失文件四类代表路径。下一步先分别完成 T2、T7、T6 的真实单次验证并复核本地记录，再加入 `Description` 和 `Skill` 条件。代表路径稳定后，再实现重复次数、随机性记录、断点恢复和统计报告。
