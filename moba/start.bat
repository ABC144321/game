@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo   裂谷战线 · MOBA + 塔防
echo ============================================
echo.

set PORT=8080
set PY=

where python >nul 2>nul && set PY=python
if "%PY%"=="" ( where python3 >nul 2>nul && set PY=python3 )
if "%PY%"=="" ( where py >nul 2>nul && set PY=py )

if "%PY%"=="" (
    echo [错误] 未检测到 Python。
    echo.
    echo 本项目使用 ES Module，浏览器不允许通过 file:// 直接加载模块，
    echo 因此需要一个本地 HTTP 服务器。请任选其一：
    echo   1. 安装 Python 后重新运行本脚本；
    echo   2. 使用 VS Code 的 Live Server 插件打开 index.html；
    echo   3. 使用 npx serve 或任意静态服务器。
    echo.
    pause
    exit /b 1
)

echo 使用 %PY% 启动本地服务器，端口 %PORT%
echo 浏览器将自动打开 http://localhost:%PORT%/
echo 关闭本窗口即可停止服务器。
echo.

start "" "http://localhost:%PORT%/"
%PY% -m http.server %PORT%

endlocal