# 会话存储与崩溃恢复：提交验证

验证日期：2026-10-17。基于前端性能提交 `cd6ee3bc7f3dcd0adadeeb6899e801e7577dc815`，本次将剩余存储实现、恢复修复和可重复运行的测试整理为一个提交。

## 改动范围

- 分页会话恢复前先加载完整历史，再捕获 frame/branch 身份；保留加载中目标变化、加载失败、并发点击与 attachment 后的严格校验。
- 保存运行态事件时，在身份、revision 和新读取的文件指纹一致时复用同仓库已解码的数据，减少一次完整解析。待发布导入及磁盘标记的只读导入仍完整解码；外部替换、损坏和失效证据不能绕过校验。
- 复杂会话继续走完整读取，不再维护用不到的分页索引；旧 JSON 由 repository 原有快照路径写入；编码缓存只保留字节数，移除无效的 changed-ID 提示。
- 保留旧 JSON、JSONL 格式、运行态两秒保存调度及此前的前端重复保存修复。
- 将实际在途崩溃验证加入 `e2e/session-journal-recovery.spec.ts`。相关历史与恢复用例、两份按输入清单启用的 UI 性能测试接入现有 `test:e2e:regressions` 命令。
- 保留运行态基准的 `--prepared-input` 入口和来源哈希校验，以及确定性长回复夹具。修正 UI 测量夹具对浏览器只读数组的类型不匹配。

历史性能报告、原始 JSON、截图和本机诊断输出不包含在本次提交中；本说明不引用依赖个人目录的证据链接。

## 本地验证结果

| 检查                               | 结果                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| Main 存储、renderer 恢复与保存测试 | 65 个文件通过，1752 项通过；3 个按条件启用的基准文件、9 项测试未执行，不计入通过数 |
| i18n 与 E2E 执行归属检查           | 2 个文件、781 项通过                                                               |
| 真实 Electron 历史与恢复           | 7 个独立用例最终通过，无自动重试                                                   |
| Node、Web 和 sandbox 类型检查      | 通过                                                                               |
| 目标文件 lint、Prettier、diff 检查 | 通过                                                                               |
| `npm run build:e2e`                | 通过                                                                               |
| 基准入口校验                       | 5 个参数/来源拒绝检查通过；两份 JavaScript 文件语法检查通过                        |

Electron 覆盖旧 JSON 不被自动迁移或建立分页索引、新 JSONL 的分页与完整加载、分支保留、已完成会话强制崩溃、在途部分正文恢复，以及 Plan 的 Dismiss/Resume。

在途用例冻结隔离测试应用的 backend 后强制终止进程树，直接读取真实保存结果，不恢复伪造快照。重启后确认已保存正文逐字一致、没有自动重发，且界面仍是分页历史；点击 Resume 后完成生成、原用户消息仍只有一条，provider 调用恰好增加一次。原片段在完成后仍逐字一致；首段续传可见至完成后 6.5 秒，新 `sessions:save-session` 请求为零。显式恢复开始前的必要保存不纳入这个零请求窗口。

首次 Electron 执行有 6 项通过、1 项失败：新用例将首页会话按钮名称误写为只有标题，实际名称还包含项目和时间，故停在点击入口。依据保留的页面快照改为在 Recent sessions 区域内按精确标题子元素定位按钮，未减少恢复断言；仅重跑该失败用例后通过。初次失败不计入通过数。

## 复现命令

```bash
npx vitest run src/main/session-persistence src/renderer/src/lib/acp/workspace-runtime-interrupted-recovery.test.ts src/renderer/src/lib/acp/useWorkspaceAgentRuntime.test.ts src/renderer/src/lib/session-persistence/session-persistence.test.ts src/renderer/src/lib/session-persistence/session-history.test.ts --maxWorkers=2
npx vitest run src/renderer/src/i18n/resources.test.ts scripts/ci/e2e-execution-ownership.test.ts --maxWorkers=2
npm run typecheck:node:compiled
npm run typecheck:web:compiled
npm run build:e2e
npx playwright test e2e/session-journal-recovery.spec.ts e2e/session-history-pages.spec.ts e2e/session-plan-recovery.spec.ts --workers=1 --retries=0
```

在干净依赖安装中，先运行项目正常依赖安装与 package 构建流程，再执行上述 compiled 检查。UI 性能测试需要 `OPEN_SCIENCE_UI_PERF_INPUT` 指向保留来源信息的输入清单，默认跳过；此次未重新运行历史性能对照矩阵，也未宣称各场景性能都提升。

## 验证边界

- 本轮桌面验证为本机 macOS、隔离存储与可控模拟 provider，使用真实 Electron/backend/文件保存链路；未认证真实云模型和网络行为。
- 在途冻结用例依赖 POSIX `SIGSTOP`，在 Windows 显式跳过。本轮未执行 Linux、Windows 或完整远端 CI。
- 内容保留指崩溃前已落盘的正文，不承诺尚未落盘尾部零损失。
- 复用运行态数据、journal 写入故障和 owner 重试分别有测试；没有单个集成用例贯穿所有这些故障组合。
- 本次整理不处理历史对照报告中尚未解释的输入尾延迟、打开耗时波动或窗口诊断事件。
