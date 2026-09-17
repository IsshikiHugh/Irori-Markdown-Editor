# Irori

一个轻量的独立桌面 Markdown 编辑器。写作体验剥离自一个 Hexo 博客的内置编辑器，
但不再绑定任何博客概念 —— 它只认一个 `.md` 文件。

名字取自**囲炉裏（いろり）**：日式民居地板上那个方形的下沉火塘，围着它坐是暖的。
图标画的就是它 —— 「井」是火塘的井桁框，在 Markdown 里又正好是 `#`；框中央那点橙是火，
也是光标，是你正在写的地方。

- **源码装饰**：`**粗体**` 的星号一直在那儿，只是文字变粗了。编辑器内部持有的永远是那个
  `.md` 原文，没有「富文本 → 序列化回 Markdown」这一步，文件不会被悄悄改脏。
- **一窗一文**：没有目录树，没有标签页。切换文件＝开另一扇窗。
- **轻**：系统自带的网页引擎（Tauri）+ 虚拟滚动的编辑器内核，十万字与一千字开销几乎相同，
  几百张图也只有看得见的那几张在内存里。
- **字体用你自己装的**：安装包里不带字体。

当前版本 **v0.1.4**，更新记录见 [`CHANGELOG.md`](./CHANGELOG.md)。
领域语言与每一条取舍写在 [`CONTEXT.md`](./CONTEXT.md)，两条结构性决策在 [`docs/adr/`](./docs/adr)。

## 跑起来

```bash
npm install

npm run dev        # 只跑前端（浏览器 + 内存文件系统，不碰真实磁盘）
./scripts/dev.sh   # 桌面应用（需要 Rust ≥ 1.88）
```

> 桌面外壳要 **Rust 1.88 以上**（Tauri 2 的依赖树要求）。若 `rustc --version` 更旧，用
> [rustup](https://rustup.rs) 装一个 stable：`curl https://sh.rustup.rs -sSf | sh`。
> `scripts/*.sh` 会自动优先使用 `~/.cargo/bin` 下的工具链。

## 验证

```bash
npm test           # 类型 + 单元 + 行为（82 条用例 / 328 条断言）
./scripts/test.sh  # 上面这些，外加 Rust 侧的 fmt / clippy
npm run test:e2e -- --only B-2      # 只跑某一组
npm run test:e2e -- --report        # 生成 docs/acceptance/report.md
```

**与旧编辑器的对照实验**（ADR-0002 第三步）另有一条命令，它把博客里那个编辑器起起来，
同一篇文章两边各测一遍几何与配色再逐项比对：

```bash
IRORI_LEGACY_BLOG=/path/to/blog node tests/compare/run.mjs --slug <文章的-slug> --shots
```

旧编辑器跑在 `source/_posts` 的**临时副本**上，真实文章绝不被碰；没设这个环境变量就直接跳过。

行为测试用真实 headless Chromium 驱动**真实应用**（不是 mock）：宿主换成内存文件系统，
编辑器本身一行没改。浏览器用本机已装的 Chromium/Chrome，不下载；也可以
`IRORI_CHROME=/path/to/chrome` 指定。

**真机冒烟**：打包产物在系统 WebView（macOS 上是 WebKit，不是 Chrome）里跑一遍，确认
「外壳 → 读文件 → 编辑器 → 装饰」整条链路成立：

```bash
npx tauri build --debug --bundles app   # 先有产物
./scripts/smoke.sh
./scripts/smoke.sh --shot               # 顺便截一张窗口图（只截这个窗口）
```

## 打包

```bash
./scripts/build.sh          # 当前平台的安装包 → src-tauri/target/release/bundle/
./scripts/build.sh --web    # 只构建前端 → dist/
```

CI 见 [`.github/workflows/`](./.github/workflows)：`ci.yml` 跑类型/单元/行为 + 三平台编译，
`release.yml` 在打 `v*` tag 时产出三平台安装包（草稿 release），
也可以在 Actions 页手动运行，安装包在那次运行的 Artifacts 里（Windows 是 `-setup.exe` 与 `.msi`）。

> **只在 macOS 上做过人工验收。** Windows / Linux 能编译能打包，但没有人跑过验收清单
> —— 见 [ADR-0001](./docs/adr/0001-tauri-shell.md)。

## 代码结构

```
src/
├── editor/            写作核心（CodeMirror 之上的一层）
│   ├── tokens.ts        ← 装饰规则。纯函数，三个渲染器共用（编辑区 / 缩略图 / 测试）
│   ├── decorations.ts   ← 行装饰（视口内）+ 图片 widget（state field）
│   ├── image-nav.ts     ← 方向键走进图片行
│   ├── cjk-indent.ts    ← 段首两个半角空格 → 全角
│   └── index.ts         ← 扩展装配、快捷键
├── features/          目录 / 缩略图 / 专注模式 / 字数
├── app/               文档会话（保存、自动保存、外部改动）、设置、图片落盘
├── platform/          与宿主的唯一接缝：tauri.ts 与 web.ts（内存文件系统）
└── main.ts            装配
src-tauri/             Rust 外壳：文件 IO、对话框、窗口、设置
tests/unit/            纯逻辑
tests/e2e/cases/       行为用例，编号对应 docs/acceptance/behavior-checklist.md
```

`src/platform/` 之上的代码**不知道**自己跑在 Tauri 还是浏览器里。这既是测试能驱动真实应用的原因，
也是 ADR-0001 那条「写作核心里不许有平台专属补丁」的落点。

## 验收

[`docs/acceptance/behavior-checklist.md`](./docs/acceptance/behavior-checklist.md) 是验收协议：
81 条机器测 + 12 条人工看 + 16 项真机冒烟（`--close` / `--dialog` 各加一项）。与旧编辑器不一致的地方全部集中在
[`deviations.md`](./docs/acceptance/deviations.md)，需要逐条裁决。

## 快捷键

| 键 | 作用 |
| --- | --- |
| `⌘S` / `⌘⇧S` | 保存 / 另存为 |
| `⌘N` / `⌘O` / `⌘W` | 新窗口 / 打开 / 关闭窗口 |
| `⌘\` | 开关抽屉 |
| `⌘F` | 查找 |
| `⌘B` / `⌘I` | 粗体 / 斜体 |
| `⌘Z` / `⌘⇧Z` | 撤销 / 重做 |
| `Esc` | 关闭抽屉或查找面板 |

v1 不做自定义菜单，上面这些只有快捷键入口；macOS 上仍有 Tauri 提供的系统默认菜单，
所以 `⌘C`/`⌘V`/`⌘Z` 这些挂在系统「编辑」菜单上的快捷键照常工作。

## 实测数字（Apple Silicon / macOS）

| | |
| --- | --- |
| 安装包（release，dmg） | 1.9 MB |
| 应用体积（.app） | 3.6 MB |
| 内存（打开一篇短文） | 约 101 MB |
| 内存（打开 12 万字符的长文） | 约 108 MB |
| 十万字文档滚动 | 约 1.7 ms/帧 |
| 十万字文档单次输入 | < 3 ms |

内存是四个进程的 physical footprint 之和（主进程 + WebKit 的 GPU / Networking / WebContent），
用 `vmmap -summary` 量的。长文只比短文多约 7 MB —— 虚拟滚动与增量撤销栈的收益就在这里。
