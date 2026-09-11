@echo off
rem 二次开发版 dsh 启动器（Windows）：指向官方仓库的源码构建
rem （0.1.5-rc.2 + 「透传服务端原生 web_search」补丁）。
rem
rem 对应 macOS 的 packaging/dsh（bash 版）。两者都刻意「指向仓库运行」而不是
rem 把构建产物 npm i -g 安装：那样依赖会从 registry 重新解析，
rem @earendil-works/pi-ai 会拿到未打补丁的副本，服务端 web_search 透传随之失效。
rem 指向仓库运行可让 app-boot 把 profile 的共享包链接指向仓库内那份实现。
rem
rem 安装：把本目录（<仓库>\packaging）加入用户 PATH，之后任意终端可直接运行 dsh。
rem   例如：setx PATH "%PATH%;D:\AppCodes\deepseek-harness\packaging"
rem
rem 注意：本文件必须保持 CRLF 行尾，cmd.exe 对 LF-only 的 .cmd 会解析异常（见 .gitattributes）。

setlocal

set "HERE=%~dp0"
for %%I in ("%HERE%..") do set "REPO_ROOT=%%~fI"
set "CLI_ENTRY=%REPO_ROOT%\apps\cli\lib\bin.js"

if not exist "%CLI_ENTRY%" (
  echo dsh: 未找到构建产物 %CLI_ENTRY% 1>&2
  echo dsh: 请先在仓库根执行  pnpm install ^&^& pnpm run build:official 1>&2
  exit /b 1
)

rem 必须用系统 Node：Electron 自带的 node.exe 会让 process.execPath 指向 Electron 本体，
rem 使任何依赖 execPath 推导路径的逻辑（原生模块构建、Node-API 头文件定位）失败。
if defined DSH_NODE (
  set "NODE_BIN=%DSH_NODE%"
) else (
  set "NODE_BIN="
  for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_BIN set "NODE_BIN=%%N"
)

if not defined NODE_BIN (
  echo dsh: 找不到可用的 Node 运行时（可设 DSH_NODE 指定绝对路径） 1>&2
  exit /b 1
)

"%NODE_BIN%" "%CLI_ENTRY%" %*
exit /b %ERRORLEVEL%
