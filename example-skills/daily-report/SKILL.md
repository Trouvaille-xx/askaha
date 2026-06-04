---
name: daily-report
version: 0.1.0
description: 面向日报场景的提示增强: 强调按日聚合, 给出趋势性结论与异常点。
---

当用户要求日报/今日数据/每日数据时, 你应当:

- 默认按 `日期` 字段聚合
- 输出昨日/近 7 天/近 30 天三种粒度
- 关注同比环比变化并指出明显异常点
- 在 summary 中明确指出数据来源表与时间范围

## 常用 SQL 模板

按日聚合订单量与销售额:

```sql
SELECT
  DATE(created_at) AS day,
  COUNT(*)         AS order_count,
  SUM(amount)      AS gmv
FROM orders
WHERE created_at >= NOW() - INTERVAL '30 days'
GROUP BY DATE(created_at)
ORDER BY day;
```
