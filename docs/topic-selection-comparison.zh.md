# 浙大控制学院夏令营考核选题对比说明

日期：2026-07-28

本文用于帮助完成早期选题判断。信息来源包括 `夏令营_简短.docx` 的题目要求，以及对相关公开资料入口的快速核验。本文不是最终技术方案，也不是实现计划。

## 先给结论

如果目标是在夏令营考核周期内做出一个完整、可展示、可复现实验闭环，题目 2 更稳妥。它的任务、工具、沙箱、评价标准都可以自己控制，容易先做出最小闭环，再逐步加入反馈修正、长尾工具泛化等进阶内容。

如果目标是做一个更贴近“多智能体代码生成研究”的题目，题目 1 的研究叙事更强。它直接围绕软件工程范式、repo-level code generation benchmark、Pass@1 和 token 消耗展开，适合做成论文式报告。但它对外部 benchmark、模型调用、评测环境和实验成本依赖更大。

我的初步建议是：优先选择题目 2；保留题目 1 作为“如果 benchmark 获取与运行非常顺利，再切换”的备选方向。

## 题目 1：V 模型驱动的多智能体代码生成

这个题目本质上是在问：传统软件工程里的 V 模型，能不能改善 LLM 写代码的质量？

V 模型强调“设计”和“测试”的对称关系。需求分析对应验收测试，系统设计对应系统测试，架构设计对应集成测试，模块设计对应单元测试。题目要求把这套思想抽象成多智能体协作架构，让不同智能体分别负责需求理解、设计、代码生成、测试设计、测试执行、反馈修订等环节。

真正要做的不是单纯让几个 agent 轮流聊天，而是定义一套可执行的工程流程：

- 哪些智能体存在；
- 每个智能体能读写哪些产物；
- 产物格式如何约束；
- 哪些检查通过后才能进入下一阶段；
- 测试失败后回退到哪一层修复；
- 如何记录 token 消耗和最终测试通过率。

最终实验需要在 RealBench 和 NL2RepoBench 中各选 10 题，共 20 题。每题都要跑 V 模型多智能体方案和单智能体对照方案，然后比较 Pass@1 和 token 消耗。

这个方向的展示亮点很明确：可以画出 V 模型多智能体拓扑图，展示一条任务从需求到测试报告的产物链，再用失败案例回溯说明问题出在需求、设计、代码还是智能体间理解不一致。

主要风险也比较直接。RealBench 和 NL2RepoBench 都是 repo-level 或 long-horizon 代码生成 benchmark，运行成本和环境复杂度会比普通算法题高。题目还指定多智能体背后模型使用 DeepSeek-V4-Pro，因此 API 可用性、上下文长度、调用费用和速率限制都可能影响实验节奏。

## 题目 2：CLI 工具的自动 MCP 化与技能生成

这个题目本质上是在问：能不能让 agent 自动学会使用一个新的命令行工具？

普通大模型看到 CLI 文档时，通常只能靠长 prompt 理解工具。题目 2 想把这个过程结构化：让模型读取 `--help` 输出、主页或用户手册，自动生成 MCP tool schema 和 skill 使用说明。schema 负责告诉系统“怎么调用”，skill 负责告诉模型“什么时候用、怎么组合、哪些地方容易错”。

真正要做的是一个生成和验证 pipeline：

- 收集 3 到 4 个 CLI 工具的原始文档；
- 从文档里抽取命令、参数、类型、约束和典型用法；
- 生成 MCP tool schema；
- 生成自然语言 skill 文件；
- 自动校验 schema 是否合法、参数类型是否合理；
- 在隔离沙箱里让 agent 调用这些工具完成任务；
- 比较“schema + skill”和“原始文档直接输入”两种设置的任务成功率与 token 消耗。

这个方向的展示亮点是工程闭环很完整。你可以展示一个工具从 `--help` 到 schema，再到 skill，再到 agent 真实执行任务的全过程。失败案例也容易讲清楚：可能是文档抽取错了、schema 参数错了、skill 没写出关键限制，或者 agent 决策时误用了工具。

主要风险集中在系统设计本身。沙箱要足够安全，任务成功标准要能自动判定，生成的 schema 和 skill 不能只看起来合理，还要真的能提升 agent 执行成功率。不过这些风险大多可控，因为候选 CLI 工具和任务集可以自己选择。

## 为什么我更推荐题目 2

题目 2 更适合先做出一个小而完整的基础版本。比如先选 3 个安全、常见、容易构造任务的 CLI 工具，围绕文件搜索、JSON 处理、文本转换这类任务搭建自动评测。只要跑通“文档输入 -> schema/skill 生成 -> 沙箱执行 -> 自动判分 -> 结果统计”，基础目标就已经有清晰支撑。

题目 1 的研究故事更强，但不确定性更多。它依赖外部 benchmark 的可获取性和可运行性，也依赖 DeepSeek-V4-Pro 在多轮、多智能体、repo-level 任务上的调用稳定性。如果考核周期紧，前期可能花很多时间在 benchmark 环境和任务适配上，而不是核心创新本身。

题目 2 还有一个优势：它和当前 agent/MCP/skill 生态高度相关，容易做出“为什么这个问题重要”的解释。MCP tools 规范本身定义了工具的结构化描述，例如工具名、描述、输入 JSON Schema 和结果格式；而现有 CLI-to-MCP 项目也说明这个方向有现实需求，但仍可以围绕生成质量、技能说明、任务成功率和失败反馈做出自己的实验贡献。

## 建议的下一步探索

我建议下一步不要马上实现，而是先做一个很小的可行性验证设计。

对于题目 2，可以先回答三个问题：

- 选哪些 CLI 工具作为候选；
- 每个工具设计哪些可自动判定的任务；
- agent 执行循环做到多小就足够支撑基础目标。

候选工具可以优先从安全、本地、输出可判定的工具开始，例如 `rg`、`jq`、`git`、`pandoc`、`imagemagick`、`ffmpeg` 中选 3 到 4 个。最终是否采用还需要看本机环境、任务设计难度和展示效果。

对于题目 1，如果继续探索，应先确认两件事：RealBench 和 NL2RepoBench 的数据、代码和评测方式是否能稳定获取；DeepSeek-V4-Pro 是否可以在当前环境中稳定调用并记录 token。只有这两点确认后，才值得设计完整的 V 模型多智能体框架。

## 已核验的公开资料入口

- RealBench 数据集入口：https://figshare.com/articles/dataset/RealBench_A_Repo-Level_Code_Generation_Benchmark_Aligned_with_Real-World_Software_Development_Practices/28596638
- RealBench 论文页面：https://arxiv.org/html/2604.22659v1
- NL2RepoBench GitHub 仓库：https://github.com/multimodal-art-projection/NL2RepoBench
- NL2Repo-Bench 论文页面：https://arxiv.org/html/2512.12730v1
- MCP tools 规范：https://modelcontextprotocol.io/specification/draft/server/tools
- MCP specification 仓库：https://github.com/modelcontextprotocol/modelcontextprotocol
- any-cli-mcp-server 参考项目：https://github.com/eirikb/any-cli-mcp-server

## 当前决策点

如果你接受“优先题目 2，题目 1 作为备选”的判断，下一步应进入题目 2 的设计 brainstorming：先定候选 CLI 工具范围、最小 agent 执行循环、任务集结构和评价指标。

如果你仍然犹豫，下一步可以做一个更保守的双方向可行性探针：题目 1 只验证 benchmark 与模型调用可行性；题目 2 只验证一个 CLI 工具能否从文档生成 schema/skill 并完成 2 到 3 个自动判定任务。
