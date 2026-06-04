---
name: orders-domain
version: 0.1.0
description: 电商订单域背景知识: 术语、字段、口径。直接以 .md 文件形式导入, 不需要脚本。
---

本技能注入电商订单域的业务知识, 帮助模型理解表名、字段与口径。

## 核心表

- `orders` — 主订单, 状态字段 `status`: created / paid / shipped / completed / refunded
- `order_items` — 子订单行, 包含 `product_id` / `quantity` / `price`
- `products` — 商品维表, `category` 字段是类目 ID
- `users` — 用户表, `register_at` 是注册时间
- `payments` — 支付流水, 与 `orders.order_no` 关联

## 常见口径

- **GMV**: `SUM(orders.amount)` 包含未支付订单, 实际"已支付 GMV"应关联 `payments.status='success'`
- **支付率**: `paid_orders / total_orders`, 时间窗口与订单创建时间一致
- **客单价**: GMV / 下单用户数 (不去重订单数)

## 字段备注

- `amount` 单位为分, 展示时记得除以 100
- `created_at` 是 UTC, 与本地时间差 8 小时
- 软删除标志为 `deleted_at IS NOT NULL`
