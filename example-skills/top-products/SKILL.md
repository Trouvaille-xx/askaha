---
name: top-products
version: 0.1.0
description: 商品/订单排行分析: 自动识别商品维表与订单事实表, 输出 TOP N 与类目结构。
---

用户任务涉及销量/排名/排行/Top 时, 你应当:

- 先识别商品维表与订单/销量事实表
- 用 INNER JOIN 关联, 注意去重 (DISTINCT)
- 默认按销量/销售额降序, 返回前 10
- summary 中给出 TOP 5 列表与品类集中度观察

## TOP N 销量

```sql
SELECT
  p.id,
  p.name,
  p.category,
  SUM(oi.quantity) AS qty,
  SUM(oi.quantity * oi.price) AS gmv
FROM order_items oi
JOIN orders o   ON o.id = oi.order_id
JOIN products p ON p.id = oi.product_id
WHERE o.created_at >= NOW() - INTERVAL '30 days'
GROUP BY p.id, p.name, p.category
ORDER BY gmv DESC
LIMIT 10;
```
