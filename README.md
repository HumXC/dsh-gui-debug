# dsh-gui-debug

DSH GUI 调试插件：统一工具、Cage/Sway 受管环境、独立应用生命周期、截图与输入，以及经用户确认的只读 host 访问。已提供 Cordis 入口、运行时和可安装打包。外部程序由用户安装；插件负责检测、管理、封装与调用，不修改系统配置。

## 两层边界

```text
LLM → gui_debug_* 统一工具 → GuiDriver 后端驱动 → WM 原生能力或外部程序
```

工具层负责配置解析、实例/应用索引、受管进程、策略检查、串行调度、坐标换算和附件。驱动负责自己的配置入口、显示连接和各项操作实现。Cage 截图可以调用 grim，其他 WM 可以使用原生截图，公共工具接口不变化。没有独立的截图/输入 provider 注册层。

## 运行文件目录

运行时文件统一以当前调试工作区为根，放在 .dsh/gui-debug/ 下，按实例隔离：

```text
.dsh/gui-debug/instances/<instanceId>/
├── artifacts/       # 截图等产物
├── logs/            # 驱动、应用和 helper 日志
├── runtime/         # 受管环境的 socket 等运行文件
├── wm/              # 驱动生成的 WM 配置
├── cache/           # 实例或观测 helper 缓存
└── settings/        # 受管环境选择 private 时的应用设置
```

host 仅使用产物、日志和观测 helper 所需目录，不创建 WM 配置或私有显示 runtime。停止受管实例或断开 host 后保留截图和日志；确认进程范围退出后仅移除本插件 runtime 中的 socket/lock。目录使用 0700、配置及日志使用 0600，并检查路径归属与符号链接。profile 位于 .dsh/gui-debug/profiles/；活实例和授权不会从历史文件自动恢复。

## 文件入口

- [实例配置与 JSON Schema](./src/config.ts)：公共配置、单次覆盖和默认值。
- [工具声明](./src/tools.ts)、[请求与结果类型](./src/api.ts)：9 个统一工具与协议。
- [驱动契约](./src/driver.ts)：静态元数据、受管进程入口、运行上下文及必须实现的函数。
- [Cage 声明](./src/drivers/cage.ts)、[Sway 声明](./src/drivers/sway.ts)、[host 声明](./src/drivers/host.ts)：选项 Schema、默认配置、依赖候选和能力路线。
- [host 授权与使用](./docs/HOST.md)：连接已有桌面；禁止生命周期管理，必须经过用户确认。
- [Sway 最小配置](./defaults/sway.config)：没有 bar、用户配置 include、自启动命令或应用快捷键绑定。
- [沙盒与桌面资源说明](./docs/SANDBOX.md)：DSH 执行边界、字体/GTK 主题、XDG 与 WM 配置的区别。
- [类型化示例](./examples/contracts.ts)、[声明校验](./scripts/check-contracts.mjs)。

插件入口为 [index.mjs](./index.mjs)，运行时位于 [engine.mjs](./src/runtime/engine.mjs)、[platform.mjs](./src/runtime/platform.mjs) 和 [drivers.mjs](./src/runtime/drivers.mjs)。原始讨论保存在 [OUTLINE.md](./OUTLINE.md)。

## 实例与应用分开

本节指 kind=managed 的受管实例；host 只连接已有桌面，见下文。受管实例代表图形环境。start 不接受应用命令；环境可以先运行，之后 exec 一次或多次。每次 exec 创建独立 applicationId，应用退出不自动停止环境。停止实例会清理其中所有受管应用与 helper，并保留产物。

```text
实例：starting → running → stopping → stopped
                     └── 自行退出/异常 → exited / failed

应用：starting → running → exited
          └── 启动失败 → failed
```

环境 running 且没有 starting/running 应用，即为空闲状态，不额外维护 idle。实例状态返回应用数量；应用历史通过 inspect applications 分页读取。驱动负责环境状态，工具层通过受管应用进程更新应用状态。进程运行不代表窗口已经显示，也不代表应用已经响应输入。

Cage 使用不带应用的启动模式，后续应用连接同一 socket；已核对 Cage 0.3.1 源码支持该模式。不得通过 sleep 等占位程序伪造独立环境。其他版本需确认能力，不支持时明确报告。Sway 也先独立启动，再执行应用。

## 实例配置

最小 Cage 配置：

```json
{
  "schemaVersion": 1,
  "driver": { "id": "cage" }
}
```

Sway 配置示例：

```json
{
  "schemaVersion": 1,
  "driver": {
    "id": "sway",
    "options": { "config": { "source": "bundled", "name": "minimal" } }
  },
  "mode": "headless",
  "display": { "width": 1280, "height": 720, "scale": 1 },
  "desktopSettings": "inherit"
}
```

公共默认值：无头、1280×720、缩放 1、继承用户桌面设置、环境启动超时 15 秒、停止超时 5 秒。start 不指定来源时使用 Cage 默认配置。nested 表示宿主桌面中的独立 compositor 窗口。

公共 Schema 使用 JSON Schema 2020-12，以 TypeScript 常量 instanceConfigSchema 导出，可直接序列化为 JSON。driver id 是开放字符串；driver.options 另用注册驱动的 optionsSchema 校验。公共 Schema 不写死 Cage/Sway 分支。

配置解析：确定 start 的来源 → 公共/驱动默认值 → profile 或内联配置 → start overrides → 最终校验和依赖探测。JSON Schema 的 default 只是声明，不自动填充值。env 按键叠加、null 移除继承变量；driverOptions 按顶层键覆盖，嵌套对象和数组整体替换；display 提供时必须完整给出。

start overrides 只影响新实例，不改变 driver id。exec 只允许应用级 cwd、env 和启动超时，不重新选择驱动或修改已启动环境。exec 的默认 cwd/env 来自实例配置，启动超时不是应用寿命限制。相对应用/用户配置路径以工作区根目录为基准，驱动内置资源路径以驱动包为基准。

profile 按工作区保存配方，put 完整替换，delete 不停止活实例。实例持有自己的配置快照。对外展示配置和日志时遮蔽敏感环境值。

## WM 配置与桌面设置

WM 的配置入口由驱动独立控制，不通过替换整个 XDG_CONFIG_HOME 实现：

- Cage 不需要 WM 配置文件。
- Sway 显式使用 --config 指向实例 wmConfigDirectory 中生成的文件，默认 base 是内置最小配置；file/inline 可以替换 base。
- 其他 WM 的配置参数或搜索规则由对应驱动处理。

应用的 desktopSettings 与此独立：inherit 默认保留用户 XDG config/data/state，让 GTK、Fontconfig 等读取桌面资源；private 使用实例私有的三个 XDG 目录。两种方式都保持实例专属 runtime 和 cache，保留系统资源目录与已有字体/主题环境。private 不等于空白 HOME 或文件沙盒。

受管实例的连接变量（XDG_RUNTIME_DIR、WAYLAND_DISPLAY、DISPLAY、XAUTHORITY、SWAYSOCK、I3SOCK、DBUS_SESSION_BUS_ADDRESS）、后端选择变量（WLR_BACKENDS、WLR_HEADLESS_OUTPUTS）与 XDG_CACHE_HOME 由实例管理。private 模式下三个 XDG settings 目录也由实例管理。冲突配置返回 INVALID_CONFIG；字体/主题资源变量仍可通过 env 明确覆盖。

继承字体和主题不表示自动开放用户目录写权限、宿主 D-Bus 服务或 GPU 设备。具体边界和诊断见[沙盒说明](./docs/SANDBOX.md)。

## host：连接当前桌面

host 是只读的现有桌面连接。gui_debug_host connect 先请求用户确认，获准后返回 kind=host 的实例引用，供统一 capture/inspect 使用；disconnect 只撤销插件引用和观测权限，不停止真实桌面。

host 没有 start、exec、stop 或输入操作，不改 WM、分辨率、桌面设置或窗口。授权绑定根会话、连接、配置和操作范围，不能由工具参数或 profile 授予；拒绝、取消、确认不可用时不执行。现有 DSH 执行限制仍然生效。初始截图路线是支持相应 Wayland 协议的 grim，不声明兼容所有桌面。详见 [host 契约](./docs/HOST.md)。

## 统一工具

| 工具 | 请求 | 结果 |
| --- | --- | --- |
| gui_debug_drivers | list / describe / check | 驱动目录、选项及默认配置、只读依赖检查 |
| gui_debug_profile | list / get / put / delete | 工作区持久化配方 |
| gui_debug_host | connect（reason、scopes、可选 options）/ disconnect | 经用户确认的 host 引用，或撤销结果 |
| gui_debug_start | 可选 source 和 overrides，无应用命令 | 空受管实例 id、状态、沙盒信息、输出和能力 |
| gui_debug_exec | 受管 instanceId、command、应用级覆盖 | applicationId、进程状态与日志入口 |
| gui_debug_capture | instanceId、输出/区域/窗口目标 | PNG 附件、captureId、尺寸和坐标元数据 |
| gui_debug_input | instanceId、动作数组、captureAfter | 完成数量、首个失败动作、可选截图 |
| gui_debug_inspect | list / status / applications / logs | 实例/应用分页目录、状态、窗口或有界日志 |
| gui_debug_stop | 受管 instanceId | 停止状态、残留进程 id、保留的产物目录；host 禁止 |

日志默认读取 driver；读取某次应用日志时使用 source: { kind: 'application', applicationId }。实例仍可没有任何应用。首版 stop 停止整个实例，不提供单独终止某个应用或跨 DSH 重启接管实例的接口。

每个工具返回 Result<T>。调用级错误为 { ok: false, error: { code, message, ... } }。输入部分执行后，用 completedActions/failedAction 表达；操作后截图失败单独填写 captureError，不能使已经产生的输入副作用消失。

Cordis 入口已注册 execute、output.schema 和附件渲染。日志省略 cursor 时读取最近一页；应用记录会把省略的 command.args 解析为 []。用户可输入 /gui-debug-disconnect-host 撤销本会话全部 host 读取授权；grant/confirm 不作为模型工具公开。

## 截图与输入语义

- 默认截主输出。区域坐标是输出局部逻辑坐标；直接窗口捕获需要 capture.window，不用可能被遮挡的屏幕裁剪冒充窗口内容。
- 绝对输入携带 captureId 和原图像素坐标。工具层用驱动返回的仿射映射换算成布局逻辑坐标，再派发给驱动。
- 检查截图归属、范围和布局版本；映射不可用、窗口移动等使旧映射失效时要求重新截图。坐标点击同时需要绝对定位与点击能力。
- 动作包括文本、按键/修饰键、定时长按、相对/绝对移动、点击、滚动、拖拽、焦点和等待。各动作结束后释放键/按钮，不跨工具调用保留按下状态。
- 一批最多 64 个动作，显式等待/长按/拖拽总时长最多 30 秒。同一实例的 exec、输入、截图和停止顺序调度；输入遇错不回滚已执行动作。
- 派发前检查整批形状、能力和坐标，每步执行前仍确认实例与布局。wait 由工具层处理。
- captureAfter 在部分失败后仍尝试截图，但不保证应用异步绘制已经完成。

当前后端支持输出/区域截图、文本、按键/长按、相对移动、当前位置点击和滚动；Sway 另支持稳定窗口 id 的列表及聚焦。绝对定位、带坐标点击、拖拽和直接窗口截图均明确报告不可用。captureAfter 默认 false；wait 使用 durationMs。截图若被附件服务缩小，坐标映射按交付尺寸调整；实际可用性以实例 capabilities 为准。

## 驱动与执行边界

DriverDeclaration 描述静态元数据；统一 GuiDriver<Options, Handle> 按 kind 区分 ManagedGuiDriver 与 HostGuiDriver。受管驱动必须实现：

- probe：只读预检，不创建环境。预检能力是估计，实际能力在环境启动后确认。
- start：只启动环境，返回 Handle 和环境快照。
- exec：在该 Handle 对应的环境中启动应用，返回应用记录与受管进程。
- inspect：刷新环境、输出、窗口和能力。
- capture / input：完成统一操作，具体选用原生能力、IPC 或外部工具。
- stop：清理驱动资源与受管进程，报告残留并保留证据。

HostGuiDriver 只声明 probe、connect、inspect、capture、disconnect，并使用持有有效用户确认收据的 HostDriverContext；它没有受管驱动的生命周期或输入方法。类型品牌不代替运行时授权登记与检查。

受管驱动的所有启动都经过 DriverContext.processes；host 只能使用受授权约束的 HostDriverContext.helpers。工具层先登记所有权，再按 DSH 本次会话策略包装 argv，通过 DSH subprocess 启动。预检和未登记完成的启动也绑定会话取消范围；执行前在最后一个异步准备步骤之后重新核对当前策略。受管环境 start 失败即使没有 Handle，也能回收已登记进程；应用启动交接完成后脱离调用取消信号，继续绑定实例生命周期。

并发 start 与等待用户确认的 host connect 共同预占最多 16 个活动名额，登记实例、失败或取消时释放预占。策略变化会取消旧会话范围、终止旧受管实例或撤销 host 引用；之后的新调用使用新的会话范围。会话清理成功会释放实例、Agent 和进程输出的内存引用，同时保留磁盘证据；清理失败的范围保留最小所有权信息供重试。

helper 根进程完成后先有界回收残留范围，再排空输出，避免后代持有管道造成错误超时。Sway 配置文件通过非阻塞打开及普通文件检查，按字节有界读取至 1 MiB，并响应启动取消和截止时间；仍支持指向普通配置文件的符号链接，设备和 FIFO 则在读取前拒绝。

独立显示环境本身不等于文件沙盒。沙盒策略不是 profile 的可配置选项。受管实例 runtime/cache/WM 配置应放在跨调用可见、策略允许的工作区实例目录，避免不同 bwrap 调用的私有 /tmp 隔断 socket。host 保留已确认的真实桌面连接，自己的日志和产物仍放在策略允许的目录。

外部工具由用户提供，插件不安装它们。缺少 grim 可以使截图不可用而环境仍能启动；不满足请求尺寸等启动条件则失败。Cage 空启动要求可验证的版本 ≥ 0.3.1。Sway 当前不提供绝对指针定位和拖拽。当前应用路由只支持原生 Wayland，xwayland: true 明确失败；Cage 编译进的 lazy XWayland 不一定能关闭，false 表示插件不提供 X11 应用连接，Sway 配置则显式关闭它。

## 校验与开发环境

需要 Node 24+、DSH 0.2.0-rc.2 和 Linux/POSIX 本地执行环境。文件与进程 provider 必须共享同一个路径一致的本地工作区，远程执行世界当前明确拒绝。发布前会把 TypeScript 声明编译为 JavaScript，避免安装到 node_modules 后依赖类型擦除。

[flake.nix](./flake.nix) 的 devShell 提供 Node、pnpm，以及测试用 Cage、Sway、grim、wtype、wlrctl、wayland-info、wlr-randr 和 foot。使用 nix develop path:. 进入；不会自动启动 compositor 或改变插件由用户提供运行依赖的边界。

已有开发依赖时运行：

```sh
npm run check
npm run build
npm pack --dry-run
```

校验包含公共/驱动 Schema、类型、基础边界和可控运行时测试。运行时模块通过 tsconfig.runtime.json 纳入 checkJs；实际驱动工厂、截图、快照和预检结果直接接受公共契约检查，build 也执行这项检查。声明层继续使用严格 TypeScript 配置；运行时采用渐进式检查，保留严格空值与可选属性检查，但暂未开启隐式 any 和数组索引检查，因此不代表整个运行时已完全类型化。

纯 wait 动作在批次预检后只重新核对策略并响应取消，不为每一步启动显示探测 helper；后续实际输入仍刷新布局。按键 helper 的超时预算包含请求的长按时长和键盘初始化开销，单次长按上限仍为 10 秒。

原生联调脚本使用实际 DSH fs/subprocess/sandbox provider、合成测试会话与私有无头显示，不连接真实桌面：

```sh
GUI_DEBUG_DSH_MANIFEST=/path/to/dsh/package.json \
  nix develop path:. --command node scripts/native-integration.mjs
```

显式 path flake 会复制工作树，活 socket 可能阻断复制，应在启动环境前准备开发 shell。已经运行的 DSH 不会继承新终端的 PATH；可在驱动 options.executables 中提供已有工具的绝对路径。安装开发目录前运行 npm run build，再使用 DSH 的 plugin_manager install_bundle；npm pack 的 prepack 会自动编译。安装包使用 [cordis.patch.yml](./cordis.patch.yml) 注册插件，不需要手工修改 profile 文件。

Sway 使用自身 IPC 设置显示模式和缩放。[Sway 1.12 的初始 socket 检查](https://raw.githubusercontent.com/swaywm/sway/1.12/sway/ipc-server.c)发生在应用 SWAYSOCK 之前，因此实例使用短 id，并在启动前按当前 Linux PID 上界检查 IPC 路径。工作区路径过长时会明确拒绝启动。

本机原生验证发现：当前 Landlock workspace-write 确实阻止越界写入，但 Cage/wlroots 的输出缓冲区分配失败。插件在该执行器下返回 SANDBOX_UNAVAILABLE，保留日志并回收进程，不改变会话策略。全权限无头 Cage/Sway 的渲染验证与这个限制分开报告。

真实桌面授权 UI、nested 父窗口与 GTK/GSettings 的主题一致性不由这些无头测试证明。私有显示连接和路径检查也不替代操作系统对恶意同 UID 进程的安全隔离。
