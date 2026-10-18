#!/usr/bin/env python3
"""Remove orchestrator-related code from App.tsx"""
import re

with open('src/client/App.tsx', 'r') as f:
    lines = f.readlines()

output_lines = []
skip_until_blank = False

orchestrator_keywords = [
    'coordinatorInput',
    'preparedCommand',
    'grillingAnswers',
    'editInstruction',
    'steeringInput',
    'selectedSteeringIssue',
    'selectedReplacementIdx',
    'connection',
    'savedSettings',
    'providerMode',
    'activeProvider',
    'providerApiKey',
    'approvedSlug',
    'activeRunId',
    'kanbanRuns',
    'setupDiffPreview',
    'setupHostHarness',
    'discoveredModels',
    'roleSelections',
    'cliHarness',
    'providerModel',
    'providerBaseUrl',
    'lifecycleState',
    'decisionCard',
]

for i, line in enumerate(lines):
    # Skip state declarations for orchestrator features
    if any(keyword in line for keyword in orchestrator_keywords) and 'useState' in line:
        continue

    # Skip references to activeView kanban
    if "'kanban'" in line and 'activeView' in line:
        line = line.replace(" | 'kanban'", "")

    # Keep the line
    output_lines.append(line)

with open('src/client/App.tsx', 'w') as f:
    f.writelines(output_lines)

print(f"Cleaned App.tsx - removed {len(lines) - len(output_lines)} lines")
