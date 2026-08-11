# Stage 2B 描述性观测报告

本报告区分预算校准前的 pilot、校准基线 calibrated 与固定配置 repeat 批次，只进行描述性汇总，不进行显著性检验或因果推断。

## 批次配置

| 角色 | 批次 | 温度 | 最大回合 | 最大工具调用 | 重复数 |
|---|---|---:|---:|---:|---:|
| pilot | stage2b-batch-20260811T072559965Z-a2cd7ac2 | provider-default | 5 | 4 | 1 |
| calibrated | stage2b-batch-20260811T082039968Z-f08fd44f | 0 | 6 | 5 | 1 |
| repeat | stage2b-batch-20260811T111132689Z-c2b5c7cc | 0 | 6 | 5 | 2 |

## 总体结果

| 角色 | 完成 | 任务成功 | 恢复成功（可判定） | 限制中止 | 回合 | 工具调用 | 总 token |
|---|---:|---:|---:|---:|---:|---:|---:|
| pilot | 2/6 | 2/6 | 1/1 | 4 | 27 | 22 | 29296 |
| calibrated | 6/6 | 6/6 | 3/3 | 0 | 27 | 21 | 28253 |
| repeat | 12/12 | 12/12 | 6/6 | 0 | 54 | 42 | 56566 |

## 固定配置重复观测（n=3）

| 任务 | 条件 | 完成 | 任务成功 | 恢复成功（可判定） | 回合 min-max / mean | 工具调用 min-max / mean | Token min-max / mean |
|---|---|---:|---:|---:|---:|---:|---:|
| T2 | explicit | 3/3 | 3/3 | N/A | 4-4 / 4 | 3-3 / 3 | 3459-3459 / 3459 |
| T2 | description | 3/3 | 3/3 | N/A | 4-4 / 4 | 3-3 / 3 | 3406-3406 / 3406 |
| T2 | skill | 3/3 | 3/3 | N/A | 4-4 / 4 | 3-3 / 3 | 5075-5097 / 5085.33 |
| T7 | explicit | 3/3 | 3/3 | 3/3 | 5-5 / 5 | 4-4 / 4 | 4773-4793 / 4780.67 |
| T7 | description | 3/3 | 3/3 | 3/3 | 5-5 / 5 | 4-4 / 4 | 4730-4736 / 4732 |
| T7 | skill | 3/3 | 3/3 | 3/3 | 5-5 / 5 | 4-4 / 4 | 6810-6810 / 6810 |

## 工具调用路径

路径仅包含归一化动作类别与稳定结果码，不包含原始 jq 参数或工具输出。

| 任务 | 条件 | 观测数 | 不同路径数 | 路径（次数） |
|---|---|---:|---:|---|
| T2 | explicit | 3 | 1 | root-unaware-name-array-query:JQ_RUNTIME_ERROR -> inspect-root:ok -> root-aware-name-stream-query:ok (x3) |
| T2 | description | 3 | 1 | root-unaware-name-array-query:JQ_RUNTIME_ERROR -> inspect-root:ok -> root-aware-name-stream-query:ok (x3) |
| T2 | skill | 3 | 2 | root-unaware-name-array-query:JQ_RUNTIME_ERROR -> inspect-root:ok -> root-aware-name-array-query:ok (x2)<br>root-unaware-name-array-query:JQ_RUNTIME_ERROR -> inspect-root:ok -> root-aware-name-stream-query:ok (x1) |
| T7 | explicit | 3 | 1 | required-invalid-filter:JQ_SYNTAX_ERROR -> root-unaware-count-query:JQ_RUNTIME_ERROR -> inspect-root:ok -> root-aware-count-query:ok (x3) |
| T7 | description | 3 | 1 | required-invalid-filter:JQ_SYNTAX_ERROR -> root-unaware-count-query:JQ_RUNTIME_ERROR -> inspect-root:ok -> root-aware-count-query:ok (x3) |
| T7 | skill | 3 | 1 | required-invalid-filter:JQ_SYNTAX_ERROR -> root-unaware-count-query:JQ_RUNTIME_ERROR -> inspect-root:ok -> root-aware-count-query:ok (x3) |

## 逐项观测

| 角色 | 任务 | 条件 | 状态 | 任务成功 | 恢复成功 | 回合 | 工具调用 | 总 token |
|---|---|---|---|---|---|---:|---:|---:|
| pilot | T2 | explicit | completed | 是 | N/A | 3 | 2 | 2354 |
| pilot | T2 | description | limit-exceeded | N/A | N/A | 5 | 4 | 4643 |
| pilot | T2 | skill | limit-exceeded | N/A | N/A | 5 | 4 | 6647 |
| pilot | T7 | explicit | completed | 是 | 是 | 5 | 4 | 4803 |
| pilot | T7 | description | limit-exceeded | N/A | N/A | 4 | 4 | 4007 |
| pilot | T7 | skill | limit-exceeded | N/A | N/A | 5 | 4 | 6842 |
| calibrated | T2 | explicit | completed | 是 | N/A | 4 | 3 | 3459 |
| calibrated | T2 | description | completed | 是 | N/A | 4 | 3 | 3406 |
| calibrated | T2 | skill | completed | 是 | N/A | 4 | 3 | 5075 |
| calibrated | T7 | explicit | completed | 是 | 是 | 5 | 4 | 4773 |
| calibrated | T7 | description | completed | 是 | 是 | 5 | 4 | 4730 |
| calibrated | T7 | skill | completed | 是 | 是 | 5 | 4 | 6810 |
| repeat | T2 | explicit | completed | 是 | N/A | 4 | 3 | 3459 |
| repeat | T2 | explicit | completed | 是 | N/A | 4 | 3 | 3459 |
| repeat | T2 | description | completed | 是 | N/A | 4 | 3 | 3406 |
| repeat | T2 | description | completed | 是 | N/A | 4 | 3 | 3406 |
| repeat | T2 | skill | completed | 是 | N/A | 4 | 3 | 5097 |
| repeat | T2 | skill | completed | 是 | N/A | 4 | 3 | 5084 |
| repeat | T7 | explicit | completed | 是 | 是 | 5 | 4 | 4793 |
| repeat | T7 | explicit | completed | 是 | 是 | 5 | 4 | 4776 |
| repeat | T7 | description | completed | 是 | 是 | 5 | 4 | 4730 |
| repeat | T7 | description | completed | 是 | 是 | 5 | 4 | 4736 |
| repeat | T7 | skill | completed | 是 | 是 | 5 | 4 | 6810 |
| repeat | T7 | skill | completed | 是 | 是 | 5 | 4 | 6810 |

## 解读边界

- pilot 与 calibrated 同时改变了温度和调用预算，结果差异不能直接归因于其中任一变量。
- calibrated 与 repeat 使用相同配置，合并后每个任务与条件有三次观测；样本仍小，只报告范围和均值。
- 当前样本不能证明 Explicit、Description 或 Skill 之间存在稳定差异。
- 恢复成功率只统计 `recoverySuccess` 非空的可判定记录；因限制中止而未完成的恢复任务显示为 N/A。
- 公开汇总不包含原始模型响应、工具参数、工具输出、最终答案解释、记录 ID、绝对路径或凭据。
