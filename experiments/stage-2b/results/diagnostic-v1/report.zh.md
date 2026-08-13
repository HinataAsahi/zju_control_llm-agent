# Stage 2B 诊断观测报告

本报告合并一个 diagnostic-v1 首轮批次与一个完整重复批次，用于复核工具边界、一次查询、结构检查与错误后恢复。结果仅作描述性分析。

## 批次配置

| 批次 | 模型 | 温度 | 最大回合 | 最大工具调用 | 重复数 |
|---|---|---:|---:|---:|---:|
| stage2b-batch-20260813T082555279Z-4f392844<br>stage2b-batch-20260813T090851406Z-0bed70b9 | deepseek-v4-flash | 0 | 6 | 5 | 3 |

## 总体结果

| 完成 | 任务成功 | 工具合规 | 恢复成功（可判定） | 回合 | 工具调用 | 总 Token |
|---:|---:|---:|---:|---:|---:|---:|
| 27/27 | 27/27 | 21/27 | 2/2 | 66 | 39 | 66102 |

## 任务与条件单元格

| 任务 | 条件 | 观测 | 任务成功 | 工具合规 | 恢复成功（可判定） | 首次调用结果 | 策略 | 回合 min-max / mean | 工具调用 min-max / mean | Token min-max / mean |
|---|---|---:|---:|---:|---:|---|---|---:|---:|---:|
| T9 | explicit | 3 | 3/3 | 3/3 | N/A | no-call (x3) | avoided-tool (x3) | 1-1 / 1 | 0-0 / 0 | 650-653 / 651 |
| T10 | description | 3 | 3/3 | 3/3 | N/A | ok (x3) | one-shot-query (x3) | 2-2 / 2 | 1-1 / 1 | 1632-1632 / 1632 |
| T11 | skill | 3 | 3/3 | 3/3 | 2/2 | JQ_RUNTIME_ERROR (x2)<br>ok (x1) | recovered-after-error (x2)<br>one-shot-query (x1) | 4-5 / 4.33 | 3-4 / 3.33 | 5384-6825 / 5864.33 |
| T9 | description | 3 | 3/3 | 0/3 | N/A | ok (x3) | unnecessary-tool (x3) | 2-2 / 2 | 1-1 / 1 | 1563-1563 / 1563 |
| T10 | skill | 3 | 3/3 | 3/3 | N/A | ok (x3) | one-shot-query (x3) | 2-2 / 2 | 1-1 / 1 | 2469-2488 / 2481.67 |
| T11 | explicit | 3 | 3/3 | 3/3 | N/A | ok (x3) | inspect-first (x3) | 3-3 / 3 | 2-2 / 2 | 2508-2510 / 2509.33 |
| T9 | skill | 3 | 3/3 | 0/3 | N/A | ok (x3) | unnecessary-tool (x3) | 2-3 / 2.67 | 1-2 / 1.67 | 2285-3676 / 3210 |
| T10 | explicit | 3 | 3/3 | 3/3 | N/A | ok (x3) | one-shot-query (x3) | 2-2 / 2 | 1-1 / 1 | 1658-1658 / 1658 |
| T11 | description | 3 | 3/3 | 3/3 | N/A | ok (x3) | inspect-first (x3) | 3-3 / 3 | 2-2 / 2 | 2461-2472 / 2464.67 |

## 逐项观测

| 任务 | 条件 | 重复 | 状态 | 任务成功 | 工具合规 | 首次调用 | 策略 | 恢复成功 | 路径 | 回合 | 工具调用 | 总 Token |
|---|---|---:|---|---|---|---|---|---|---|---:|---:|---:|
| T9 | explicit | 1 | completed | 是 | 是 | no-call | avoided-tool | N/A | no-call | 1 | 0 | 653 |
| T10 | description | 1 | completed | 是 | 是 | ok | one-shot-query | N/A | task-query:ok | 2 | 1 | 1632 |
| T11 | skill | 1 | completed | 是 | 是 | JQ_RUNTIME_ERROR | recovered-after-error | 是 | task-query:JQ_RUNTIME_ERROR -> inspect-root:ok -> task-query:ok | 4 | 3 | 5384 |
| T9 | description | 1 | completed | 是 | 否 | ok | unnecessary-tool | N/A | task-query:ok | 2 | 1 | 1563 |
| T10 | skill | 1 | completed | 是 | 是 | ok | one-shot-query | N/A | task-query:ok | 2 | 1 | 2469 |
| T11 | explicit | 1 | completed | 是 | 是 | ok | inspect-first | N/A | inspect-root:ok -> task-query:ok | 3 | 2 | 2508 |
| T9 | skill | 1 | completed | 是 | 否 | ok | unnecessary-tool | N/A | task-query:ok -> task-query:ok | 3 | 2 | 3676 |
| T10 | explicit | 1 | completed | 是 | 是 | ok | one-shot-query | N/A | task-query:ok | 2 | 1 | 1658 |
| T11 | description | 1 | completed | 是 | 是 | ok | inspect-first | N/A | inspect-root:ok -> task-query:ok | 3 | 2 | 2461 |
| T9 | explicit | 2 | completed | 是 | 是 | no-call | avoided-tool | N/A | no-call | 1 | 0 | 650 |
| T10 | description | 2 | completed | 是 | 是 | ok | one-shot-query | N/A | task-query:ok | 2 | 1 | 1632 |
| T11 | skill | 2 | completed | 是 | 是 | ok | one-shot-query | N/A | task-query:ok -> inspect-root:ok -> task-query:ok -> task-query:ok | 5 | 4 | 6825 |
| T9 | description | 2 | completed | 是 | 否 | ok | unnecessary-tool | N/A | task-query:ok | 2 | 1 | 1563 |
| T10 | skill | 2 | completed | 是 | 是 | ok | one-shot-query | N/A | task-query:ok | 2 | 1 | 2488 |
| T11 | explicit | 2 | completed | 是 | 是 | ok | inspect-first | N/A | inspect-root:ok -> task-query:ok | 3 | 2 | 2510 |
| T9 | skill | 2 | completed | 是 | 否 | ok | unnecessary-tool | N/A | task-query:ok | 2 | 1 | 2285 |
| T10 | explicit | 2 | completed | 是 | 是 | ok | one-shot-query | N/A | task-query:ok | 2 | 1 | 1658 |
| T11 | description | 2 | completed | 是 | 是 | ok | inspect-first | N/A | inspect-root:ok -> task-query:ok | 3 | 2 | 2461 |
| T9 | explicit | 3 | completed | 是 | 是 | no-call | avoided-tool | N/A | no-call | 1 | 0 | 650 |
| T10 | description | 3 | completed | 是 | 是 | ok | one-shot-query | N/A | task-query:ok | 2 | 1 | 1632 |
| T11 | skill | 3 | completed | 是 | 是 | JQ_RUNTIME_ERROR | recovered-after-error | 是 | task-query:JQ_RUNTIME_ERROR -> inspect-root:ok -> task-query:ok | 4 | 3 | 5384 |
| T9 | description | 3 | completed | 是 | 否 | ok | unnecessary-tool | N/A | task-query:ok | 2 | 1 | 1563 |
| T10 | skill | 3 | completed | 是 | 是 | ok | one-shot-query | N/A | task-query:ok | 2 | 1 | 2488 |
| T11 | explicit | 3 | completed | 是 | 是 | ok | inspect-first | N/A | inspect-root:ok -> task-query:ok | 3 | 2 | 2510 |
| T9 | skill | 3 | completed | 是 | 否 | ok | unnecessary-tool | N/A | task-query:ok -> task-query:ok | 3 | 2 | 3669 |
| T10 | explicit | 3 | completed | 是 | 是 | ok | one-shot-query | N/A | task-query:ok | 2 | 1 | 1658 |
| T11 | description | 3 | completed | 是 | 是 | ok | inspect-first | N/A | inspect-root:ok -> task-query:ok | 3 | 2 | 2472 |

## 任务解释重点

- T9 观察在工具不适用时是否避免工具；avoided-tool 表示遵守边界，unnecessary-tool 表示发生了不必要调用。
- T10 观察一次复合查询能否完成聚合；one-shot-query 只表示首个目标查询成功且最终答案正确。
- T11 区分 inspect-first 的错误预防与 recovered-after-error 的真实错误后恢复。

## 解读边界

- 当前是小样本诊断观测，不进行显著性检验，也不证明因果关系或稳定的条件差异。
- Explicit 条件可能因直接指令获得优势，因此不能把差异仅归因于工具描述或 Skill。
- 实验只有一个 jq 工具，结论不能直接外推到多工具选择、规划或开放环境。
- 工具返回 ok 只代表调用成功，任务正确性由独立的规范答案比较决定。
- 公开报告不包含原始 filter、工具输出、模型解释、记录 ID、调用 ID、绝对路径或凭据。
