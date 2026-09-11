@echo off
rem 启动 DSH 交互式 TUI（Claude Code 风格的终端对话界面）—— Windows 版。
rem
rem 实现方式：走 dsh-tui profile —— 它把社区插件 @deepseek-harness-tui/dsh-tui 挂载在官方
rem dsh-base 之上。插件把框架包声明为 peerDependencies，因此运行时用的是「安装自身」
rem （本仓库构建的 0.1.5-rc.2），而不是插件自带副本；这正是它能与本仓库共存的原因，
rem 也让 pi-ai 的 web_search 透传补丁继续生效。
rem
rem profile 名必须叫 dsh-tui：插件自带的启动器按 %DSH_HOME%\profiles\dsh-tui 委托自己，
rem /update 自更新也依赖这个约定，改成别的名字会让它的自举/自更新失效。
rem
rem 安装：把本目录（<仓库>\packaging）加入用户 PATH。
rem
rem 注意：本文件必须保持 CRLF 行尾（见 .gitattributes）。

setlocal

set "HERE=%~dp0"
if not exist "%HERE%dsh.cmd" (
  echo dsh-tui: 缺少同目录的 dsh 启动器：%HERE%dsh.cmd 1>&2
  exit /b 1
)

if not defined DSH_HOME set "DSH_HOME=%USERPROFILE%\.dsh"
if not exist "%DSH_HOME%\profiles\dsh-tui" (
  echo dsh-tui: 未找到 dsh-tui profile（%DSH_HOME%\profiles\dsh-tui） 1>&2
  echo dsh-tui: 请先执行  dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui 1>&2
  exit /b 1
)

call "%HERE%dsh.cmd" --profile dsh-tui %*
exit /b %ERRORLEVEL%
