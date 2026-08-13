# Stage 2B 工具边界实验报告

本报告比较 Description、当前 Skill v1 与边界型 Skill v2 对 jq_query 工具选择的影响。结果仅作小样本描述性分析。

## 首轮门控

**首轮门控：未通过**

| 指标 | 结果 |
|---|---:|
| Boundary Skill v2 任务正确 | 6/6 |
| Boundary Skill v2 纯文本负例合规 | 3/3 |
| Boundary Skill v2 JSON 正例合规 | 2/3 |
| Skill v1 纯文本负例合规 | 3/3 |
| Description 纯文本负例合规 | 3/3 |

未通过原因：

- Boundary Skill v2 未达到 3/3 JSON 正例成功调用。
- Boundary Skill v2 的负例工具合规未优于 Skill v1。

## 条件汇总

| 条件 | 任务正确 | 纯文本负例合规 | JSON 正例合规 | 回合 | 工具调用 | 总 Token |
|---|---:|---:|---:|---:|---:|---:|
| Description | 6/6 | 3/3 | 2/3 | 9 | 3 | 8109 |
| Skill v1 | 6/6 | 3/3 | 1/3 | 8 | 2 | 10457 |
| Boundary Skill v2 | 6/6 | 3/3 | 2/3 | 9 | 3 | 12499 |

## 总体结果

| 完成 | 任务成功 | 工具合规 | 回合 | 工具调用 | 总 Token |
|---:|---:|---:|---:|---:|---:|
| 18/18 | 18/18 | 14/18 | 26 | 8 | 31065 |

## 任务与条件单元格

| 任务 | 条件 | 观测 | 任务成功 | 工具合规 | 策略 | 回合 min-max / mean | 工具调用 min-max / mean | Token min-max / mean |
|---|---|---:|---:|---:|---|---:|---:|---:|
| T12 | Description | 1 | 1/1 | 1/1 | avoided-tool (x1) | 1-1 / 1 | 0-0 / 0 | 650-650 / 650 |
| T13 | Skill v1 | 1 | 1/1 | 0/1 | unresolved (x1) | 1-1 / 1 | 0-0 / 0 | 1095-1095 / 1095 |
| T14 | Boundary Skill v2 | 1 | 1/1 | 1/1 | avoided-tool (x1) | 1-1 / 1 | 0-0 / 0 | 1174-1174 / 1174 |
| T15 | Description | 1 | 1/1 | 0/1 | unresolved (x1) | 1-1 / 1 | 0-0 / 0 | 732-732 / 732 |
| T16 | Skill v1 | 1 | 1/1 | 1/1 | avoided-tool (x1) | 1-1 / 1 | 0-0 / 0 | 1133-1133 / 1133 |
| T17 | Boundary Skill v2 | 1 | 1/1 | 1/1 | recovered-after-error (x1) | 3-3 / 3 | 2-2 / 2 | 5091-5091 / 5091 |
| T12 | Skill v1 | 1 | 1/1 | 1/1 | avoided-tool (x1) | 1-1 / 1 | 0-0 / 0 | 1067-1067 / 1067 |
| T13 | Boundary Skill v2 | 1 | 1/1 | 1/1 | one-shot-query (x1) | 2-2 / 2 | 1-1 / 1 | 2685-2685 / 2685 |
| T14 | Description | 1 | 1/1 | 1/1 | avoided-tool (x1) | 1-1 / 1 | 0-0 / 0 | 698-698 / 698 |
| T15 | Skill v1 | 1 | 1/1 | 0/1 | unresolved (x1) | 1-1 / 1 | 0-0 / 0 | 1151-1151 / 1151 |
| T16 | Boundary Skill v2 | 1 | 1/1 | 1/1 | avoided-tool (x1) | 1-1 / 1 | 0-0 / 0 | 1196-1196 / 1196 |
| T17 | Description | 1 | 1/1 | 1/1 | recovered-after-error (x1) | 3-3 / 3 | 2-2 / 2 | 3601-3601 / 3601 |
| T12 | Boundary Skill v2 | 1 | 1/1 | 1/1 | avoided-tool (x1) | 1-1 / 1 | 0-0 / 0 | 1137-1137 / 1137 |
| T13 | Description | 1 | 1/1 | 1/1 | one-shot-query (x1) | 2-2 / 2 | 1-1 / 1 | 1713-1713 / 1713 |
| T14 | Skill v1 | 1 | 1/1 | 1/1 | avoided-tool (x1) | 1-1 / 1 | 0-0 / 0 | 1114-1114 / 1114 |
| T15 | Boundary Skill v2 | 1 | 1/1 | 0/1 | unresolved (x1) | 1-1 / 1 | 0-0 / 0 | 1216-1216 / 1216 |
| T16 | Description | 1 | 1/1 | 1/1 | avoided-tool (x1) | 1-1 / 1 | 0-0 / 0 | 715-715 / 715 |
| T17 | Skill v1 | 1 | 1/1 | 1/1 | recovered-after-error (x1) | 3-3 / 3 | 2-2 / 2 | 4897-4897 / 4897 |

## 解读边界

- 首轮门控在运行前固定；只有通过后才追加两轮确认实验。
- 任务正确性与工具合规分别计算，正确答案不等于工具选择合理。
- Token、回合和调用次数是次要成本指标，不参与首轮门控。
- 当前只有三组配对任务和一个模型，结果不能外推到其他工具、模型或开放环境。
- 公开报告不包含原始 jq filter、工具输出、模型回答、记录 ID、调用 ID、本机路径或凭据。
