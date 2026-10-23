# host：经用户确认后读取当前桌面

本文描述已实现的 host 边界。自动化测试使用可控授权及私有 fixture，不连接或读取真实桌面。

## 两种驱动

统一入口类型 GuiDriver 按 kind 区分：managed 管理插件拥有的环境，host 连接已有桌面。静态 DriverDeclaration 仍与运行函数契约分开。

| 操作 | managed（Cage/Sway） | host |
| --- | --- | --- |
| start 环境 | 支持 | 禁止 |
| exec 应用 | 支持 | 禁止 |
| stop 环境 | 支持 | 禁止 |
| 配置 WM、改变输出或管理窗口 | 由驱动管理自己的环境 | 禁止 |
| 键鼠输入/焦点变更 | 按实际能力开放 | 初版禁止 |
| 截图 | 按实际能力开放 | 需有效 capture 授权 |
| 读取桌面输出/协议信息 | 按实际能力开放 | 需有效 inspect 授权 |
| disconnect | 不适用 | 撤销插件引用及权限，不影响真实桌面 |

HostGuiDriver 没有 start、exec、input、stop 方法。HostDriverContext 没有 compositor/application 启动入口、WM 配置目录、私有显示 runtime 或桌面设置目录，仅提供受授权约束的观测 helper。GuiDriver 仍是统一注册类型，派发时先按 kind 缩小分支。

普通 start 即使从 profile 选到了 host，也必须在派发前返回 UNSUPPORTED_OPERATION；不能因配置 Schema 允许开放的 driver id 就把它当作可启动驱动。exec、stop、input、applications 查询也先检查实例 kind，再拒绝 host。没有隐式转换成 Cage、自动创建桌面或通过 shell 运行应用的后备路径。

## 请求与使用

新增 gui_debug_host，只提供两个动作：

```json
{
  "action": "connect",
  "reason": "检查用户指出的当前桌面渲染问题。",
  "scopes": ["inspect", "capture"]
}
```

connect 的作用是请求用户授权并创建插件连接引用，不启动 compositor。依赖存在性和配置合法性可以先检查；确认前不得连接真实显示服务、读取窗口/输出信息或截图。

确认界面应说明：当前会话、真实桌面标识、任务原因、请求的操作范围、实际截图/查询 helper 的路径与行为，以及图像/信息会作为工具结果交给模型。用户明确选择允许本次会话连接后，工具层才登记授权并返回 kind=host 的 instanceId。只请求 capture 时不得顺带读取窗口列表等 inspect 数据；必要的图像几何信息属于 capture 操作本身。

之后复用 gui_debug_capture、gui_debug_inspect。每次访问重新核对授权是否仍有效及操作 scope。inspect list 可以展示本会话已经建立的连接引用；实际查询桌面必须具备 inspect。host 应用列表不存在，日志限于插件自己产生的日志，不扫描其他程序的日志或文件。

```json
{ "action": "disconnect", "instanceId": "host-example" }
```

断开会撤销授权、取消本插件的观测任务并清理其 helper，保留截图和日志。重复断开安全。用户可以输入 /gui-debug-disconnect-host 撤销本会话全部 host 读取授权；用户命令和模型工具共用运行时撤销逻辑。授予权限始终通过用户专用确认入口。

## 用户确认是独立边界

模型不能传入 approved、confirmed、consent、凭据或字符串描述来证明授权。连接参数只表达请求；profile、继承的配置、danger-full-access 和先前给其他实例的许可都不能授予 host 权限。

HostConsent 是工具层发给驱动的内部收据。类型品牌只防止误用，实际安全边界是工具层的活动授权登记与逐次核对。收据绑定：

- 当前根会话及连接 instanceId；不能转交给子代理或其他会话使用。
- 实际桌面连接标识。
- 明确获准的 inspect/capture 范围。
- 已解析并冻结的 helper 路径及配置摘要。

配置、桌面连接或策略变化时撤销引用并重新确认，不能暗中扩大 scope。身份不匹配会关闭当前引用并清除收据；即使随后恢复原来的连接或配置，也不能复用旧授权。disconnect、会话结束、插件卸载和 DSH 重启使收据失效；不把活授权序列化到 profile 或通过恢复历史日志自动复活。用户撤销后取消在途 helper，返回附件前再次检查，避免继续交付新的桌面内容。

当前适配器使用 DSH userQuestions.ask 等待确切 live root 的回答，并记录请求、明确允许选项、scope、配置摘要、桌面 socket 身份和时间。只有所显示的允许选项才授予权限，自定义文字不授予；没有模型 grant/confirm 工具。当前要求会话有显式 ask 策略，未知或 never 均失败，不自动改变设置。DSH 提问入口采用可组合 answerer；这里信任部署者安装的提问/客户端插件，不能将答复视为独立的加密人类来源证明。

相应错误包括 HOST_CONFIRMATION_REQUIRED、HOST_CONFIRMATION_REJECTED、HOST_CONFIRMATION_UNAVAILABLE 和 HOST_ACCESS_REVOKED。权限不足时不自动提升策略或改用别人的桌面连接。

## 执行世界与桌面设置

host 连接 DSH 执行环境能够访问的现有桌面，不等于浏览器所在机器的桌面。远程 DSH、没有显示变量或无法访问 socket 时，明确报告不可用。

它使用已确认的真实桌面连接环境，不替换成 managed 实例的 XDG_RUNTIME_DIR、WAYLAND_DISPLAY 或 WM socket。不创建 WM 配置，不改变桌面设置、分辨率、焦点或用户应用。观测 helper 的临时文件、日志、图片和缓存仍放在允许写入的插件工作区目录。

用户同意 host 读取只是额外的授权条件，不会解除 DSH 文件沙盒。所有 helper 仍经过当前会话的 sandboxPolicy/sandbox/subprocess 边界；策略不允许访问连接或写产物时返回限制，不绕过执行器。

## 初始适配范围

已实现 grim 的输出/区域截图与 wayland-info 的输出/协议查询。目标需支持所需 Wayland 协议；能力由实际探测结果和授权范围决定。直接窗口截图、窗口列表与输入均不开放，不声明 GNOME/KDE/X11 的普遍兼容性。

后续可在 host 驱动内部增加桌面原生截图、其他用户安装的截图程序或合适的 portal 路线。平台自己的确认要求仍然适用，不能用插件收据代替它们。新增路线保持统一截图语义，并在连接前把实际 helper 与配置展示给用户。

运行时授权登记、逐次验证、附件交付前撤销检查及用户断开命令已有测试覆盖。真实桌面确认 UI 与真实读取未作为自动测试运行；其可用性取决于当前 DSH 的用户提问 provider 和桌面协议。
