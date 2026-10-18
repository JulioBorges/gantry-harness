#!/usr/bin/env python3
"""
Remove orchestrator-related code from App.tsx while keeping terminal functionality.
"""

import re

def clean_app_tsx(content: str) -> str:
    lines = content.split('\n')
    cleaned = []
    skip_until = None

    for i, line in enumerate(lines):
        # Skip lines related to removed types
        if any(removed_type in line for removed_type in [
            'SanitizedProviderSettings',
            'CoordinatorConnection',
            'PreparedGantryCommand',
            'DecisionCardPayload',
        ]):
            # Skip this line if it's a state variable declaration
            if 'useState' in line or 'useRef' in line:
                continue

        # Remove specific state variables
        if any(state_var in line for state_var in [
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
        ]) and ('useState' in line or 'useRef' in line or 'const [' in line):
            continue

        # Skip functions that reference removed endpoints
        if skip_until:
            if line.strip().startswith(skip_until):
                skip_until = None
            continue

        # Identify functions to skip
        if any(fn_name in line for fn_name in [
            'handleCoordinatorSend',
            'handleStartPlan',
            'handleAnswerGrilling',
            'handleRefineSpec',
            'handleApproveP lan',
            'handleRun',
            'handleSteer',
            'handleTakeover',
            'handleResumeTakeover',
            'handleRecover',
            'handleDecideLesson',
            'handleDraftPR',
            'handleAuthorizeCleanup',
        ]) and ('= async' in line or '= withFeedback' in line):
            skip_until = '};'
            continue

        cleaned.append(line)

    return '\n'.join(cleaned)

if __name__ == '__main__':
    import sys
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <file>")
        sys.exit(1)

    with open(sys.argv[1]) as f:
        content = f.read()

    cleaned = clean_app_tsx(content)

    with open(sys.argv[1], 'w') as f:
        f.write(cleaned)

    print(f"Cleaned {sys.argv[1]}")
