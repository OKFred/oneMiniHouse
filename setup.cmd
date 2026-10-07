@ECHO OFF
REM change CHCP to UTF-8
CHCP 65001
CLS

echo "⌛小程序脚手架初始化"

npm install & echo "✅初始化完成，请执行` npm run dev `"