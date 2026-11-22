# Read-only aggregation of coordinator task records and module progress signals.
# Windows PowerShell 5.1 or newer. Only RefreshBoard writes a derived BOARD.md.
[CmdletBinding()]
param(
    [ValidateSet('Status', 'RefreshBoard', 'Validate')]
    [string]$Action = 'Status',
    [string]$StateRoot = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Set-StrictMode -Version 2.0
$warnings = New-Object 'System.Collections.Generic.List[string]'
$signalStaleMinutes = 30
$now = [DateTimeOffset]::UtcNow
$jsonStringDates = (Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')

function Get-Field {
    param($Record, [string]$Name)
    if ($null -eq $Record) { return $null }
    $property = $Record.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return ,$property.Value
}

function Require-Text {
    param($Record, [string]$Name, [string]$Context)
    $value = Get-Field $Record $Name
    if ($value -isnot [string] -or [string]::IsNullOrWhiteSpace($value)) {
        throw "$Context 缺少有效字符串字段 $Name。"
    }
    return $value
}

function Require-Array {
    param($Record, [string]$Name, [string]$Context)
    $value = Get-Field $Record $Name
    if ($value -isnot [System.Array]) { throw "$Context 的 $Name 必须是 JSON 数组。" }
    return ,$value
}

function Require-Schema {
    param($Record, [string]$Context)
    $version = Get-Field $Record 'schema_version'
    if ($null -eq $version -or $version -is [string] -or $version -ne 1) {
        throw "$Context 的 schema_version 必须是数字 1。"
    }
}

function Require-ProtocolVersion {
    param($Record, [string]$Context, [int]$Expected = 1)
    $version = Get-Field $Record 'protocol_version'
    $numeric = $version -is [int] -or $version -is [long] -or
        $version -is [decimal] -or $version -is [double]
    if (-not $numeric -or $version -ne 1 -or $version -ne $Expected) {
        throw "$Context 的 protocol_version 必须是数字 1，并与 registry 协议版本一致。"
    }
    return [int]$version
}

function Parse-Timestamp {
    param($Value, [string]$Context, [switch]$Required)
    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) {
        if ($Required) { throw "$Context 缺少时间戳。" }
        return $null
    }
    $parsed = [DateTimeOffset]::MinValue
    if ($Value -isnot [string] -or $Value -notmatch '(Z|[+-]\d{2}:\d{2})$' -or
        -not [DateTimeOffset]::TryParse($Value, [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::AllowWhiteSpaces, [ref]$parsed)) {
        throw "$Context 必须是含时区的 ISO 8601 时间戳。"
    }
    return $parsed
}

function Assert-SafeStatePath {
    param([string]$FullPath, [string]$Context)
    if (-not $FullPath.StartsWith($script:statePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Context 路径越出 StateRoot：$FullPath"
    }
    # Lexical containment alone cannot protect against a directory junction or symlink.
    $part = $FullPath
    while ($part.Length -gt $script:stateDirectory.Length) {
        if (Test-Path -LiteralPath $part) {
            $item = Get-Item -LiteralPath $part -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "$Context 不允许经过重解析点或符号链接：$part"
            }
        }
        $part = Split-Path -Parent $part
    }
    return $FullPath
}

function Resolve-StatePath {
    param($RelativePath, [string]$Context)
    if ($RelativePath -isnot [string] -or [string]::IsNullOrWhiteSpace($RelativePath) -or
        [IO.Path]::IsPathRooted($RelativePath) -or $RelativePath -match '[<>:"|?*]') {
        throw "$Context 必须是 StateRoot 内的有效相对文件路径。"
    }
    $full = [IO.Path]::GetFullPath((Join-Path $script:stateDirectory $RelativePath))
    return (Assert-SafeStatePath $full $Context)
}

function Read-Json {
    param([string]$Path, [string]$Context)
    $null = Assert-SafeStatePath $Path $Context
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Context 文件不存在：$Path" }
    try {
        $json = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
        if ($script:jsonStringDates) {
            # Newer PowerShell otherwise turns ISO strings into DateTime values.
            $record = $json | ConvertFrom-Json -DateKind String
        } else { $record = $json | ConvertFrom-Json }
    } catch { throw "$Context JSON 读取或解析失败（$Path）：$($_.Exception.Message)" }
    if ($null -eq $record -or $record -is [System.Array] -or $record -is [string] -or
        $record -is [ValueType]) { throw "$Context 的 JSON 顶层必须是对象。" }
    return $record
}

function Visit-Task {
    param([string]$Id, [string[]]$Chain)
    if ($script:visits.ContainsKey($Id)) {
        if ($script:visits[$Id] -eq 1) { throw "任务依赖出现环：$(($Chain + $Id) -join ' -> ')" }
        return
    }
    $script:visits[$Id] = 1
    foreach ($dependency in $script:taskById[$Id].Dependencies) {
        Visit-Task $dependency ($Chain + $Id)
    }
    $script:visits[$Id] = 2
}

function Escape-Cell {
    param($Value)
    return ([string]$Value).Replace('|', '\|').Replace("`r", ' ').Replace("`n", ' ')
}

function Get-StatusLabel {
    param([string]$Status)
    switch ($Status) {
        'queued' { return '排队中' }
        'waiting_dependency' { return '等待依赖' }
        'dispatched' { return '已派发 / 进度未知' }
        'running' { return '运行中' }
        'awaiting_review' { return '待主会话验收' }
        'completed' { return '已验收完成' }
        'blocked' { return '受阻' }
        'cancelled' { return '已取消' }
        default { throw "未知聚合状态：$Status" }
    }
}

try {
    # Windows PowerShell 5.1 may bind parameter defaults before PSScriptRoot is set.
    if ([string]::IsNullOrWhiteSpace($StateRoot)) {
        $StateRoot = Join-Path (Split-Path -Parent $PSScriptRoot) '状态'
    }
    $stateDirectory = [IO.Path]::GetFullPath($StateRoot).TrimEnd('\', '/')
    if (-not (Test-Path -LiteralPath $stateDirectory -PathType Container)) {
        throw "StateRoot 目录不存在：$stateDirectory"
    }
    if (((Get-Item -LiteralPath $stateDirectory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'StateRoot 本身不能是重解析点或符号链接。'
    }
    $statePrefix = $stateDirectory + [IO.Path]::DirectorySeparatorChar
    $registry = Read-Json (Join-Path $stateDirectory 'registry.json') 'registry'
    Require-Schema $registry 'registry'
    $protocolVersion = Require-ProtocolVersion $registry 'registry'
    $coordinator = Get-Field $registry 'coordinator'
    foreach ($field in @('thread_id', 'title', 'host_id', 'mode')) {
        $null = Require-Text $coordinator $field 'registry.coordinator'
    }
    $projectById = @{}
    $moduleByKey = @{}
    $previousSessionsByModule = @{}
    $threadOwners = @{}
    foreach ($project in (Require-Array $registry 'projects' 'registry')) {
        $projectId = Require-Text $project 'id' 'project'
        $context = "project $projectId"
        foreach ($field in @('title', 'root', 'project_id', 'active_baseline')) {
            $null = Require-Text $project $field $context
        }
        if (-not [IO.Path]::IsPathRooted($project.root)) { throw "$context 的 root 必须是绝对路径。" }
        if ($projectById.ContainsKey($projectId)) { throw "重复的项目 ID：$projectId" }
        $projectById[$projectId] = $project
        foreach ($module in (Require-Array $project 'modules' $context)) {
            $roleId = Require-Text $module 'id' "$context.module"
            foreach ($field in @('title', 'thread_id', 'host_id')) {
                $null = Require-Text $module $field "$context.module $roleId"
            }
            if ($module.thread_id -ceq $coordinator.thread_id) {
                throw "当前模块会话不能与主控重复：$($module.thread_id)（$context/$roleId）"
            }
            foreach ($ownedPath in (Require-Array $module 'owned_paths' "$context.module $roleId")) {
                if ($ownedPath -isnot [string] -or [string]::IsNullOrWhiteSpace($ownedPath)) {
                    throw "$context.module $roleId 的 owned_paths 包含无效路径。"
                }
            }
            $key = $projectId + '/' + $roleId
            if ($moduleByKey.ContainsKey($key)) { throw "重复的模块 ID：$key" }
            if ($threadOwners.ContainsKey($module.thread_id)) {
                throw "模块会话重复登记：$($module.thread_id)（$key 与 $($threadOwners[$module.thread_id])）"
            }
            $moduleByKey[$key] = $module
            $threadOwners[$module.thread_id] = $key
        }
    }
    # Register current sessions first so history cannot claim a later module's identity.
    foreach ($key in $moduleByKey.Keys) {
        $module = $moduleByKey[$key]
        $previousByThread = @{}
        if ($null -ne $module.PSObject.Properties['previous_sessions']) {
            $index = 0
            foreach ($previous in (Require-Array $module 'previous_sessions' "module $key")) {
                $context = "module $key.previous_sessions[$index]"
                foreach ($field in @('thread_id', 'host_id')) {
                    $null = Require-Text $previous $field $context
                }
                if ($previous.thread_id -ceq $coordinator.thread_id -or
                    $threadOwners.ContainsKey($previous.thread_id)) {
                    throw "历史模块会话重复登记：$($previous.thread_id)（$context）"
                }
                $previousByThread[$previous.thread_id] = $previous
                $threadOwners[$previous.thread_id] = $key
                $index++
            }
        }
        $previousSessionsByModule[$key] = $previousByThread
    }

    $taskById = @{}
    $taskPathOwners = @{}
    $rows = New-Object 'System.Collections.Generic.List[object]'
    $tasksDirectory = Resolve-StatePath 'tasks' 'tasks'
    if (Test-Path -LiteralPath $tasksDirectory -PathType Container) {
        $taskFiles = @(Get-ChildItem -LiteralPath $tasksDirectory -Filter '*.json' -File | Sort-Object Name)
    } else {
        $taskFiles = @()
        $warnings.Add('tasks 目录不存在，当前没有可聚合的任务。')
    }
    foreach ($file in $taskFiles) {
        $task = Read-Json $file.FullName "task $($file.Name)"
        Require-Schema $task "task $($file.Name)"
        $null = Require-ProtocolVersion $task "task $($file.Name)" $protocolVersion
        foreach ($field in @('id', 'project_id', 'role_id', 'thread_id', 'run_id', 'title', 'kind', 'status', 'baseline_id')) {
            $null = Require-Text $task $field "task $($file.Name)"
        }
        $id = $task.id
        if ($taskById.ContainsKey($id)) { throw "重复的任务 ID：$id" }
        if ($task.status -notin @('queued', 'dispatched', 'awaiting_review', 'completed', 'blocked', 'cancelled')) {
            throw "task $id 的主状态无效：$($task.status)"
        }
        if (-not $projectById.ContainsKey($task.project_id)) { throw "task $id 引用了未登记项目 $($task.project_id)。" }
        $moduleKey = $task.project_id + '/' + $task.role_id
        if (-not $moduleByKey.ContainsKey($moduleKey)) { throw "task $id 引用了未登记模块 $moduleKey。" }
        $module = $moduleByKey[$moduleKey]
        $taskSession = $module
        $historicalSession = $task.thread_id -cne $module.thread_id
        if ($historicalSession) {
            if ($task.status -notin @('completed', 'cancelled')) {
                throw "task $id 的 thread_id 与当前登记模块不一致；未结束任务不能使用历史会话。"
            }
            $previousByThread = $previousSessionsByModule[$moduleKey]
            if (-not $previousByThread.ContainsKey($task.thread_id) -or
                $previousByThread[$task.thread_id].thread_id -cne $task.thread_id) {
                throw "task $id 的 thread_id 未登记在本模块 previous_sessions 中。"
            }
            $taskSession = $previousByThread[$task.thread_id]
        }
        if ($historicalSession -or $null -ne $task.PSObject.Properties['host_id']) {
            $taskHost = Require-Text $task 'host_id' "task $id"
            if ($taskHost -cne $taskSession.host_id) { throw "task $id 的 host_id 与匹配的登记会话不一致。" }
        }
        foreach ($path in (Require-Array $task 'allowed_write_paths' "task $id")) {
            if ($path -isnot [string] -or [string]::IsNullOrWhiteSpace($path)) {
                throw "task $id 的 allowed_write_paths 包含无效路径。"
            }
        }
        $dependencies = Require-Array $task 'dependencies' "task $id"
        foreach ($dependency in $dependencies) {
            if ($dependency -isnot [string] -or [string]::IsNullOrWhiteSpace($dependency)) {
                throw "task $id 的 dependencies 包含无效任务 ID。"
            }
        }
        $null = Parse-Timestamp (Get-Field $task 'created_at') "task $id.created_at" -Required
        $null = Parse-Timestamp (Get-Field $task 'dispatched_at') "task $id.dispatched_at"
        $acceptedAt = Parse-Timestamp (Get-Field $task 'accepted_at') "task $id.accepted_at"
        $reportPath = Resolve-StatePath (Get-Field $task 'report_path') "task $id.report_path"
        $signalPath = Resolve-StatePath (Get-Field $task 'signal_path') "task $id.signal_path"
        if ($reportPath -ieq $signalPath) { throw "task $id 的报告和信号不能共用一个文件。" }
        foreach ($pathEntry in @(@{ Kind = '报告'; Path = $reportPath }, @{ Kind = '信号'; Path = $signalPath })) {
            if ($taskPathOwners.ContainsKey($pathEntry.Path)) {
                throw "task $id 的$($pathEntry.Kind)路径与其他任务共用：$($taskPathOwners[$pathEntry.Path])；$($pathEntry.Path)"
            }
            $taskPathOwners[$pathEntry.Path] = "$id / $($pathEntry.Kind)"
        }
        $reportExists = Test-Path -LiteralPath $reportPath -PathType Leaf
        if ($task.status -eq 'completed' -and ($null -eq $acceptedAt -or -not $reportExists)) {
            throw "task $id 已标记 completed，但缺少 accepted_at 或报告文件。"
        }
        if ($task.status -eq 'awaiting_review' -and -not $reportExists) {
            throw "task $id 已标记 awaiting_review，但报告文件不存在。"
        }
        if ($task.baseline_id -cne $projectById[$task.project_id].active_baseline -and
            $task.status -notin @('completed', 'cancelled')) {
            $warnings.Add("$id：任务基线 $($task.baseline_id) 与项目当前基线不同，需主会话核对。")
        }

        $effective = $task.status
        $lastSignal = '未知（无信号）'
        $summary = ''
        $blockers = @()
        if (Test-Path -LiteralPath $signalPath -PathType Leaf) {
            $signal = Read-Json $signalPath "signal $id"
            $identities = @{
                task_id = $task.id
                run_id = $task.run_id
                role_id = $task.role_id
                baseline_id = $task.baseline_id
            }
            foreach ($field in $identities.Keys) {
                $actual = Require-Text $signal $field "signal $id"
                if ($actual -cne $identities[$field]) {
                    throw "signal $id 的 $field 不匹配（期望 $($identities[$field])，实际 $actual）；拒绝旧轮次或其他任务信号。"
                }
            }
            $signalStatus = Require-Text $signal 'status' "signal $id"
            if ($signalStatus -notin @('running', 'blocked', 'submitted')) { throw "signal $id 状态无效：$signalStatus" }
            $updated = Parse-Timestamp (Get-Field $signal 'updated_at') "signal $id.updated_at" -Required
            $lastSignal = $updated.ToString('yyyy-MM-dd HH:mm:ss zzz')
            $signalReport = Resolve-StatePath (Get-Field $signal 'report_path') "signal $id.report_path"
            if ($signalReport -ine $reportPath) { throw "signal $id 的 report_path 与任务记录不一致。" }
            $summaryValue = Get-Field $signal 'summary'
            if ($summaryValue -isnot [string]) { throw "signal $id 的 summary 必须是字符串。" }
            $summary = $summaryValue
            $blockers = Require-Array $signal 'blockers' "signal $id"
            foreach ($blocker in $blockers) {
                if ($blocker -isnot [string]) { throw "signal $id 的 blockers 必须只包含字符串。" }
            }
            if ($updated -gt $now.AddMinutes(5)) { $warnings.Add("$id：信号时间在未来，需检查时钟；不据此推断进展。") }
            if ($signalStatus -eq 'running' -and ($now - $updated).TotalMinutes -gt $signalStaleMinutes) {
                $warnings.Add("$id：运行信号已超过 $signalStaleMinutes 分钟未更新，当前活动未知；运行中仅表示最后一次上报。")
            }
            if ($signalStatus -eq 'submitted' -and -not $reportExists) {
                throw "signal $id 已上报 submitted，但报告不存在；不能进入待验收。"
            }
            # Final decisions belong solely to the coordinator's task record.
            if ($task.status -eq 'dispatched') {
                switch ($signalStatus) {
                    'running' { $effective = 'running' }
                    'blocked' { $effective = 'blocked' }
                    'submitted' { $effective = 'awaiting_review' }
                }
            } elseif ($task.status -eq 'queued') {
                $warnings.Add("$id：主任务仍为 queued，已有模块信号仅作诊断，保持排队状态。")
            }
        } elseif ($task.status -notin @('queued', 'completed', 'cancelled')) {
            $warnings.Add("$id：没有模块信号，模块执行进展未知；主任务状态为 $($task.status)。")
        }
        $row = [pscustomobject]@{
            Id = $id
            Project = $task.project_id
            Role = $task.role_id
            RoleTitle = if ($historicalSession) { $module.title + '（历史：' + $task.thread_id + '）' } else { $module.title }
            ThreadId = $task.thread_id
            HistoricalSession = $historicalSession
            Title = $task.title
            MasterStatus = $task.status
            EffectiveStatus = $effective
            Label = Get-StatusLabel $effective
            LastSignal = $lastSignal
            Summary = $summary
            Blockers = ($blockers | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join '；'
            Dependencies = $dependencies
            WaitingDependencies = @()
            ReportPath = $task.report_path
            ReportExists = $reportExists
        }
        $taskById[$id] = $row
        $rows.Add($row)
    }
    foreach ($row in $rows) {
        foreach ($dependency in $row.Dependencies) {
            if (-not $taskById.ContainsKey($dependency)) { throw "task $($row.Id) 的依赖任务不存在：$dependency" }
        }
    }
    $visits = @{}
    foreach ($id in $taskById.Keys) { Visit-Task $id @() }
    foreach ($row in $rows) {
        $unfinished = @($row.Dependencies | Where-Object { $taskById[$_].MasterStatus -ne 'completed' })
        $row.WaitingDependencies = $unfinished
        if ($unfinished.Count -gt 0) {
            $dependencyNote = '依赖尚未由主会话验收完成：' + ($unfinished -join '、')
            if ($row.MasterStatus -eq 'queued') {
                $row.EffectiveStatus = 'waiting_dependency'
                $row.Label = Get-StatusLabel 'waiting_dependency'
            } elseif ($row.MasterStatus -in @('dispatched', 'awaiting_review', 'blocked')) {
                $warnings.Add("$($row.Id)：已派发任务的$dependencyNote；不能视为依赖通过。")
            }
            $row.Blockers = (@($row.Blockers, $dependencyNote) | Where-Object { $_ }) -join '；'
        }
    }

    $counts = @{}
    $countParts = New-Object 'System.Collections.Generic.List[string]'
    foreach ($status in @('queued', 'waiting_dependency', 'dispatched', 'running', 'awaiting_review', 'completed', 'blocked', 'cancelled')) {
        $count = @($rows | Where-Object { $_.EffectiveStatus -eq $status }).Count
        $counts[$status] = $count
        $countParts.Add("$(Get-StatusLabel $status)：$count")
    }
    $generatedAt = $now.ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss zzz') + ' (' + [TimeZoneInfo]::Local.Id + ')'
    $countLine = $countParts -join '；'
    Write-Output "协作进度快照：$generatedAt"
    Write-Output "StateRoot：$stateDirectory"
    Write-Output "任务总数：$($rows.Count)；$countLine"
    Write-Output '进度按本次读取生成；请手动刷新。运行中为最后上报状态，只有主会话验收才能标为完成。'
    Write-Output "主会话：$($coordinator.title)；$($coordinator.thread_id)；$($coordinator.host_id)"
    if ($rows.Count -gt 0) {
        $table = $rows | Select-Object @{Name = '任务'; Expression = { $_.Id }},
            @{Name = '项目'; Expression = { $_.Project }}, @{Name = '模块'; Expression = { $_.Role }},
            @{Name = '登记会话'; Expression = { $_.RoleTitle }},
            @{Name = '状态'; Expression = { $_.Label }}, @{Name = '最近信号'; Expression = { $_.LastSignal }},
            @{Name = '标题'; Expression = { $_.Title }} | Format-Table -AutoSize | Out-String -Width 240
        Write-Output $table.TrimEnd()
        foreach ($row in $rows) {
            if ($row.Summary) { Write-Output "$($row.Id) 摘要：$($row.Summary)" }
            if ($row.Blockers) { Write-Output "$($row.Id) 阻碍：$($row.Blockers)" }
            if ($row.ReportExists) { Write-Output "$($row.Id) 报告：$($row.ReportPath)" }
        }
    }
    foreach ($warning in $warnings) { Write-Output "警告：$warning" }

    if ($Action -eq 'RefreshBoard') {
        $boardPath = Resolve-StatePath 'BOARD.md' 'BOARD.md'
        $lines = New-Object 'System.Collections.Generic.List[string]'
        $lines.Add('# 多会话协作进度')
        $lines.Add('')
        $lines.Add("更新时间：$generatedAt")
        $lines.Add('')
        $lines.Add('本表是手动刷新的派生快照，不会派工或改变任务状态。运行中为最后上报状态；完成仅以主会话验收记录为准。')
        $lines.Add('')
        $lines.Add("任务总数：$($rows.Count)；$countLine")
        $lines.Add('')
        $lines.Add('## 登记会话')
        $lines.Add('')
        $lines.Add('| 项目 | 模块 | 会话名称 | 会话 ID | 主机 |')
        $lines.Add('|---|---|---|---|---|')
        $coordinatorCells = @('跨项目', '主控', $coordinator.title, $coordinator.thread_id, $coordinator.host_id) |
            ForEach-Object { Escape-Cell $_ }
        $lines.Add('| ' + ($coordinatorCells -join ' | ') + ' |')
        foreach ($project in $registry.projects) {
            foreach ($module in $project.modules) {
                $moduleCells = @($project.title, $module.id, $module.title, $module.thread_id, $module.host_id) |
                    ForEach-Object { Escape-Cell $_ }
                $lines.Add('| ' + ($moduleCells -join ' | ') + ' |')
            }
        }
        $lines.Add('')
        $lines.Add('## 任务进度')
        $lines.Add('')
        $lines.Add('| 任务 | 项目 | 模块 | 状态 | 最近信号 | 标题 | 当前摘要 | 阻碍 | 报告 |')
        $lines.Add('|---|---|---|---|---|---|---|---|---|')
        foreach ($row in $rows) {
            $summaryText = if ($row.Summary) { $row.Summary } else { '尚未上报' }
            $blockerText = if ($row.Blockers) { $row.Blockers } else { '未上报阻碍' }
            $reportLink = '尚未提交'
            if ($row.ReportExists) {
                $relativeReport = (Resolve-StatePath $row.ReportPath "task $($row.Id).report_path").Substring($statePrefix.Length)
                $segments = $relativeReport.Replace('\', '/').Split('/') | ForEach-Object { [Uri]::EscapeDataString($_) }
                $reportLink = '[查看报告](' + ($segments -join '/') + ')'
            }
            $roleText = if ($row.HistoricalSession) { $row.Role + '（历史：' + $row.ThreadId + '）' } else { $row.Role }
            $cells = @($row.Id, $row.Project, $roleText, $row.Label, $row.LastSignal, $row.Title, $summaryText, $blockerText) |
                ForEach-Object { Escape-Cell $_ }
            $lines.Add('| ' + ($cells -join ' | ') + ' | ' + $reportLink + ' |')
        }
        if ($warnings.Count -gt 0) {
            $lines.Add('')
            $lines.Add('## 警告')
            $lines.Add('')
            foreach ($warning in $warnings) { $lines.Add('- ' + (Escape-Cell $warning)) }
        }
        $temporary = Resolve-StatePath ('.BOARD.' + [Guid]::NewGuid().ToString('N') + '.tmp') 'BOARD 临时文件'
        try {
            [IO.File]::WriteAllText($temporary, ($lines -join "`r`n") + "`r`n", (New-Object Text.UTF8Encoding($true)))
            if ([IO.File]::Exists($boardPath)) {
                [IO.File]::Replace($temporary, $boardPath, [NullString]::Value)
            } else {
                [IO.File]::Move($temporary, $boardPath)
            }
        } finally {
            if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
        }
        Write-Output "进度表已原子更新：$boardPath"
    }
    if ($Action -eq 'Validate') { Write-Output "校验通过（警告 $($warnings.Count) 条）。" }
    exit 0
} catch {
    Write-Error ("协作状态校验失败：" + $_.Exception.Message) -ErrorAction Continue
    exit 1
}
