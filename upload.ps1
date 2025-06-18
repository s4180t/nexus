param(
    [switch]$DryRun,
    [int]$StartFrom = 0
)

# Nexus npm repository URL
$NexusRepoUrl = "http://localhost:8081/repository/npm-hosted/"

# Get the full dependency tree (including transitive dependencies) as a PowerShell object
$DependencyTree = npm ls --json --all | ConvertFrom-Json

# Recursively extract all unique dependencies from the npm dependency tree
function Get-AllDependencies($Tree) {
    $script:Packages = @()
    function Extract-Dependencies($Deps) {
        foreach ($Dep in $Deps.PSObject.Properties) {
            $script:Packages += $Dep.Name
            if ($Dep.Value.dependencies) {
                Extract-Dependencies $Dep.Value.dependencies
            }
        }
    }
    Extract-Dependencies $Tree.dependencies
    return $script:Packages | Select-Object -Unique
}

# Get a flat list of all dependencies (including transitive ones), sorted alphabetically
$AllDependencies = Get-AllDependencies $DependencyTree | Sort-Object

# Ensure the 'archives' directory exists for storing all packed .tgz files
$ArchivesDir = Join-Path $PSScriptRoot "archives"
if (-not (Test-Path $ArchivesDir)) {
    New-Item -ItemType Directory -Path $ArchivesDir | Out-Null
}

$script:Errors = @()
# Pack and publish a single npm package tarball to Nexus
function Publish-Package($PackageName) {
    $RealPackage = $PackageName
    Write-Host "[Pack] Packing $RealPackage..." -ForegroundColor Yellow

    # Pack the npm package and capture the tarball filename
    $packOutput = npm pack $RealPackage --loglevel=error 2>&1
    $Tarball = $packOutput | Select-Object -First 1
    if (-not (Test-Path $Tarball)) {
        $msg = "[Warning] Tarball $Tarball not found for $RealPackage. Skipping. Output: $packOutput"
        Write-Warning $msg
        $script:Errors += $msg
        return
    }
    # Move the tarball to the 'archives' directory
    $ArchiveTarball = Join-Path $ArchivesDir $Tarball
    Move-Item -Force $Tarball $ArchiveTarball

    if ($DryRun) {
        # Simulate publishing the tarball (dry run)
        Write-Host "[Dry Run] Would publish $ArchiveTarball to $NexusRepoUrl" -ForegroundColor Cyan
        Write-Host "[Debug] PackageName: $RealPackage" -ForegroundColor DarkGray
        Write-Host "[Debug] Tarball: $ArchiveTarball" -ForegroundColor DarkGray
        Write-Host "[Debug] NexusRepoUrl: $NexusRepoUrl" -ForegroundColor DarkGray
        Write-Host "[Debug] Command: npm publish $ArchiveTarball --registry $NexusRepoUrl --dry-run --loglevel=error" -ForegroundColor DarkGray
        $publishOutput = npm publish $ArchiveTarball --registry $NexusRepoUrl --dry-run --loglevel=error 2>&1
        $script:exitCode = $LASTEXITCODE
    }
    else {
        # Actually publish the tarball to Nexus
        $publishOutput = npm publish $ArchiveTarball --registry $NexusRepoUrl --provenance=false --loglevel=error 2>&1
        $script:exitCode = $LASTEXITCODE
    }
    if ($script:exitCode -ne 0) {
        $msg = "[Error] npm publish failed for $RealPackage. Output: $publishOutput"
        Write-Error $msg
        $script:Errors += $msg
        return
    }
    else {
        Write-Host "[Success] $RealPackage published successfully!" -ForegroundColor Green
    }
}

# Publish all dependencies with progress counters
$script:Total = $AllDependencies.Count
$script:Index = 1
for ($i = $StartFrom; $i -lt $AllDependencies.Count; $i++) {
    $Package = $AllDependencies[$i]
    Write-Host ("[Progress] Publishing $($i+1) of $($script:Total): $Package") -ForegroundColor Magenta
    Publish-Package $Package
}

# Print completion message
if ($DryRun) {
    Write-Host "[Done] Dry run complete. All dependencies simulated for publish to Nexus!" -ForegroundColor Cyan
} else {
    Write-Host "[Done] All dependencies published to Nexus!" -ForegroundColor Green
}

# Show all errors at the end
if ($script:Errors.Count -gt 0) {
    Write-Host "\n===== ERRORS ENCOUNTERED =====" -ForegroundColor Red
    foreach ($err in $script:Errors) {
        Write-Host $err -ForegroundColor Red
    }
    Write-Host "===== END OF ERRORS =====" -ForegroundColor Red
}
