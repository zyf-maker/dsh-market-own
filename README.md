# dsh-market-own

DeepSeek Harness 的自有插件市场：**自己抓取、自己合并、自己排名、自己修兼容**。
本仓库是它的**插件本体**（宿主半边 + 客户端半边）；目录数据由
[dsh-catalog-merged](https://github.com/zyf-maker/dsh-catalog-merged) 定时构建。

## 安装

```sh
dsh plugin --profile web add github:zyf-maker/dsh-market-own
```

重启 `dsh web`，然后打开 **设置 → 我的市场**。

## 它做什么

| 能力 | 说明 |
|---|---|
| 目录 | 读多源合并后的目录（默认 `dsh-catalog-merged/data/catalog.json`，可用 `DSH_MARKET_CATALOG` 覆盖） |
| 检索/排序 | 按名称·作者·描述搜索；按综合分数 / 星数 / 下载次数 / 名称排序；按安装目标（npm/github/tarball）筛选 |
| 安装 | 以 harness 统一格式安装（`dsh plugin --profile web add <target>`） |
| 兼容自动修复 | 上游没声明 `dsh.bundle.patch`、缺 `dsh.client.platform`、peer 版本与宿主不一致时，生成 **overlay 包**装入，而不是让安装失败 |
| 信任边界 | 只接受**目录里存在**的安装目标——页面无法让宿主安装一个市场没收录的东西 |
| 审计 | 每次安装追加一行到 `<DSH_HOME>/market-state/install-events.jsonl`（含是否用了修复） |

## 结构

```
package.json        dsh.bundle.patch + dsh.client.platform（宿主据此装载两个半边）
cordis.patch.yml    把插件插入 profile 的 layer stack
index.js            宿主半边：目录路由 + 安装路由 + 兼容修复
client/client.js    客户端半边：设置页里的「我的市场」界面
ingest/compat.mjs   兼容规则（与目录构建端共用同一份，避免两边漂移）
```

## 路由

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/dsh-market-own/api/catalog?q=&sort=&kind=&limit=` | 目录（搜索·排序·筛选） |
| POST | `/dsh-market-own/api/install` | 安装（体：`{target, name?, profile?}`） |

## 环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `DSH_MARKET_CATALOG` | `https://raw.githubusercontent.com/zyf-maker/dsh-catalog-merged/main/data/catalog.json` | 换目录来源 |

## License

MIT
