# Stage 2B 描述性单次观测报告

本报告区分预算校准前的 pilot 与校准后的 calibrated 批次。每个任务与条件只有一次观测，因此只描述本次运行，不进行统计推断。

## 批次配置

| 角色 | 批次 | 温度 | 最大回合 | 最大工具调用 | 重复数 |
|---|---|---:|---:|---:|---:|
| pilot | stage2b-batch-20260811T072559965Z-a2cd7ac2 | provider-default | 5 | 4 | 1 |
| calibrated | stage2b-batch-20260811T082039968Z-f08fd44f | 0 | 6 | 5 | 1 |

## 总体结果

| 角色 | 完成 | 任务成功 | 恢复成功（可判定） | 限制中止 | 回合 | 工具调用 | 总 token |
|---|---:|---:|---:|---:|---:|---:|---:|
| pilot | 2/6 | 2/6 | 1/1 | 4 | 27 | 22 | 29296 |
| calibrated | 6/6 | 6/6 | 3/3 | 0 | 27 | 21 | 28253 |

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

## 解读边界

- pilot 与 calibrated 同时改变了温度和调用预算，结果差异不能直接归因于其中任一变量。
- 每个任务与条件只有一次运行，不能据此判断 Explicit、Description 或 Skill 的稳定优劣。
- 恢复成功率只统计 `recoverySuccess` 非空的可判定记录；因限制中止而未完成的恢复任务显示为 N/A。
- 公开汇总不包含原始模型响应、工具参数、工具输出、最终答案解释、记录 ID、绝对路径或凭据。
