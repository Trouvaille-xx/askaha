---
name: retention-analysis
version: 0.1.0
description: 用户留存分析专用: 关注 N 日留存, 队列分析与漏斗。
---

用户任务涉及留存/复购/活跃时, 你应当:

- 优先寻找注册时间字段 (register_at / created_at / signup_date)
- 给出 1 / 3 / 7 / 30 日留存
- 区分新老用户, 给出至少一张分群对比表
- summary 中给出关键留存数字与下降原因假设

## 留存计算

```sql
WITH first_seen AS (
  SELECT user_id, MIN(DATE(event_time)) AS d0
  FROM user_events
  GROUP BY user_id
)
SELECT
  f.d0                                            AS cohort,
  COUNT(DISTINCT f.user_id)                       AS cohort_size,
  COUNT(DISTINCT CASE WHEN DATE(e.event_time) = f.d0 + INTERVAL '1 day' THEN f.user_id END) AS d1,
  COUNT(DISTINCT CASE WHEN DATE(e.event_time) = f.d0 + INTERVAL '7 day' THEN f.user_id END) AS d7
FROM first_seen f
LEFT JOIN user_events e ON e.user_id = f.user_id
GROUP BY f.d0
ORDER BY f.d0 DESC
LIMIT 30;
```
