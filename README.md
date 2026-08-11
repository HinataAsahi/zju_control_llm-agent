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
- Stage 2B 入口可为 T1、T2、T6、T7 准备隔离工作区，运行 `Explicit`、`Description` 或 `Skill` 条件烟雾实验并写入本地记录；
- 本地 Schema 与 Zod 负责最终答案校验，供应商返回的内容不会未经验证直接成为实验结果。

当前真实运行固定使用 `deepseek-v4-flash`，关闭思考模式和 SDK 自动重试，并设置以下边界：最多 5 轮、最多 4 次 MCP 调用、单次模型请求 60 秒、整次运行 120 秒。额外的一轮用于在工具调用额度耗尽后提交最终答案，不会放宽工具调用次数。只要一轮同时出现文本和函数调用，我会优先执行工具并丢弃该轮的未完成文本，等待后续纯文本终局。

自建 API Runner 不具备 Codex 的自动 Skill 发现机制。`Description` 条件只使用公共任务提示和 MCP 工具描述；`Skill` 条件复用相同任务提示、工具定义和输出 Schema，并把工作区内隔离复制的 `SKILL.md` 追加到模型 instructions。测试会比较两种条件的请求结构，确保除 Skill instructions 外没有其他输入差异。

联调过程中，我发现 DeepSeek 的 `json_schema` 请求虽然能被接口接受，但工具调用后的最终输出并不稳定，曾出现 Markdown 围栏、块外说明、额外字段、混合工具调用，甚至疑似复述 Schema。最终我改用 DeepSeek 官方 JSON Output 指南建议的 `json_object` 模式，在提示中给出不包含任务答案的三字段 JSON 示例，再由本地严格校验兜底。解析边界仍拒绝不合法 JSON、多个候选对象和多个答案对象。

四个代表任务均已完成一次真实验证：

| 任务 | 验证路径 | 回合 | 工具调用 | 总 Token | 结果 |
|---|---|---:|---:|---:|---|
| T1 | 内联 JSON | 2 | 1 | 1469 | 返回 `3` |
| T2 | JSON 文件输入 | 4 | 3 | 3474 | 返回 `Alice/Carol/Dave` |
| T6 | 缺失文件 | 2 | 1 | 1392 | 返回 `cannot_complete` |
| T7 | jq 错误恢复 | 5 | 4 | 4786 | 先触发语法错误，再修正并返回 `3` |

T2 的首次工程联调在第四个回合取得了正确工具结果，但因为“最大回合数”和“最大工具调用数”当时都为 4，执行器没有剩余回合接收最终答案。该次失败消耗 3576 Token。修复后最大回合数调整为 5，工具调用上限仍为 4，并增加了“连续四个工具回合后仍可提交最终答案”的回归测试。

在三种条件可以独立控制后，我又对 T2 文件查询和 T7 错误恢复各执行了一次 Description 与 Skill 真实观测，并以已有的 Explicit 结果作为基线：

| 任务 | 条件 | 回合 | 工具调用 | 总 Token | 答案成功 | 恢复成功 | 观察到的路径 |
|---|---|---:|---:|---:|---|---|---|
| T2 | `Explicit` | 4 | 3 | 3474 | 是 | 不适用 | 读取结构后筛选出三个活跃用户 |
| T2 | `Description` | 3 | 2 | 2317 | 是 | 不适用 | 先读取完整对象，再直接筛选 |
| T2 | `Skill` | 5 | 4 | 6683 | 是 | 不适用 | 两次运行时错误后检查结构并修正 |
| T7 | `Explicit` | 5 | 4 | 4786 | 是 | 是 | 按要求触发语法错误并恢复 |
| T7 | `Description` | 1 | 0 | 640 | 否 | 否 | 把故意的无效过滤器误判为无法完成，未调用工具 |
| T7 | `Skill` | 5 | 4 | 6803 | 是 | 是 | 触发语法错误，继续检查数据结构并修正 |

这里的“答案成功”只校验最终结构化答案，“恢复成功”则单独检查 T7 是否先以过滤器 `if` 得到 `JQ_SYNTAX_ERROR`，随后至少有一次成功的 `jq_query` 调用。这样可以避免模型碰巧给出正确数字时被误认为完成了恢复任务。T7 Description 的请求和工具连接均正常，因此这条失败保留为模型决策观察，不做自动重试。

这六条数据仍然只是每个组合的一次观察。它们说明当前模型在这次运行中对 Skill 的处理更长、更依赖试错，也说明工具描述本身没有保证 T7 的指令遵从；但它们不能证明 Skill 必然增加 Token，或必然改善错误恢复。可靠比较还需要固定配置后的重复采样与不确定性统计。

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

Stage 2B 支持 T1、T2、T6、T7 和 `Explicit`、`Description`、`Skill` 三种条件。省略参数时默认运行 T1/Explicit；为了避免密钥进入命令历史，我会先通过隐藏输入读取密钥，再仅为当前进程传入：

```bash
read -rsp "DeepSeek API key: " DEEPSEEK_API_KEY && printf '\n'
DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" npm run experiment:stage2b -- smoke --task T2 --condition skill
unset DEEPSEEK_API_KEY
```

`--task` 可取 `T1`、`T2`、`T6` 或 `T7`，`--condition` 可取 `explicit`、`description` 或 `skill`。命令会产生 DeepSeek API 费用；命令行只输出运行摘要，详细记录保存在已忽略的本地目录中。Stage 2B 不会自动重试失败请求，避免基础设施错误造成不可见的额外费用。

在批量执行前，我可以先生成完全离线的实验计划：

```bash
npm run experiment:stage2b -- plan --repetitions 2
```

`plan` 固定展开 T2、T7 与三种条件的笛卡尔积，`--repetitions` 接受 `1..100` 的整数，默认为 1。它不读取 API 密钥、不连接 MCP、不会创建本地运行记录，也不会产生费用。新计划固定 `sampling.temperature: 0`，减少条件对比中的随机性；输出中的 `totalRuns` 是计划实验数，`upperBounds.modelRequests` 和 `upperBounds.toolCalls` 分别按每次实验最多 5 轮、4 次工具调用计算，是理论安全上限而不是实际用量或费用预测。

确认规模后，我可以把相同计划冻结为一个本地批次清单：

```bash
npm run experiment:stage2b -- prepare --repetitions 2
```

`prepare` 同样不读取密钥、不连接模型或 MCP，也不会执行实验。它在 `.experiment-runs/stage-2b/batches/<batch-id>/manifest.json` 保存模型配置、采样温度、运行限制和稳定的 `runKey`，所有实验项初始为 `pending`。批次目录权限为 `0700`，清单文件为 `0600`；清单和后续状态仍属于本地实验记录，不会提交到 GitHub。执行阶段将复用这份清单，并让每个条目依次经过 `pending`、`running` 和终态，以支持中断后的断点恢复。旧清单没有采样字段时会被解释为 `temperature: null`，继续省略请求参数并使用供应商默认值，不会伪装成温度 0 实验。

准备好 API 密钥后，我可以只执行指定批次中的第一个 `pending` 条目：

```bash
npm run experiment:stage2b -- run-next --batch <batch-id>
```

`run-next` 会产生 DeepSeek API 费用。它每次最多处理一个条目，并在读取密钥和调用 API 前把该条目原子更新为 `running`，同时预分配 `recordRunId`；运行结束后先保存标准 Stage 2B `record.json`，再更新清单终态。模型答案错误属于有效观察，记录为 `completed` 并保留 `taskSuccess: false`；基础设施、协议、模型输出格式或限制错误记录为 `failed`。两种终态都不会被下一次 `run-next` 自动重试。

每次 `run-next` 启动时会先对账。如果清单存在 `running` 条目且对应记录已经落盘，它只修复清单并返回 `reconciled`，不会读取密钥或继续执行下一个条目；如果记录尚不存在，它返回 `blocked-by-running`，避免无法判断前一次请求结果时重复付费。领取任务时使用批次目录内的短时原子锁串行化清单事务；同一批次的并发领取只有一个能成功，其余调用会在读取密钥和请求模型前被拒绝。锁不包围模型请求，因此不会因一次付费调用持续占用；当前版本仍不会自动重置没有记录的 `running` 条目。

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

Stage 2B 已完成四类 Explicit 代表路径、T2/T7 的 Description/Skill 真实单次对比，以及计划预览、私有批次清单、并发领取保护、单条顺序执行、中断对账和采样温度记录。下一步将逐项执行冻结的批次，先检查每次真实运行的记录质量，再生成脱敏的结构化汇总与带不确定性说明的统计报告。
