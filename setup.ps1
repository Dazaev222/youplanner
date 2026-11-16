<#
  Умная настройка Claude Code для работы через шлюз ai-gateway.
  Что делает:
    1. Проверяет Node и Claude Code; чего нет — пытается поставить (winget / npm), не может — идёт дальше.
    2. Подключает одноразовый доступ только из персонального архива КотАна.
    3. АККУРАТНО вписывает 2 строки в %USERPROFILE%\.claude\settings.json (чужие настройки не трогает).
  Совместимо с Windows PowerShell 5.1 (без -AsHashtable; TLS 1.2 форсим явно).

  Запуск: распаковать весь персональный архив и открыть claude-ansar-local.bat.
#>
param(
    [string]$Gateway = "https://claude.ansarai.ru",
    [string]$AccessToken = "",
    [string]$SettingsPath = "",
    [switch]$Local,        # писать в .claude\settings.local.json ТЕКУЩЕЙ папки, а не в глобальный ~/.claude
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12  # LE-серты требуют TLS1.2+

function Info($m)  { Write-Host $m }
function Ok($m)    { Write-Host $m -ForegroundColor Green }
function Warn($m)  { Write-Host $m -ForegroundColor Yellow }
function Err($m)   { Write-Host $m -ForegroundColor Red }

# PSCustomObject -> вложенные хэштаблицы (в 5.1 нет ConvertFrom-Json -AsHashtable).
function ConvertTo-HashtableCompat($obj) {
    if ($null -eq $obj) { return @{} }
    if ($obj -is [System.Collections.IDictionary]) { return $obj }
    $ht = @{}
    foreach ($p in $obj.PSObject.Properties) {
        $v = $p.Value
        if ($v -is [PSCustomObject]) { $v = ConvertTo-HashtableCompat $v }
        $ht[$p.Name] = $v
    }
    return $ht
}

Info "=== Настройка Claude Code ==="

$accessTokenFile = Join-Path $PSScriptRoot "ansarium-access-token.txt"
if (-not $AccessToken -and (Test-Path -LiteralPath $accessTokenFile)) {
    $AccessToken = (Get-Content -LiteralPath $accessTokenFile -Raw -Encoding UTF8).Trim()
}
if (-not $AccessToken) {
    Err "В этой папке нет персонального файла доступа."
    Info "Попросите КотАна отправить новый архив, распакуйте его целиком в папку занятий и запустите claude-ansar-local.bat."
    Info "Код и имя вводить не нужно."
    exit 1
}

# 1. Node ----------------------------------------------------------------------
$hasNode = [bool](Get-Command node -ErrorAction SilentlyContinue)
if ($hasNode) {
    $nodeVersion = (node --version).Trim()
    Ok "Node уже есть: $nodeVersion"
} elseif (-not $SkipInstall) {
    Info "Node не найден. Пробую поставить..."
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        try {
            winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent | Out-Null
            $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
            $hasNode = [bool](Get-Command node -ErrorAction SilentlyContinue)
            if ($hasNode) { $nodeVersion = (node --version).Trim() }
        } catch { }
    }
    if ($hasNode) { Ok "Node установлен: $nodeVersion" }
    else { Warn "Не смог поставить Node сам. Поставьте Node.js 22 LTS или новее с nodejs.org и запустите снова." }
}

$nodeMajor = $null
if ($hasNode -and $nodeVersion -match '^v?(\d+)(?:\.|$)') { $nodeMajor = [int]$Matches[1] }

# 2. Claude Code CLI -----------------------------------------------------------
if ($hasNode -and -not $SkipInstall) {
    if (Get-Command claude -ErrorAction SilentlyContinue) {
        Ok "Claude Code уже есть."
    } else {
        Info "Claude Code не найден. Ставлю (npm i -g)..."
        try { npm install -g @anthropic-ai/claude-code 2>$null | Out-Null; Ok "Claude Code установлен." }
        catch { Warn "Не смог поставить Claude Code сам (права?). Вручную: npm i -g @anthropic-ai/claude-code" }
    }
}
if (-not $hasNode) {
    Err "Сначала установите Node.js 22 LTS или новее с nodejs.org и запустите этот файл снова. Персональный доступ пока не использован."
    exit 1
}
if ($null -eq $nodeMajor -or $nodeMajor -lt 22) {
    Err "Для Claude Code нужен Node.js 22 или новее. Сейчас установлен: $nodeVersion. Обновите Node.js с nodejs.org и запустите этот файл снова. Персональный доступ пока не использован."
    exit 1
}
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Err "Сначала установите Claude Code и запустите этот файл снова. Персональный доступ пока не использован."
    exit 1
}

# 3. Подключение персонального доступа -----------------------------------------
Info "Подключаю доступ..."
try {
    $body = @{ grant = $AccessToken } | ConvertTo-Json
    $resp = Invoke-RestMethod -Uri "$Gateway/enroll" -Method Post -ContentType "application/json" -Body $body
    $token = $resp.token
} catch {
    Err "Не удалось подключить доступ. Попросите КотАна отправить новый архив. Если не поможет — напишите администратору."
    exit 1
}
if (-not $token) { Err "Не удалось подключить доступ. Попросите КотАна отправить новый архив. Если не поможет — напишите администратору."; exit 1 }

# 4. Мерж settings.json (чужое не затираем) ------------------------------------
if (-not $SettingsPath) {
    if ($Local) {
        # Локальный режим: настройки ТОЛЬКО для текущей папки. Пишем в settings.local.json — этот
        # scope перекрывает user/project лишь здесь, поэтому основной (глобальный) Claude не меняется.
        $claudeDir = Join-Path (Get-Location) ".claude"
        if (-not (Test-Path $claudeDir)) { New-Item -ItemType Directory -Path $claudeDir -Force | Out-Null }
        $SettingsPath = Join-Path $claudeDir "settings.local.json"
    } else {
        $claudeDir = Join-Path $env:USERPROFILE ".claude"
        if (-not (Test-Path $claudeDir)) { New-Item -ItemType Directory -Path $claudeDir -Force | Out-Null }
        $SettingsPath = Join-Path $claudeDir "settings.json"
    }
}

$settings = @{}
if (Test-Path $SettingsPath) {
    try {
        $parsedSettings = Get-Content -LiteralPath $SettingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($parsedSettings -isnot [PSCustomObject] -and $parsedSettings -isnot [System.Collections.IDictionary]) {
            throw "Корневое значение JSON должно быть объектом."
        }
        $settings = ConvertTo-HashtableCompat $parsedSettings
    } catch {
        Err "Не удалось прочитать существующий файл настроек: $SettingsPath"
        Info "Исправьте JSON вручную и запустите установщик снова. Файл не изменён."
        exit 1
    }
}

if ($Local) {
    # BASE_URL с токеном будет записан в этот файл. Создаём .gitignore до записи токена,
    # даже если папка ещё не является Git-репозиторием.
    $gi = Join-Path (Get-Location) ".gitignore"
    $line = ".claude/settings.local.json"
    if (-not (Test-Path -LiteralPath $gi)) { New-Item -ItemType File -Path $gi -Force | Out-Null }
    if (-not ((Get-Content -LiteralPath $gi -Encoding UTF8 -ErrorAction SilentlyContinue) -contains $line)) {
        Add-Content -LiteralPath $gi -Value $line -Encoding UTF8
        Info "В .gitignore добавлено: $line"
    }
}
if (-not $settings.ContainsKey('env') -or -not ($settings['env'] -is [System.Collections.IDictionary])) {
    $settings['env'] = ConvertTo-HashtableCompat $settings['env']
}
$settings['env']['ANTHROPIC_BASE_URL']   = "$Gateway/s/$token"
$settings['env']['ANTHROPIC_AUTH_TOKEN'] = $token

# statusLine: строка внизу Claude Code с остатком бюджета. Копируем скрипт рядом с settings и
# прописываем команду (пути с прямыми слэшами — так требует Claude Code на Windows).
$slSrc = Join-Path $PSScriptRoot "ai-gateway-statusline.cjs"
if (Test-Path $slSrc) {
    $slDst = Join-Path (Split-Path -Parent $SettingsPath) "ai-gateway-statusline.cjs"
    Copy-Item $slSrc $slDst -Force
    $settings['statusLine'] = @{
        type            = 'command'
        command         = 'node "' + ($slDst -replace '\\', '/') + '"'
        refreshInterval = 10
    }
}

$json = $settings | ConvertTo-Json -Depth 20
$temporarySettingsPath = Join-Path (Split-Path -Parent $SettingsPath) ("." + [System.IO.Path]::GetRandomFileName())
try {
    [System.IO.File]::WriteAllText($temporarySettingsPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $SettingsPath) {
        [System.IO.File]::Replace($temporarySettingsPath, $SettingsPath, $null)
    } else {
        [System.IO.File]::Move($temporarySettingsPath, $SettingsPath)
    }
} finally {
    if (Test-Path -LiteralPath $temporarySettingsPath) { Remove-Item -LiteralPath $temporarySettingsPath -Force }
}
if ($AccessToken -and (Test-Path -LiteralPath $accessTokenFile)) {
    Remove-Item -LiteralPath $accessTokenFile -Force -ErrorAction SilentlyContinue
}

Ok "Настроено: $SettingsPath"
Info ""
if ($Local) {
    Ok "Готово (ЛОКАЛЬНО). Claude Code в ЭТОЙ папке пойдёт через шлюз; в других папках — как раньше."
    Info "Откройте эту папку в VS Code (расширение Claude Code) или запускайте 'claude' из неё."
    if ($AccessToken) {
        Info "Остальные файлы архива остаются в папке проекта. Настройки подключения находятся в .claude — сохраните эту папку для работы через шлюз."
    }
} else {
    Ok "Готово. Откройте VS Code, установите расширение 'Claude Code' из маркетплейса (если ещё нет) — оно возьмёт эти настройки."
}
