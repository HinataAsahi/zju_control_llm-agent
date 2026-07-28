# CLI 工具自动 MCP 化与技能生成：方案准备学习笔记

日期：2026-07-28

本文服务于浙大控制学院夏令营考核题目 2：“CLI 工具的自动 MCP 化与技能生成”。目标不是马上确定最终实现，而是在写方案和代码之前，先建立一条清晰的概念链路：

```text
LLM Agent -> 工具调用 -> CLI 工具 -> MCP tools schema -> skill 文件
  -> 文档到 schema/skill 的生成 -> 沙箱执行 -> 自动评测
  -> 失败归因与反馈修正 -> 本项目最小可行系统
```

读完本文后，应能理解题目 2 到底在研究什么，以及后续项目为什么需要 pipeline、schema 校验、skill 说明、沙箱、任务集、自动判分和失败分析。

## 1. 从 LLM Agent 说起：为什么 agent 需要工具

普通 LLM 的基本能力是根据上下文生成文本。它可以解释概念、写代码、总结材料，但它本身并不会天然拥有实时数据库、文件系统、命令行程序、网页、企业系统或实验环境的真实访问能力。

Agent 的关键变化是：模型不只是“回答”，而是在一个循环中行动。典型过程包括：

- 观察用户任务和当前环境；
- 判断是否需要外部信息或外部操作；
- 选择一个工具；
- 生成工具参数；
- 接收工具执行结果；
- 根据结果继续推理、修正或完成任务。

因此，agent 能力的上限不只取决于模型参数，也取决于它能否正确使用外部工具。一个没有工具的模型，面对“统计这个目录下所有 JSON 文件里的字段分布”时只能给出建议；一个能调用文件系统、`jq`、`rg` 或 Python 的 agent，则可以真实完成任务并返回结果。

这正是题目 2 的出发点：如果 agent 要使用新工具，它需要知道工具“能做什么、怎么调用、什么时候该调用、调用失败后怎么办”。目前这些信息往往由人工写 MCP 工具描述、JSON Schema 或 skill 文件。题目 2 希望自动化这条链路。

## 2. 工具调用的基本模式：ReAct、function calling 与 tool use

理解 agent 工具调用，可以先看 ReAct。ReAct 的核心思想是把“推理”和“行动”交错起来：模型不是先在脑中想完所有步骤再一次性输出答案，而是在任务过程中一边推理、一边调用外部环境，再根据观察结果调整后续动作。ReAct 论文强调，行动让模型能接触外部知识或环境，推理则帮助模型规划、跟踪进度和处理异常。见 [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629)。

在工程系统里，这种模式通常表现为 tool calling 或 function calling。官方 OpenAI function calling 文档把工具调用拆成几个概念：应用向模型提供可用工具定义；模型在需要时返回 tool call；应用执行工具；应用再把 tool output 传回模型，模型据此生成最终回答。见 [OpenAI Function Calling](https://developers.openai.com/api/docs/guides/function-calling)。

这些机制说明一个事实：工具调用不是“模型直接执行代码”，而是模型、宿主应用和工具运行环境之间的一种协议。模型负责选择工具和生成参数，宿主应用负责验证、执行和返回结果。

这对本项目有两个启发：

- 工具接口必须结构清楚，否则模型很难稳定生成正确参数；
- 执行结果必须可观察、可记录，否则无法做自动评测和失败归因。

## 3. CLI 工具为什么适合作为研究对象

题目 2 选择 CLI 工具，而不是任意 API 或 GUI 软件，是有现实原因的。

CLI 工具通常具备几个优势：

- 文档容易获取：大多数 CLI 有 `--help`、man page、README 或 examples。
- 输入输出可文本化：参数、stdout、stderr、退出码都容易记录。
- 任务容易构造：可以在临时目录里准备文件，让工具处理后检查结果。
- 自动判分可行：输出文件、文本内容、JSON 字段、退出码都可以作为成功标准。
- 适合沙箱隔离：工具可以在受限目录、受限命令和受限时间内运行。

但 CLI 工具也有天然难点：

- 子命令多，例如 `git commit`、`git log`、`git diff` 的参数体系完全不同；
- 参数关系复杂，例如互斥参数、默认值、短参数和长参数；
- 文档不一定机器友好，`--help` 往往面向人类阅读；
- 一些命令有破坏性，例如删除文件、改写仓库、访问网络；
- 错误输出可能含混，需要经验才能定位原因。

因此，从 CLI 文档直接让模型“自己看懂并使用”，并不稳定。题目 2 的价值就在于：能否自动把人类文档转成 agent 更容易使用的结构化接口和操作经验。

## 4. MCP tools schema：把工具调用变成结构化接口

MCP，即 Model Context Protocol，是一种让模型宿主连接外部工具和数据源的协议。MCP tools 规范说明：服务器可以暴露能被语言模型调用的工具；工具用名称唯一标识，并带有描述和 schema。见 [MCP Tools Specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)。

在 MCP tools 里，一个工具定义通常包含：

- `name`：工具唯一名称；
- `title`：可选的人类可读名称；
- `description`：工具功能说明；
- `inputSchema`：输入参数的 JSON Schema；
- `outputSchema`：可选的输出结构；
- `annotations`：可选的工具行为标注；
- `execution`：可选的执行相关属性。

其中 `inputSchema` 是本项目最关键的部分。它把“工具参数应该长什么样”变成机器可读格式。例如参数是字符串、数字、布尔值还是数组，哪些字段必填，哪些字段不能额外出现，都可以通过 JSON Schema 表达。

这解决的是“怎么调用”的问题。没有 schema 时，模型看到的是一段 `--help` 文本；有 schema 后，模型面对的是明确的参数槽位和类型约束。宿主系统也可以在执行前检查参数是否符合 schema，从而减少无意义调用。

但 schema 不解决全部问题。它通常不能充分表达：

- 什么任务场景下应该调用这个工具；
- 多个参数怎样组合更可靠；
- 哪些子命令适合作为高频能力暴露；
- 哪些危险参数应该禁用；
- 工具失败后如何修正；
- 多个工具如何组合成工作流。

所以，schema 是必要的接口层，但不是完整的工具学习。

## 5. Skill 文件：补足 schema 之外的使用经验

Skill 可以理解为给 agent 的“可复用操作说明”。Anthropic 的 Agent Skills 文档把 skill 描述为基于文件系统的资源，用来提供特定领域的工作流、上下文和最佳实践；它们按需加载，避免每次对话都重复塞入完整说明。见 [Claude Agent Skills Overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)。

一个典型 skill 至少包含元数据和正文说明：

- 元数据告诉 agent：这个 skill 是什么，什么时候应该用；
- 正文说明告诉 agent：具体工作流、常用方法、注意事项、示例；
- 额外资源可以提供参考文档、脚本、模板或测试数据。

这与 MCP schema 形成互补：

- schema 像接口签名，强调参数结构和可验证性；
- skill 像操作手册，强调使用策略、经验和失败处理。

例如，对于一个图像转换 CLI，schema 可以说明参数 `input_path`、`output_path`、`format` 的类型；skill 则应该说明“先检查输入文件是否存在”“批量处理时保留原目录结构”“转换失败时查看 stderr 中的 codec 信息”“不要覆盖原文件，除非任务明确要求”。

题目 2 要生成的不只是 MCP schema，还包括 skill 文件。原因很直接：如果只生成 schema，模型可能会“会填参数”，但仍然不知道什么时候应该用、怎么组合调用、如何规避常见错误。

Voyager 也能帮助理解 skill 的意义。Voyager 在 Minecraft 环境中维护一个不断增长的技能库，把可执行代码形式的复杂行为保存和复用，并结合环境反馈、执行错误和自验证改进程序。见 [Voyager: An Open-Ended Embodied Agent with Large Language Models](https://arxiv.org/abs/2305.16291)。虽然 Voyager 的场景不是 CLI 工具，但它说明了一个共同思想：agent 不应每次从零开始解决任务，而应沉淀可复用、可组合、可检索的经验。

## 6. 从 CLI 文档生成 schema 和 skill：信息抽取的核心问题

从 CLI 文档到 schema/skill，本质上是一个文档理解和结构化生成问题。输入可能包括：

- `tool --help`；
- `tool subcommand --help`；
- README；
- 官方手册；
- 示例命令；
- 错误信息说明。

生成 MCP schema 时，至少需要抽取：

- 命令和子命令名称；
- 参数名称，包括短参数和长参数；
- 参数类型，例如 string、number、boolean、array、enum；
- 必填参数和可选参数；
- 默认值；
- 参数互斥关系；
- 参数依赖关系；
- 输入文件和输出文件；
- 退出码与错误含义。

生成 skill 时，则更关注策略信息：

- 这个工具适合解决哪些任务；
- 典型调用顺序是什么；
- 哪些参数组合最常用；
- 什么时候应该先检查文件或环境；
- 有哪些危险操作必须避免；
- 失败后优先检查什么；
- 多工具任务中它应该放在哪一步。

已有 CLI-to-MCP 项目说明这个方向已经有现实需求。例如 [any-cli-mcp-server](https://github.com/eirikb/any-cli-mcp-server) 的 README 表示它可以使用 CLI 的 `--help` 输出构建 MCP tools，并支持 GitHub CLI、Azure CLI、Git 等工具。这类项目对本项目有参考意义：它证明“从 CLI help 构造 MCP 接口”可行；同时也提示我们，夏令营题目可以在“生成质量、skill 说明、任务成功率、失败反馈”上继续做更系统的实验。

本项目后续可以把生成 pipeline 拆成几个阶段：

1. 文档采集：运行 `--help` 或读取 README。
2. 候选能力识别：判断哪些子命令值得暴露成工具。
3. 参数抽取：生成结构化参数草稿。
4. schema 生成：输出 MCP tool schema。
5. skill 生成：输出自然语言使用说明。
6. 静态校验：检查 JSON Schema 合法性和字段完整性。
7. 动态验证：让 agent 用它完成任务。
8. 失败回传：用失败日志修正 schema 或 skill。

这条 pipeline 的难点不是“把文本改成 JSON”，而是如何让生成结果真的提高 agent 的任务成功率。

## 7. 沙箱执行：真实调用工具，同时控制风险

题目 2 要求在容器化沙箱环境中搭建最小 agent 执行循环。这一点非常重要，因为仅靠人工阅读 schema/skill 无法证明它们有用。

真正的评测应该让 agent 在受控环境中执行任务。例如：

- 给定一个临时目录；
- 放入若干输入文件；
- 给 agent 暴露一组工具；
- agent 根据任务调用工具；
- 工具真实运行；
- 系统记录命令、参数、stdout、stderr、退出码和产物；
- 判分器检查最终状态。

沙箱的作用是控制风险和保证复现：

- 文件操作限制在任务临时目录；
- 任务结束后销毁环境；
- 禁止危险命令或危险参数；
- 设置超时，避免无限运行；
- 必要时禁止网络；
- 每次任务从干净初始状态开始。

这也解释了为什么 CLI 工具适合该题。与远程 API 相比，CLI 任务可以用本地文件构造，成本低、重复性强、结果容易判定。

沙箱不一定一开始就做得很复杂。学习阶段只需要理解它在实验中的角色：把“看起来会用工具”变成“真实完成任务”，并把过程记录下来用于分析。

## 8. 自动评测：任务成功率、token 消耗、对照实验

题目 2 的评价不是“生成的 schema 看起来合理”，而是“agent 使用这些生成结果后，任务是否更容易成功，token 是否更省”。

因此任务集必须有自动判定标准。常见判分方式包括：

- 检查某个输出文件是否存在；
- 检查文件内容是否包含目标字符串；
- 检查 JSON 字段和数值是否正确；
- 检查图像、音频或压缩包等产物属性；
- 检查命令退出码；
- 检查目录结构是否符合预期。

对照实验至少需要两组：

- 实验组：模型看到生成的 MCP schema 和 skill；
- 对照组：模型直接看到原始 CLI 文档。

如果实验组成功率更高，说明结构化接口和经验说明确实帮助了模型。如果实验组 token 更少，说明 schema/skill 可能减少了模型阅读长文档的成本。如果实验组失败率更高，则要分析是 schema 抽取错误、skill 误导模型，还是任务设计不合理。

ToolLLM 提供了一个相关参照。它围绕真实 API 构造 ToolBench，并考虑单工具和多工具场景、解决路径标注和自动评价。见 [ToolLLM](https://arxiv.org/abs/2307.16789)。虽然它关注 REST API 而不是 CLI，但它说明 tool-use 研究需要任务、工具、调用路径和评价器共同构成实验闭环。

Tool learning survey 进一步把工具学习流程概括为任务规划、工具选择、工具调用和响应生成等阶段，并总结了 benchmark 和评价方法。见 [Tool Learning with Large Language Models: A Survey](https://arxiv.org/abs/2405.17935)。这对本项目很有用：失败不一定发生在调用阶段，也可能发生在任务规划或工具选择阶段。

## 9. 失败归因与反馈修正

题目 2 的进阶目标要求把失败反馈回传给生成 pipeline，自动修正 schema 或 skill。要做到这一点，首先要能定位失败来自哪里。

一条失败链路可以这样回溯：

```text
原始文档
  -> 生成的 schema
  -> 生成的 skill
  -> 模型任务理解
  -> 工具选择
  -> 参数生成
  -> 工具执行
  -> 产物检查
  -> 判分结果
```

常见失败类型包括：

- 文档本身缺信息：`--help` 没写清楚参数取值或示例；
- 抽取错误：把可选参数当成必填，把字符串当成布尔；
- schema 表达不完整：没有表达互斥参数或 enum；
- skill 说明缺关键经验：没有提示先检查输入、不要覆盖原文件；
- 模型选错工具：任务需要 `jq`，模型却尝试用 `rg`；
- 参数组合错误：路径、格式、过滤条件不匹配；
- 沙箱限制导致失败：工具需要网络或写出目录外文件；
- 判分器过严或过松：任务其实完成了但判分失败，或错误产物被判成功。

反馈修正循环可以从简单版本开始：

1. 记录失败日志。
2. 判断失败类别。
3. 把失败信息输入生成器。
4. 只允许修正 schema 或 skill 中相关部分。
5. 重新运行相同任务。
6. 比较修正前后的成功率和 token 消耗。

这里的关键是“闭环”。如果系统只能生成一次 schema/skill，研究价值有限；如果能从失败中改进，就更接近题目要求中的“试错-改进”机制。

## 10. 对本项目的启发：最小可行系统应包含什么

经过上面的概念链路，题目 2 可以被理解为一个实验系统，而不是单个脚本。后续正式方案大概率需要包含以下模块。

### 10.1 CLI 候选工具选择

候选工具应满足：

- 本地可运行；
- 文档可获得；
- 有清晰输入输出；
- 容易构造自动判分任务；
- 危险操作可禁用；
- 能覆盖单步和多步任务。

初期可以优先考虑文本和结构化数据工具，例如 `rg`、`jq`、`git` 的只读子集，或其他输出稳定的 CLI。

### 10.2 文档采集器

采集器负责收集 `--help`、子命令 help、README 和示例。它的输出应保存下来，作为后续生成和失败分析的证据。

### 10.3 schema 与 skill 生成器

生成器负责从文档中生成两类产物：

- MCP tool schema：结构化接口；
- skill 文件：自然语言使用说明。

后续可以先人工审查，再逐步提高自动化程度。

### 10.4 schema 合法性校验

校验器至少检查：

- JSON 是否可解析；
- `inputSchema` 是否是合法 JSON Schema 对象；
- 必填字段是否存在；
- 参数类型是否合理；
- 是否出现明显危险参数。

### 10.5 沙箱执行器

沙箱执行器负责创建临时任务目录、复制输入文件、暴露允许工具、执行 agent 调用并记录日志。基础版本可以先关注文件系统隔离和超时控制。

### 10.6 agent 执行循环

最小 agent loop 不需要一开始追求复杂。它只要能：

- 接收任务；
- 读取工具描述；
- 选择工具；
- 生成参数；
- 执行工具；
- 观察结果；
- 必要时继续下一步；
- 输出最终答案或产物。

### 10.7 任务集与判分器

任务集需要覆盖难度梯度：

- 单工具单步任务；
- 单工具多步任务；
- 两个工具组合任务；
- 容易误用参数的任务；
- 需要从错误中恢复的任务。

每个任务都必须有自动判分函数，避免只靠人工判断。

### 10.8 实验记录与结果表格

每次运行至少记录：

- 任务 ID；
- 工具集合；
- 实验组或对照组；
- 模型；
- prompt token、completion token 和总 token；
- 工具调用次数；
- 是否成功；
- 失败类别；
- 关键日志路径。

### 10.9 失败案例分析模板

报告中最好选 2 到 3 个典型失败案例，沿“文档 -> schema -> skill -> 决策 -> 执行 -> 判分”回溯。这会比只给一张成功率表格更有说服力。

## 小结

题目 2 的核心不是简单地“给 CLI 包一层 MCP”。它真正研究的是：如何把面向人类的工具文档，自动转化为 agent 可用、可验证、可复用的工具接口和使用经验，并用真实任务成功率证明这种转化有价值。

从概念上看：

- ReAct 说明 agent 需要在推理和行动之间循环；
- function/tool calling 说明工具调用需要结构化协议；
- MCP tools schema 提供“怎么调用”的接口层；
- skill 文件补充“什么时候调用、怎样调用更稳”的经验层；
- CLI 工具提供低成本、可复现、可自动判分的实验对象；
- 沙箱让真实执行变得可控；
- 自动评测和失败归因让生成结果可以被数据检验。

因此，后续正式方案设计应围绕一个最小闭环展开：

```text
CLI 文档 -> schema/skill 生成 -> schema 校验 -> 沙箱 agent 执行
  -> 自动判分 -> 结果统计 -> 失败归因 -> 生成结果修正
```

只要这个闭环跑通，就能支撑题目 2 的基础目标；在此基础上，再考虑反馈修正、长尾工具泛化和动态精简 skill 等进阶方向。

## 参考资料

- [夏令营考核要求原文](../../夏令营_简短.docx)
- [MCP Tools Specification, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [Claude Agent Skills Overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
- [OpenAI Function Calling](https://developers.openai.com/api/docs/guides/function-calling)
- [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629)
- [Voyager: An Open-Ended Embodied Agent with Large Language Models](https://arxiv.org/abs/2305.16291)
- [ToolLLM: Facilitating Large Language Models to Master 16000+ Real-world APIs](https://arxiv.org/abs/2307.16789)
- [Tool Learning with Large Language Models: A Survey](https://arxiv.org/abs/2405.17935)
- [any-cli-mcp-server](https://github.com/eirikb/any-cli-mcp-server)
