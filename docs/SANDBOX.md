# DSH 沙盒、WM 配置与桌面资源

本文描述已实现的受管环境执行边界。依据本机 DSH 0.2.0-rc.2 的 subprocess、sandboxPolicy 和 sandbox-local 接口核对；其他部署以实际 provider 和执行结果为准。host 使用已确认的真实连接，详情见 [HOST.md](./HOST.md)，同样受 DSH 文件策略约束。

## 三种配置分开管理

| 对象 | 来源和位置 | 管理责任 |
| --- | --- | --- |
| WM 自身配置 | 驱动包内置模板或用户明确提供的文件/文本，生成到实例 wmConfigDirectory | 驱动显式传入 WM 的配置参数；Sway 使用 --config，Cage 无配置文件 |
| 应用桌面设置 | 用户的 XDG config/data/state 和相关环境，或显式选择的私有 XDG 目录 | desktopSettings 控制，默认 inherit |
| 显示连接与可写缓存 | 实例 runtimeDirectory、cacheDirectory | 工具层分配；驱动使用实例连接，应用不得落回真实桌面 |

WM 配置参数不应通过替换整个 XDG_CONFIG_HOME 实现。即使应用继承用户 GTK 主题，Sway 也只读取显式传入的实例 WM 配置，不会自动加载用户桌面的 bar、快捷键和自启动项。其他 WM 若没有显式配置参数，如何隔离其配置是该驱动的内部职责，不改变所有应用的 XDG 目录。

## 什么时候存在 DSH 文件沙盒

本机 `ctx.subprocess` 的本地实现负责可执行文件解析、环境清理、进程启动和进程范围回收；普通 spawn 不会自动调用文件沙盒。systemd scope/进程组属于进程管理，不等于文件访问沙盒。

DSH 受限 bash 执行路径先通过 sandboxPolicy.resolve 得到本次会话的策略，再调用 sandbox.confine 包装 argv，最后交给 subprocess。danger-full-access 路径不加这层文件限制。

本插件也必须采用这一边界，不能直接调用未封装的 subprocess 或 node:child_process，使自定义工具绕开当前会话策略：

1. 工具层为每次实际操作解析调用会话策略，不把策略作为可由 profile/env/LLM 参数设置的选项。
2. DriverContext.processes 是工具层提供的受管入口。它先登记进程所有权，再按当前策略包装命令并通过 DSH subprocess 启动。compositor、应用以及截图/输入 helper 都经过它。
3. 实例记录实际模式、执行器与 enforcement。驱动不能为了读取主题、连接 socket 或使用 GPU 自动提升权限。
4. 实例属于创建它的会话执行策略。模式/工作区边界变化时，旧进程不会自动获得新的限制；工具层必须终止旧实例并要求重新创建，不能继续复用原有较宽权限的进程。
5. start 失败或取消，即使没有返回驱动 Handle，工具层仍通过进程登记回收已启动进程。操作取消信号与实例生命周期信号分开，成功返回 start 不能使实例随该工具调用结束而退出。

实例只属于创建它的调用会话，不跨会话接管。只读模式下，start、profile 写入和新 host 观测实例会在分配目录前返回 SANDBOX_DENIED；不会修改会话策略。沙盒执行器无法准备或包装命令时失败，不回退到无约束执行。当前要求文件和子进程 provider 共享路径一致的本地工作区，远程执行世界明确拒绝。

## 字体、主题通常是可读的

本机 sandbox-local 可能选择 Landlock、bwrap 或部署者配置的其他执行器。workspace-write 的标准可写根包含工作区与临时目录，read-only 不开放普通文件写入；实际实现和 enforcement 由 sandbox.confine 报告。字体和主题所需的系统/用户资源通常仍可读，但不把某一种 runner 的挂载布局推广到所有部署。

因此系统已有的 /etc/fonts、/nix/store、系统主题，以及用户目录中的可读配置通常仍然可见。不能把所有主题缺失归因于沙盒，也不能把这一点推广到部署者自定义的 runner。

另有两个与字体无关、但会影响运行的差异：

- 每次 bwrap 调用的私有 /tmp 不一定共享。跨调用需要复用的 Wayland socket、WM 配置、缓存和产物统一位于工作区 .dsh/gui-debug/instances/<id>/ 下的 runtime、wm、cache 和 artifacts。runtime 目录须由当前用户拥有、权限 0700，并注意 Unix socket 路径长度。
- bwrap 的最小 /dev 不保证提供 /dev/dri。驱动需诊断渲染器/设备问题，在支持的情况下选择软件渲染路径，或明确返回限制；不能把这类失败误报成字体或主题错误。

## 桌面设置策略

公共配置 `desktopSettings`：

- `inherit`（默认）：保留用户 HOME、XDG_CONFIG_HOME、XDG_DATA_HOME、XDG_STATE_HOME 的正常搜索语义，让应用读取 GTK 设置、用户 Fontconfig 配置、用户字体和主题。默认不会复制、改写这些配置。
- `private`：把上述三个 XDG home 目录放入实例私有目录，适合检查干净配置。系统搜索目录和已有 Fontconfig/主题环境仍按显式环境生效；它不等于空白 HOME，也不提供文件安全边界或完全可复现的主题。

两种模式都使用独立的 XDG_RUNTIME_DIR 和 XDG_CACHE_HOME；保留已有 XDG_CONFIG_DIRS、XDG_DATA_DIRS、FONTCONFIG_FILE、FONTCONFIG_PATH、GTK_THEME 等桌面资源定位信息。用户可以通过公共 env 或 exec 的应用 env 明确补充或移除这些资源变量。保留信息并不保证所指资源在当前执行世界中存在，驱动/工具层应报告实际路径问题。

fontconfig 会搜索用户 XDG 配置；重定向 XDG_CONFIG_HOME 可能改变字体匹配。GTK 也会根据 XDG 目录和环境变量寻找配置、主题和图标。因此不再使用原先默认开启的 isolateAppState。

继承配置的应用可能尝试写入用户目录；受限策略会拒绝这些写入。可显式使用 private 模式和所需的 env 覆盖。插件不会自动复制整个用户配置目录，也不会自动使用户目录可写。

GTK/GSettings 的部分偏好还可能来自 D-Bus、dconf 或 portal 服务，仅能读取文件不保证完全复现宿主桌面。插件不为主题显示自动创建用户服务、修改系统服务或放宽沙盒；已有连接也受部署策略约束。必要时可对测试应用显式设置 GTK_THEME 或相应桌面设置。

## NixOS 与启动环境

应调用用户安装的应用包装器，保留它提供的主题、图标、GSettings schema 和动态库路径，不擅自绕过包装器运行内部二进制文件。Nix store 中的资源路径应被当作路径使用，不硬编码某个包版本。

DSH 子进程继承的是 DSH 服务进程经敏感变量清理后的环境，不是任意新终端的环境。新终端进入 nix develop 不会回头改变已运行 DSH 的 PATH 或 XDG_DATA_DIRS。配置中的显式 executable 路径和 env 可以补充已知资源；开发环境也可以在启动 DSH 前准备好。不要直接复制 process.env 来规避 DSH 的敏感变量清理。

## 诊断顺序

1. 查看实例报告的沙盒模式、enforcement 和 desktopSettings。
2. 确认 WM 使用实例文件，应用使用实例 socket，两者没有错误地共享 XDG 配置覆盖。
3. 检查 Fontconfig 配置来源、字体是否可见，以及相关主题/数据目录；有条件时在相同受管执行环境内运行 fc-match/fc-list。
4. 再检查缓存写入失败、D-Bus/GSettings、渲染器和设备权限。

诊断对敏感环境字段和已知凭据脱敏，日志有界保存。可控运行时测试覆盖取消、清理、策略变化及只读拒绝；原生验证脚本使用实际 DSH provider 测试无头渲染、输入和文件写入限制。GTK/GSettings、nested 父窗口与真实桌面授权 UI 的表现仍需在对应部署中验证。

参考：[GTK 3 运行环境说明](https://docs.gtk.org/gtk3/running.html)、[Fontconfig 用户手册](https://fontconfig.pages.freedesktop.org/fontconfig/fontconfig-user.html)。
