$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Red = [ConsoleColor]::Red
$Pink = [ConsoleColor]::Magenta
$Dim = [ConsoleColor]::DarkGray
$White = [ConsoleColor]::White
$Green = [ConsoleColor]::Green

function Show-Frame([string]$Stage, [string]$Detail) {
    Clear-Host
    Write-Host ""
    Write-Host "  ╔══════════════════════════════════════════════════════════════╗" -ForegroundColor $Red
    Write-Host "  ║  " -NoNewline -ForegroundColor $Red
    Write-Host "L" -NoNewline -ForegroundColor $White
    Write-Host " U C Y" -NoNewline -ForegroundColor $Pink
    Write-Host "  /  NEURAL INSTALLER" -NoNewline -ForegroundColor $Dim
    Write-Host "                         ║" -ForegroundColor $Red
    Write-Host "  ╠══════════════════════════════════════════════════════════════╣" -ForegroundColor $Red
    Write-Host "  ║  " -NoNewline -ForegroundColor $Red
    Write-Host ("{0,-56}" -f $Stage) -NoNewline -ForegroundColor $White
    Write-Host "║" -ForegroundColor $Red
    Write-Host "  ║  " -NoNewline -ForegroundColor $Red
    Write-Host ("{0,-56}" -f $Detail) -NoNewline -ForegroundColor $Dim
    Write-Host "║" -ForegroundColor $Red
    Write-Host "  ╚══════════════════════════════════════════════════════════════╝" -ForegroundColor $Red
    Write-Host ""
}

function Ask-Install([string]$Prompt) {
    Write-Host "  ◆ " -NoNewline -ForegroundColor $Red
    Write-Host $Prompt -ForegroundColor $White
    $answer = Read-Host "    Installer maintenant ? [o/N]"
    return $answer -match '^(o|oui|y|yes)$'
}

function Invoke-WingetInstall([string]$Id, [string]$ExtraArgs = "") {
    $args = @("install", "--id", $Id, "--exact", "--accept-package-agreements", "--accept-source-agreements")
    if ($ExtraArgs) {
        $args += @("--override", $ExtraArgs)
    }
    & winget @args
    if ($LASTEXITCODE -ne 0) {
        throw "Échec de l’installation de $Id (code $LASTEXITCODE)."
    }
}

Show-Frame "01  /  ENVIRONNEMENT" "Windows · vérification des dépendances"
$Missing = [System.Collections.Generic.List[string]]::new()
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { $Missing.Add("OpenJS.NodeJS.LTS") }
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { $Missing.Add("Rustlang.Rustup") }
$VsWhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$VsInstall = $null
if (Test-Path $VsWhere) {
    $VsInstall = & $VsWhere -latest -products "*" -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
}
if (-not $VsInstall) { $Missing.Add("Microsoft.VisualStudio.2022.BuildTools") }
$WebViewPaths = @(
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft\EdgeWebView\Application"),
    (Join-Path $env:ProgramFiles "Microsoft\EdgeWebView\Application")
)
$HasWebView = $false
foreach ($Path in $WebViewPaths) {
    if ((Test-Path $Path) -and (Get-ChildItem $Path -Directory -ErrorAction SilentlyContinue | Where-Object {
        Test-Path (Join-Path $_.FullName "msedgewebview2.exe")
    })) { $HasWebView = $true }
}
if (-not $HasWebView) { $Missing.Add("Microsoft.EdgeWebView2Runtime") }

if ($Missing.Count -gt 0) {
    Show-Frame "02  /  DÉPENDANCES MANQUANTES" ($Missing -join " · ")
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "winget est requis pour installer automatiquement les dépendances. Installe App Installer depuis le Microsoft Store, puis relance."
    }
    if (-not (Ask-Install "L’installateur va utiliser winget pour installer les outils requis.")) {
        throw "Installation annulée ; aucun outil manquant n’a été installé."
    }
    foreach ($Package in $Missing) {
        Show-Frame "02  /  INSTALLATION" $Package
        if ($Package -eq "Microsoft.VisualStudio.2022.BuildTools") {
            Invoke-WingetInstall $Package "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --norestart"
        } else {
            Invoke-WingetInstall $Package
        }
    }
} else {
    Show-Frame "02  /  DÉPENDANCES" "Node.js · Rust · MSVC · WebView2 déjà installés"
}

$env:Path = "$env:Path;$env:USERPROFILE\.cargo\bin;$env:ProgramFiles\nodejs"
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm est toujours introuvable après l’installation. Ferme et rouvre PowerShell, puis relance scripts/install.ps1."
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw "cargo est toujours introuvable après l’installation. Ferme et rouvre PowerShell, puis relance scripts/install.ps1."
}

if (-not $VsInstall) {
    $VsInstall = & $VsWhere -latest -products "*" -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
}
$VsDevCmd = Join-Path $VsInstall "Common7\Tools\VsDevCmd.bat"
if (-not (Test-Path $VsDevCmd)) { throw "VsDevCmd.bat introuvable dans l’installation Visual Studio." }

Show-Frame "03  /  COMPILATION" "Installation npm et compilation native Windows"
Push-Location $Root
try {
    $BuildCommand = "call `"$VsDevCmd`" -arch=x64 && cd /d `"$Root`" && npm ci && npm run tauri -- build --no-bundle"
    & cmd.exe /d /s /c $BuildCommand
    if ($LASTEXITCODE -ne 0) { throw "La compilation de LUCY a échoué (code $LASTEXITCODE)." }
} finally {
    Pop-Location
}

$Exe = Join-Path $Root "src-tauri\target\release\lucy.exe"
if (-not (Test-Path $Exe)) { throw "La compilation est terminée mais lucy.exe est introuvable." }
$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\Lucy"
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Copy-Item $Exe (Join-Path $InstallDir "lucy.exe") -Force

$DataDir = Join-Path $env:APPDATA "com.lucy.neural"
$StorePath = Join-Path $DataDir "lucy.json"
$SavedName = $null
if (Test-Path $StorePath) {
    try {
        $SavedName = (Get-Content -Raw -Path $StorePath | ConvertFrom-Json).userName
    } catch {
        throw "Impossible de lire les données existantes de LUCY : $($_.Exception.Message)"
    }
}
if (-not $SavedName) {
    Show-Frame "04  /  TON PROFIL" "Ce prénom reste sur cet ordinateur"
    do {
        $UserName = (Read-Host "  Comment tu t’appelles ? (prénom ou surnom)").Trim()
        $InvalidName = [string]::IsNullOrWhiteSpace($UserName) -or $UserName.Length -gt 60
        foreach ($Character in $UserName.ToCharArray()) {
            if ([char]::IsControl($Character)) { $InvalidName = $true }
        }
        if ($InvalidName) { Write-Host "  Entre un prénom/surnom de 1 à 60 caractères." -ForegroundColor $Red }
    } while ($InvalidName)

    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
    $ProfilePath = Join-Path $DataDir "lucy-initial-profile.json"
    $ProfileJson = @{ userName = $UserName } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($ProfilePath, $ProfileJson, [System.Text.UTF8Encoding]::new($false))
} else {
    $UserName = [string]$SavedName
}

Show-Frame "05  /  TERMINÉ" "LUCY · installation prête"
Write-Host "  Exécutable : $InstallDir\lucy.exe" -ForegroundColor $Green
Write-Host "  Salut $UserName — ton prénom est enregistré localement." -ForegroundColor $Dim
Write-Host ""
Read-Host "  Entrée pour fermer"
