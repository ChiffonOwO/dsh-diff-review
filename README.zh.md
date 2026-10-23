# dsh-diff-review

DeepSeek Harness 的 Codex 风格「改动审查」：助手一旦改文件，输入框正上方立刻出现 **N 个文件已更改 +M −K**；鼠标移上去清单从上方浮出，右侧边栏按文件查看带语法高亮的 diff，并能一键还原本轮改动。

[English](README.md) | 中文

- **输入框上方的状态条**：居中悬在输入框正上方（不在侧边），只统计**当前这一轮**改过的文件，随回合开始清零；行数汇总与文件清单可展开，点文件名直接跳到该文件的 diff。
- **状态条只有一颗药丸**：`N 个文件已更改 +M −K`，不再有单独的「审查」「刷新」按钮 —— 悬停即出清单，清单里点文件名进审查页；轮询每 2 秒自动刷新。
- **只认悬停，不认点击**：鼠标移到状态条区域，清单从状态条上方淡入升起，箭头同时转向朝上（`▴`）；移开就淡出。点击药丸本身不切换状态。它绝对定位、不占排版，展开时输入框不会被顶下去；窗口太矮时最大高度按上方可用空间自动收窄，超出部分滚动。
- **计数按整轮累计算**：同一文件在一轮里被改多次时，`+M −K` 与 diff 都以**回合开始时的内容**为基准累计，而不是只留最后一次编辑的数字。
- **数字变化会弹一下**：+ 或 − 变化时做一次轻微的上跳缩放（`prefers-reduced-motion` 下自动关闭）。
- **展开的清单按内容定宽**：宽度贴着最长那条文件名收住，不会向右拉出一截空白；只有路径真的超长时才在输入框宽度处封顶、末尾省略号。
- **清单里名字左对齐、增减值右对齐**：名字起于固定左缘，两列数字各自右对齐成列。
- **数字之间的间距**：状态条里 + 与 − 只隔 4.75px（比药丸自身的 8px 间距少一个空格）；清单里只隔 1.5px（再少两个空格），与「名字→数字」的 4px 分开。
- **位置**：状态条压在原生的「任务」和「排队消息」dock 之上，两者仍是 dsh 自己的样子，不做任何改动。
- **右侧边栏审查页**：顶部是文件标签栏（像浏览器标签，横向可滚），下面整块都是所选文件的 diff —— 左右不分栏。
- **语法高亮**：按文件扩展名选语言（`dart`、`cpp`、`py`、`js`、`mjs`…），用 dsh 客户端内置的 shiki 高亮器与主题 token 上色；未加载的语法会先按纯文本显示，语法加载完自动重画。
- **滚动性能**：长 diff 的代码行按 60 行一组装进 `content-visibility: auto` 的容器，屏幕外的组跳过布局与绘制；高亮与元素构建都按内容 memo。2000 行的 diff 实测滚动帧时间 p50 16.7ms / p95 17.7ms（把同样内容逐行单独包 `content-visibility` 会退化到 p50 20.6ms，故按组包）。
- **还原是保守的**：只在与记录内容仍一致时写回；文件已被别的改动覆盖则报冲突，不盲写。
- **只记录助手自己的写操作**：捕获 `edit` / `write` 的工具结果（按结果形状识别，因此 Code-Mode 里嵌套的写调用也算），bash 里 `>` 重定向、`sed -i` 之类不追踪。

![输入框正上方的居中状态条](docs/dock.png)

展开后的文件清单（移开即收起）：

![展开的文件清单](docs/dock-expanded.png)

审查页：顶部标签切换文件，下方整幅 diff，按 Dart 语法着色。

![审查页](docs/review.png)

## 安装

```sh
# 用预构建的 Release 包（跳过源码构建）
dsh plugin --profile web add https://github.com/ChiffonOwO/dsh-diff-review/releases/latest/download/dsh-diff-review.tgz

# 或者直接从源码装
dsh plugin --profile web add github:ChiffonOwO/dsh-diff-review
```

装完**重启应用**（插件列表只在启动时读一次）。桌面端把 `web` 换成你自己的 profile 名。

## 用

正常发消息让助手改文件即可。回合里出现状态条后：

- 鼠标移到状态条上浮出文件清单，移开即收起（纯悬停，点药丸不切换）；
- 点清单里的某个文件名，右侧边栏打开审查页并停在那个文件上；
- 审查页顶部点标签切换文件，点「全部还原」把本轮改动写回。

不想留这个状态条时，把它从 profile 的 `package.json` 里 `dsh.profile.bundles` 删掉再重启即可。

## 接口

三条都要登录态（浏览器侧走同源 `fetch`，自动带 cookie）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/diff-review.changes?sessionId=` | 本轮改动文件 + 汇总行数 |
| GET | `/api/diff-review.diff?sessionId=&path=` | 单个文件的 diff 行 + 两侧全文（供整文件高亮） |
| POST | `/api/diff-review.revert` | `{ sessionId, paths? }`，省略 `paths` 即整轮 |

## 结构

- `index.js`（Host）：挂 `tools/post-execute` 记录 `before`/`after`，按 `session/event` 的 `turn/start` 分轮，注册上面三条路由；diff 用 LCS 自己算，不依赖 `git`（非 git 仓库也能用）。
- `client.js`（浏览器）：`conversation.input.dock` 上的状态条 + `sidebar.right.pane.tab` 上的审查页，配一份 zh/en 字典。
- `test/host.test.mjs`：Host 侧单测，`node --test test/host.test.mjs`。
- 界面回归（都需 `BASE=… TOKEN=…` 指向一个已装本插件的实例）：
  - `test/review.mjs`：审查页版式 + 语法高亮（桩数据）；
  - `test/popover.mjs`：悬停浮出/上浮定位/淡入淡出/箭头转向/点击不切换/输入框不被顶动；
  - `test/order.mjs`：状态条压在原生任务 dock 之上；
  - `test/shot.mjs`：状态条截图与文件名/行数间距；
  - `test/width.mjs`：展开清单的定宽行为（`ONE=1` 单行、`LONG=1` 超长路径、`WIN=760,800` 窄窗）；
  - `test/counter.mjs`：增减值右对齐 + 计数弹跳（`getAnimations()` 断言真的在跑）；
  - `test/multi-edit.mjs`：一轮内连改三次同一文件，断言累计计数与完整 diff；
  - `test/perf.mjs`：2000 行 diff 的滚动帧时间（含分组容器与单颗药丸断言）；
  - `test/dart.mjs` / `test/e2e.mjs`：真起一轮对话的端到端检查。

## 已知边界

- 记录只活在进程内存里：重启应用后旧对话没有历史 diff，跑新的一轮才有。
- 每个会话只保留最近 12 轮的记录。
- 单个文件超过 4000 行时 diff 截断。
- 删除文件不经 `edit`/`write`，当前不显示为改动。
- 客户端的 `dsh.client` 变更（新增插槽、改 bundle 结构）**必须重启应用**才会生效；只改 `client.js` 的内容在已打开的页面上不会热更新（client-hmr 只对运行期重建的 bundle 生效，安装态要重启）。

## 许可证

[MIT](LICENSE)
