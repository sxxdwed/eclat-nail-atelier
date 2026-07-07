$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" }
$envFile = Join-Path $PSScriptRoot ".env"
if (Test-Path $envFile) {
  Get-Content $envFile | Where-Object { $_ -match '^[A-Z_]+=' } | ForEach-Object {
    $name, $value = $_ -split '=', 2
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
  }
}
if (-not $env:BOT_TOKEN) { Write-Host "BOT_TOKEN не задан. Сайт запустится без Telegram." -ForegroundColor Yellow }
if (-not $env:CLIENT_BOT_TOKEN) { Write-Host "CLIENT_BOT_TOKEN не задан. Клиентские уведомления и отзывы отключены." -ForegroundColor Yellow }
if (-not $env:OWNER_CHAT_ID) { Write-Host "OWNER_CHAT_ID не задан. Уведомления владельцу отключены." -ForegroundColor Yellow }
if (-not $env:ADMIN_PASSWORD) { Write-Host "ADMIN_PASSWORD не задан. Вход новых администраторов отключён." -ForegroundColor Yellow }
& $node server.js
