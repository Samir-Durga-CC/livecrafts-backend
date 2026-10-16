@echo off
cd /d "%~dp0"
echo === Livecrafts backend (blog version) ===
if not exist ".env" (
  echo No .env file in this folder. Copy .env.example to .env and add your OPENAI_API_KEY, then run this again.
  pause
  exit /b 1
)
if not exist "node_modules\@ai-sdk\provider" (
  echo Installing backend packages ^(first start after an update^)...
  call npm install || goto :fail
)
echo Building the chat app...
call npm run build:web || goto :fail
echo Starting at http://127.0.0.1:8790  - keep this window open.
call npm start
pause
exit /b 0
:fail
echo Something failed above. Copy the error and send it to Claude.
pause
exit /b 1
