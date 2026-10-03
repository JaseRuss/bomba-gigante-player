# Builds the Android app and copies the APK to the project root and the MEGA folder.
# Each run bumps the build number, which is shown in the app header so you can tell which build is installed.
$root = $PSScriptRoot
$tools = Join-Path $root 'android-tools'
$env:JAVA_HOME = Join-Path $tools 'jdk'
$env:ANDROID_HOME = Join-Path $tools 'sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$outputs = @($root)
# Optional: a folder to copy each build into, named in apk-output-dir.txt (not committed).
$extra = Join-Path $root 'apk-output-dir.txt'
if (Test-Path $extra) { $outputs += (Get-Content $extra -Raw).Trim() }

$counter = Join-Path $root 'android\build-number.txt'
$build = if (Test-Path $counter) { [int](Get-Content $counter) + 1 } else { 10 }

Push-Location (Join-Path $root 'android')
try {
    & (Join-Path $tools 'gradle-8.7\bin\gradle.bat') assembleDebug "-PbuildNumber=$build" --no-daemon --console=plain
    if ($LASTEXITCODE -ne 0) { throw "Gradle build failed" }
} finally { Pop-Location }
Set-Content -Path $counter -Value $build

$apk = Join-Path $root 'android\app\build\outputs\apk\debug\app-debug.apk'
foreach ($dir in $outputs) {
    if (Test-Path $dir) {
        # A unique name per build, so a phone can never install a stale same-named download by mistake.
        Get-ChildItem $dir -Filter 'GBPlayer*.apk' -File | Remove-Item -Force
        $name = "GBPlayer-build$build.apk"
        Copy-Item $apk (Join-Path $dir $name) -Force
        Write-Host "Copied build $build to $dir\$name"
    } else {
        Write-Warning "Skipped missing folder: $dir"
    }
}
