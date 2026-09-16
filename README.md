# dsh-market-own

DeepSeek Harness 的**插件本体**：设置页里的「我的市场」——浏览目录、搜索筛选、一键安装、兼容自动修复、审计台账。

## 这个仓库是哪一个

市场由**两个仓库**组成，职责不重叠：

| 仓库 | 是什么 | 里面装什么 | 什么时候变 |
|---|---|---|---|
| [`dsh-catalog-merged`](https://github.com/zyf-maker/dsh-catalog-merged) | 数据集 + 采集管线 + 公开站点 | `ingest/`（抓取 → 归一 → 合并 → 准入 → 排名 → 产出）、`data/`（构建产物）、`web/`（公开页面）、`shared/quality.mjs`、`db/`、`api/` | `data/` 每 6 小时由 CI 重建 |
| **本仓库** `dsh-market-own` | 插件本体 | 宿主半边 `index.js`、客户端半边 `client/client.js`、`cordis.patch.yml`、`ingest/compat.mjs` | 只在改插件时 |

**依赖是单向的**：本插件读数据仓库发布出来的 `data/catalog.json`。数据仓库不认识本插件。

**为什么不合成一个仓**：插件要能用 `dsh plugin add github:zyf-maker/dsh-market-own` 装上，而 pnpm 会 clone 整个仓库。数据仓库光 `data/` 就有 62MB，且每 6 小时重建一次——合在一起，每次装插件都要拖 62MB，插件的"版本"还会跟着数据的提交不停漂。

**本仓库不含目录数据。** 目录由数据仓库的 CI 构建并发布，本仓库只消费它。

## 安装

```sh
dsh plugin --profile web add github:zyf-maker/dsh-market-own
```

重启 `dsh web`，然后打开 **设置 → 我的市场**。

## 它做什么

| 能力 | 说明 |
|---|---|
| 目录 | 读 `data/catalog.json`（默认取数据仓库的 main，可用 `DSH_MARKET_CATALOG` 覆盖），内存缓存 5 分钟 |
| 检索/排序 | 搜索名称·作者·描述·话题；排序：推荐 / 星数 / 下载 / 最近收录 / 名称；按分类与安装方式（npm / github / tarball）筛选 |
| 安装 | 以 harness 统一格式安装（`dsh plugin --profile web add <target>`） |
| 兼容自动修复 | 上游没声明 `dsh.bundle.patch`、缺 `dsh.client.platform`、peer 版本与宿主不一致时，生成 **overlay 包**装入，而不是让安装失败 |
| 信任边界 | 只接受**目录里存在**的安装目标——页面无法让宿主安装一个市场没收录的东西 |
| 已安装视图 | 第二个 Tab：读本市场的安装台账，并 join 活的 Loader 状态（启用与否、挂载阶段、是否失败） |
| 审计 | 每次安装追加一行到 `<DSH_HOME>/market-state/install-events.jsonl`（含是否用了修复） |

## 结构

```
package.json        dsh.bundle.patch + dsh.client.platform（宿主据此装载两个半边）
cordis.patch.yml    把插件插入 profile 的 layer stack
index.js            宿主半边：目录路由 + 安装路由 + 兼容修复 + 台账
client/client.js    客户端半边：设置页里的「我的市场」
                    （手写 loader factory 格式，无构建步骤，只依赖 react）
ingest/compat.mjs   兼容规则（与数据仓库同一套语义，避免两边漂移）
```

## 路由

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/dsh-market-own/api/catalog?q=&sort=&kind=&category=&page=&limit=` | 目录（搜索·排序·筛选·分页） |
| POST | `/dsh-market-own/api/install` | 安装（体：`{target, name?, profile?}`） |
| GET | `/dsh-market-own/api/installed` | 本市场的安装台账 |

## 数据契约

插件**不自己判定目录质量**。数据仓库的 `ingest/index.mjs` 通过 `shared/quality.mjs` 给每一行打上：

| 字段 | 含义 |
|---|---|
| `qualityState` | `recommended` / `verified` / `unverified`；`unverified` 是空壳，不展示 |
| `qualityScore` | 0–100 的质量分 |
| `qualityReasons` | 支撑该分数的信号，供界面解释 |

设置页的「我的市场」与公开页面读同一份判定，所以同一行不会在一处是插件、在另一处是空壳。本仓库里的同名规则是**回退**——只在该行没有注解时启用（旧产物，或指向了别的 `DSH_MARKET_CATALOG`），语义与 `shared/quality.mjs` 保持一致。

`installable` 取目录自己的判定：`true` 可安装；`null` 表示安装方式未能验证（仍然列出，但按钮禁用）；`false` 不安装。

推荐排序：**先分质量档（`recommended` > `verified`），档内按原始热度**（`stars*1000 + downloads`）。档内按 `qualityScore` 排会把热门插件埋掉——那个分满分 100 且会并列，其中 45 分只发给被管线探测过 manifest 的行。

## 环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `DSH_MARKET_CATALOG` | `https://raw.githubusercontent.com/zyf-maker/dsh-catalog-merged/main/data/catalog.json` | 换目录来源 |
| `DSH_HOME` | 由宿主注入 | 台账与 overlay 的落盘根目录 |

## 排障

**安装失败，日志里出现 `Cannot find package 'tsx'`。** 宿主以源码方式运行时（`node --import tsx/esm apps/cli/src/bin.ts`），子进程会继承 `--import tsx/esm`，而 Node 解析 `--import` 的裸标识符是相对**子进程 cwd** 的。所以 CLI 子进程必须在能解析到 `tsx` 的目录下启动——插件已按 CLI 入口向上查找 `node_modules/tsx` 推导该目录，不要再改回 `DSH_HOME`。

**Windows 上找不到 `dsh`。** 源码检出不会在 PATH 上生成 `dsh` 可执行文件，所以插件复用当前进程的 `execPath` + `execArgv` + CLI 入口，而不是 shell 调用 `dsh`。

**git 托管插件装不上，pnpm 提示 prepare 脚本被拦。** 把 pnpm 打印的那个 key 加进 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds`，再重试。

## License

MIT
