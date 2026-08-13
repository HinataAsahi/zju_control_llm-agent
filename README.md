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
- Stage 2B 入口可为 T1、T2、T6、T7、T9、T10、T11 准备隔离工作区，运行 `Explicit`、`Description` 或 `Skill` 条件烟雾实验并写入本地记录；
- 批次执行器可以冻结实验矩阵、逐项领取任务、处理中断对账，并从私有记录生成脱敏的公开报告；
- 本地 Schema 与 Zod 负责最终答案校验，供应商返回的内容不会未经验证直接成为实验结果。

当前新建的真实运行固定使用 `deepseek-v4-flash`，关闭思考模式和 SDK 自动重试，并设置以下边界：最多 6 轮、最多 5 次 MCP 调用、单次模型请求 60 秒、整次运行 120 秒。额外的一轮用于在工具调用额度耗尽后提交最终答案，不会放宽工具调用次数。只要一轮同时出现文本和函数调用，我会优先执行工具并丢弃该轮的未完成文本，等待后续纯文本终局。

自建 API Runner 不具备 Codex 的自动 Skill 发现机制。`Description` 条件只使用公共任务提示和 MCP 工具描述；`Skill` 条件复用相同任务提示、工具定义和输出 Schema，并把工作区内隔离复制的 `SKILL.md` 追加到模型 instructions。测试会比较两种条件的请求结构，确保除 Skill instructions 外没有其他输入差异。

联调过程中，我发现 DeepSeek 的 `json_schema` 请求虽然能被接口接受，但工具调用后的最终输出并不稳定，曾出现 Markdown 围栏、块外说明、额外字段、混合工具调用，甚至疑似复述 Schema。最终我改用 DeepSeek 官方 JSON Output 指南建议的 `json_object` 模式，在提示中给出不包含任务答案的三字段 JSON 示例，再由本地严格校验兜底。解析边界仍拒绝不合法 JSON、多个候选对象和多个答案对象。

我先运行了一个供应商默认温度、5 轮/4 次工具调用预算的 pilot 批次。六项中只有 2 项完成，另有 4 项因预算耗尽而中止；其中三项在最后一次允许调用后已经形成了正确查询，但没有额度继续执行或提交终局。这说明原预算会截断仍在正常推进的轨迹，因此我把新批次调整为 6 轮/5 次工具调用，并固定 `temperature: 0`。

校准后的 T2/T7 × 三种条件批次已经完成：

| 任务 | 条件 | 状态 | 回合 | 工具调用 | 总 Token | 答案成功 | 恢复成功 |
|---|---|---|---:|---:|---:|---|---|
| T2 | `Explicit` | completed | 4 | 3 | 3459 | 是 | 不适用 |
| T2 | `Description` | completed | 4 | 3 | 3406 | 是 | 不适用 |
| T2 | `Skill` | completed | 4 | 3 | 5075 | 是 | 不适用 |
| T7 | `Explicit` | completed | 5 | 4 | 4773 | 是 | 是 |
| T7 | `Description` | completed | 5 | 4 | 4730 | 是 | 是 |
| T7 | `Skill` | completed | 5 | 4 | 6810 | 是 | 是 |

校准批次 6/6 完成且答案正确，三个 T7 条件都先触发指定的 `JQ_SYNTAX_ERROR`，随后通过成功的 `jq_query` 调用完成恢复。总计使用 27 个模型回合、21 次工具调用和 28253 Token。T2 三种条件都走了“错误查询 -> 检查数据结构 -> 正确查询”的三次调用路径；在这一次观测中，Skill 没有减少调用次数，但由于附加了参考材料，其 T2 和 T7 Token 均高于另外两个条件。

完成首轮审阅后，我在相同模型、温度 0、6/5 预算、任务和提示材料下，为每个组合再执行两次。与 calibrated 基线合并后，每个“任务 × 条件”共有三次观测：

| 任务 | 条件 | 答案成功 | 恢复成功 | 回合 min-max / mean | 工具调用 min-max / mean | Token min-max / mean |
|---|---|---:|---:|---:|---:|---:|
| T2 | `Explicit` | 3/3 | 不适用 | 4-4 / 4 | 3-3 / 3 | 3459-3459 / 3459 |
| T2 | `Description` | 3/3 | 不适用 | 4-4 / 4 | 3-3 / 3 | 3406-3406 / 3406 |
| T2 | `Skill` | 3/3 | 不适用 | 4-4 / 4 | 3-3 / 3 | 5075-5097 / 5085.33 |
| T7 | `Explicit` | 3/3 | 3/3 | 5-5 / 5 | 4-4 / 4 | 4773-4793 / 4780.67 |
| T7 | `Description` | 3/3 | 3/3 | 5-5 / 5 | 4-4 / 4 | 4730-4736 / 4732 |
| T7 | `Skill` | 3/3 | 3/3 | 5-5 / 5 | 4-4 / 4 | 6810-6810 / 6810 |

新增的 12 条 repeat 观测使用 56566 Token；固定配置的 18 条观测合计使用 84819 Token。六个单元格的答案、恢复、回合数和工具调用数没有波动，Token 计数差异也很小。当前数据稳定地描述了这组任务上的执行路径，但样本和任务覆盖仍小，不能据此证明三种条件在更广泛任务上的稳定优劣。pilot 与 calibrated 又同时改变了温度和调用预算，因此两者之间的完成率差异仍不能归因于单一变量。

为了从“答案是否正确”继续深入到“模型为什么选择这条工具路径”，我新增了独立的 `diagnostic-v1` 任务套件。它不改动原有 Stage 2A 任务，而是在 `experiments/stage-2b/tasks/` 中增加三个边界更清晰的诊断任务：

- T9 是纯文本问题，用于观察模型能否识别 `jq_query` 不适用并避免工具调用；
- T10 是可由一次复合 jq 查询完成的聚合问题，用于观察模型能否直接构造目标查询；
- T11 不再强制制造语法错误，而是让模型面对容易误判的 JSON 根结构，用于区分“先检查再查询”和“查询失败后恢复”。

我为诊断套件固定了交错执行顺序，使同一任务和同一条件不会连续出现，并继续使用 `deepseek-v4-flash`、温度 0、6 轮/5 次工具调用的预算。首轮 9 条真实观测全部完成且答案正确，但工具合规为 7/9：T9 的 `Explicit` 条件没有调用工具，而 `Description` 和 `Skill` 条件都进行了不必要的 jq 调用。T10 的三个条件都用一次目标查询完成任务。T11 的 `Explicit` 和 `Description` 条件先检查根结构再查询；`Skill` 条件先触发 `JQ_RUNTIME_ERROR`，随后检查结构并成功重试。

| 任务 | 条件 | 策略 | 工具合规 | 回合 | 工具调用 | 总 Token |
|---|---|---|---|---:|---:|---:|
| T9 | `Explicit` | avoided-tool | 是 | 1 | 0 | 653 |
| T9 | `Description` | unnecessary-tool | 否 | 2 | 1 | 1563 |
| T9 | `Skill` | unnecessary-tool | 否 | 3 | 2 | 3676 |
| T10 | `Explicit` | one-shot-query | 是 | 2 | 1 | 1658 |
| T10 | `Description` | one-shot-query | 是 | 2 | 1 | 1632 |
| T10 | `Skill` | one-shot-query | 是 | 2 | 1 | 2469 |
| T11 | `Explicit` | inspect-first | 是 | 3 | 2 | 2508 |
| T11 | `Description` | inspect-first | 是 | 3 | 2 | 2461 |
| T11 | `Skill` | recovered-after-error | 是 | 4 | 3 | 5384 |

这一批共使用 22 个模型回合、13 次工具调用和 22004 Token，其中输入 Token 为 20160、缓存命中输入 Token 为 16000、输出 Token 为 1844。当前结果说明三个条件在工具边界、过程策略和成本上出现了值得复核的差异，但每个单元格仍只有一次观测，不能据此判断这些差异是否稳定，更不能把差异单独归因于 Skill。

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
- `experiments/stage-2b/results/observations.json`：pilot 与 calibrated 批次的脱敏结构化汇总；
- `experiments/stage-2b/results/report.zh.md`：Stage 2B 配置、逐项指标、脱敏工具调用路径和解读边界。
- `experiments/stage-2b/results/diagnostic-v1/observations.json`：9 条诊断观测及其工具合规、首次调用结果和过程策略；
- `experiments/stage-2b/results/diagnostic-v1/report.zh.md`：诊断套件的逐项结果、成本与解读边界。

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

Stage 2B 支持 T1、T2、T6、T7、T9、T10、T11 和 `Explicit`、`Description`、`Skill` 三种条件。省略参数时默认运行 T1/Explicit；为了避免密钥进入命令历史，我会先通过隐藏输入读取密钥，再仅为当前进程传入：

```bash
read -rsp "DeepSeek API key: " DEEPSEEK_API_KEY && printf '\n'
DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" npm run experiment:stage2b -- smoke --task T2 --condition skill
unset DEEPSEEK_API_KEY
```

`--task` 可取 `T1`、`T2`、`T6`、`T7`、`T9`、`T10` 或 `T11`，`--condition` 可取 `explicit`、`description` 或 `skill`。命令会产生 DeepSeek API 费用；命令行只输出运行摘要，详细记录保存在已忽略的本地目录中。Stage 2B 不会自动重试失败请求，避免基础设施错误造成不可见的额外费用。

在批量执行前，我可以先生成完全离线的实验计划：

```bash
npm run experiment:stage2b -- plan --repetitions 2
```

`plan` 固定展开 T2、T7 与三种条件的笛卡尔积，`--repetitions` 接受 `1..100` 的整数，默认为 1。它不读取 API 密钥、不连接 MCP、不会创建本地运行记录，也不会产生费用。新计划固定 `sampling.temperature: 0`，减少条件对比中的随机性；输出中的 `totalRuns` 是计划实验数，`upperBounds.modelRequests` 和 `upperBounds.toolCalls` 分别按每次实验最多 6 轮、5 次工具调用计算，是理论安全上限而不是实际用量或费用预测。

通过 `--suite diagnostic-v1`，我可以离线查看诊断套件的交错执行计划：

```bash
npm run experiment:stage2b -- plan --suite diagnostic-v1 --repetitions 1
```

确认规模后，我可以把相同计划冻结为一个本地批次清单：

```bash
npm run experiment:stage2b -- prepare --repetitions 2
```

诊断批次使用相同的冻结和断点恢复机制：

```bash
npm run experiment:stage2b -- prepare --suite diagnostic-v1 --repetitions 1
```

`prepare` 同样不读取密钥、不连接模型或 MCP，也不会执行实验。它在 `.experiment-runs/stage-2b/batches/<batch-id>/manifest.json` 保存模型配置、采样温度、运行限制和稳定的 `runKey`，所有实验项初始为 `pending`。批次目录权限为 `0700`，清单文件为 `0600`；清单和后续状态仍属于本地实验记录，不会提交到 GitHub。执行阶段将复用这份清单，并让每个条目依次经过 `pending`、`running` 和终态，以支持中断后的断点恢复。旧清单没有采样字段时会被解释为 `temperature: null`，继续省略请求参数并使用供应商默认值，不会伪装成温度 0 实验；旧清单冻结的 5 轮、4 次调用限制也会原样保留，新预算不会回写历史批次。

准备好 API 密钥后，我可以只执行指定批次中的第一个 `pending` 条目：

```bash
npm run experiment:stage2b -- run-next --batch <batch-id>
```

`run-next` 会产生 DeepSeek API 费用。它每次最多处理一个条目，并在读取密钥和调用 API 前把该条目原子更新为 `running`，同时预分配 `recordRunId`；运行结束后先保存标准 Stage 2B `record.json`，再更新清单终态。模型答案错误属于有效观察，记录为 `completed` 并保留 `taskSuccess: false`；基础设施、协议、模型输出格式或限制错误记录为 `failed`。两种终态都不会被下一次 `run-next` 自动重试。

每次 `run-next` 启动时会先对账。如果清单存在 `running` 条目且对应记录已经落盘，它只修复清单并返回 `reconciled`，不会读取密钥或继续执行下一个条目；如果记录尚不存在，它返回 `blocked-by-running`，避免无法判断前一次请求结果时重复付费。领取任务时使用批次目录内的短时原子锁串行化清单事务；同一批次的并发领取只有一个能成功，其余调用会在读取密钥和请求模型前被拒绝。锁不包围模型请求，因此不会因一次付费调用持续占用；当前版本仍不会自动重置没有记录的 `running` 条目。

两个批次都进入终态后，我可以完全离线地生成公开汇总：

```bash
npm run experiment:stage2b -- report --pilot-batch <pilot-batch-id> --calibrated-batch <calibrated-batch-id> --repeat-batch <repeat-batch-id>
```

`report` 不读取 API 密钥，不创建模型客户端，也不会连接 MCP。它逐条校验清单与记录的任务、条件、结果、模型、温度和预算，然后原子写入 `experiments/stage-2b/results/observations.json` 与 `report.zh.md`。`--repeat-batch` 可省略；提供后，只有与 calibrated 配置完全一致的批次才能合并，报告会按任务和条件给出固定配置的样本数、成功计数、范围与均值。公开文件不包含原始模型响应、工具参数、工具输出、最终答案解释、记录 ID、绝对路径或凭据。旧记录缺少采样字段时与旧清单一致地解释为供应商默认温度。

对于已经结束的诊断批次，我使用单批次报告命令生成版本 4 脱敏结果：

```bash
npm run experiment:stage2b -- report --batch <diagnostic-batch-id>
```

诊断报告除答案正确性外，还给出工具合规、首次调用结果、归一化策略、脱敏调用路径、回合数、工具调用数和 Token 用量。恢复成功只在 T11 确实先观察到错误输出、之后又执行了成功重试时才计入；先检查结构并避免错误会归类为 `inspect-first`，不会被误算成错误恢复。

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
experiments/stage-2b/results/    Stage 2B 脱敏批次汇总与报告
experiments/stage-2b/tasks/      Stage 2B 独立诊断任务与固定输入
docs/learning-notes/             前期学习材料
```

## 下一步

我已完成 Stage 2B 的 pilot、预算校准、固定配置重复观测，以及首轮 `diagnostic-v1` 真实运行。版本 4 诊断报告把任务成功与过程行为分开：答案正确不代表工具选择合规，错误预防也不等同于错误后恢复。

首轮诊断中，T9 的三个条件在是否调用不适用工具上不同，T11 的 `Skill` 条件也表现出不同于另外两个条件的恢复路径；对应回合数、工具调用数和 Token 成本均有差异。按照预先确定的决策规则，这些差异足以进入复核阶段。

下一步我将保持模型、温度、预算、任务、提示材料和交错顺序不变，对 `diagnostic-v1` 再执行两轮完整重复，使每个“任务 × 条件”达到三次观测。随后我会重新生成版本 4 报告，检查工具合规和策略差异是否复现，再决定是扩展任务覆盖，还是调整 Skill 内容进行更有针对性的对照；暂不同时改变温度或模型，以避免混入新的解释变量。
