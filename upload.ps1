param(
    [switch]$DryRun
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

# Get a flat list of all dependencies (including transitive ones)
$AllDependencies = Get-AllDependencies $DependencyTree

# Ensure the 'archives' directory exists for storing all packed .tgz files
$ArchivesDir = Join-Path $PSScriptRoot "archives"
if (-not (Test-Path $ArchivesDir)) {
    New-Item -ItemType Directory -Path $ArchivesDir | Out-Null
}

# Pack and publish a single npm package tarball to Nexus
function Publish-Package($PackageName) {
    Write-Host "[Pack] Packing $PackageName..."

    # Pack the npm package and capture the tarball filename
    $packOutput = npm pack $PackageName --loglevel=error
    $Tarball = $packOutput | Select-Object -First 1
    if (-not (Test-Path $Tarball)) {
        Write-Warning "[Warning] Tarball $Tarball not found for $PackageName. Skipping."
        $script:exitCode = 1
        return
    }
    # Move the tarball to the 'archives' directory
    $ArchiveTarball = Join-Path $ArchivesDir $Tarball
    Move-Item -Force $Tarball $ArchiveTarball

    if ($DryRun) {
        # Simulate publishing the tarball (dry run)
        Write-Host "[Dry Run] Would publish $ArchiveTarball to $NexusRepoUrl"
        Write-Host "[Debug] PackageName: $PackageName"
        Write-Host "[Debug] Tarball: $ArchiveTarball"
        Write-Host "[Debug] NexusRepoUrl: $NexusRepoUrl"
        Write-Host "[Debug] Command: npm publish $ArchiveTarball --registry $NexusRepoUrl --dry-run --loglevel=error"
        npm publish $ArchiveTarball --registry $NexusRepoUrl --dry-run --loglevel=error
        $script:exitCode = $LASTEXITCODE
    }
    else {
        # Actually publish the tarball to Nexus
        npm publish $ArchiveTarball --registry $NexusRepoUrl --provenance=false --loglevel=error
        $script:exitCode = $LASTEXITCODE
    }
    if ($script:exitCode -ne 0) {
        Write-Error "[Error] npm publish failed for $PackageName. Stopping script."
        exit $script:exitCode
    }
    else {
        Write-Host "[Success] $PackageName published successfully!"
    }
}

# Publish all dependencies with progress counters
$script:Total = $AllDependencies.Count
$script:Index = 1
foreach ($Package in $AllDependencies) {
    Write-Host ("[Progress] Publishing $($script:Index) of $($script:Total): $Package")
    Publish-Package $Package
    $script:Index++
}

# Print completion message
if ($DryRun) {
    Write-Host "[Done] Dry run complete. All dependencies simulated for publish to Nexus!"
} else {
    Write-Host "[Done] All dependencies published to Nexus!"
}
