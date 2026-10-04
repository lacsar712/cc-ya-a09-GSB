# 风机偏航对中台

现场技师登记机组编号、**绑定在役桨叶出厂号**与偏航误差（度）；后台 worker 用数据库行锁认领待处理记录，按 ±1.5° 阈值写入「合格」或「偏航超差」。前端为 Lit 组件 + Vite，接口为 Quart + Hypercorn。

## 桨叶出厂号名册规则

- **先在册、在役，才可报送**：出厂号须由现场技师登记进名册且状态为在役；空选、未登记号、退役号一律**整单退回**。
- **顶栏「桨叶出厂号名册」专页**：分「在役」「退役」两表，每号显示最近绑定示例（单据号 + 机组）与累计绑定单数，可弹出该号完整履历（登记 / 绑定 / 退役，含操作人与时间）。
- **号段登记与退役**：现场技师按前缀 + 起止序号 + 位宽批量登记在役号（如 `BLD-` 2001~2010/4 位 → `BLD-2001…BLD-2010`），可对单个在役号退役；已在册号（含退役号）不可重复登记，同号永不复用。
- **绑定随单冻结**：出厂号在报送落库时绑定，之后不可修改；桨叶退役后**旧单仍保留原绑定**，只是不能再绑新单。
- **名册变更与履历一次落齐**：登记 / 退役与其履历、报送插入与绑定履历均在同一数据库事务内提交。
- **库内拦截，防旁路**：除接口事务内 `SELECT … FOR UPDATE` 校验外，`yaw_logs` 上还有 INSERT（必须绑在在册在役号）与 UPDATE（`blade_serial` 冻结）两个触发器，直连 SQL 的旁路写口或落库前偷换号同样被拒。
- **权限**：现场技师（writer）可登记号段、退役、报送；观察者（reader）只能读名册、履历与单据。

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/blades?status=active\|retired` | 名册两表（含绑定示例） |
| POST | `/api/blades/register` | 号段批量登记（writer） |
| POST | `/api/blades/<serial>/retire` | 退役（writer，旧单绑定保留） |
| GET | `/api/blades/<serial>/history` | 单号履历 |
| POST | `/api/logs` | 报送，body 必带在役 `blade_serial`（writer） |

## 端口

| 服务 | 地址 |
|------|------|
| 页面 | http://localhost:3199 |
| 接口 | http://localhost:8199 |
| PostgreSQL | localhost:54399（库名 `yawalign`） |

## 账号

| 用户 | 密码 | 权限 |
|------|------|------|
| technician | tech123456 | 可登记号段、退役、报送 |
| observer | obs123456 | 只读 |

## 启动

```bash
cd projects/20-yaw-align-log
docker compose up --build
```

健康检查：`GET http://localhost:8199/api/health` → `{"status":"ok","service":"yaw-align-log"}`。

## 验收

1. 种子数据：在役号 `BLD-1001..1005`、退役号 `BLD-9001`；机组 W01（绑 BLD-1001）误差 0.4° 结论「合格」；机组 W07（绑 BLD-1002）误差 3.2° 结论「偏航超差」。
2. 现场技师登记号段后，在役表出现新号；报送表单只能从在役号下拉中点选，空选无法提交。
3. 新登记号（甲）绑一号机报送应收下，列表先显示「待处理」，数秒内 worker 处理后变为对应结论。
4. 将甲退役后进入退役表；同号再报送应被拒（整单退回），旧单仍显示原号且不可改绑。
5. 观察者可浏览在役/退役两表、绑定示例与每号履历，但页面无登记/退役/报送入口，直接调写接口返回 403。
6. 旁路写口（直连 SQL 插入未绑号/绑退役号/未登记号单据、UPDATE 旧单 `blade_serial`）均被数据库触发器拒绝。

## 技术栈

- 后端：Quart、psycopg、`worker.py`（`FOR UPDATE SKIP LOCKED`）、Hypercorn
- 数据库：PostgreSQL 名册表 `blade_serials`、履历表 `blade_serial_history`、单据冻结/在役触发器
- 前端：Lit、TypeScript、Vite；生产镜像内 nginx 反代 `/api`
- 镜像源：DaoCloud 基础镜像、清华 PyPI、npmmirror npm
