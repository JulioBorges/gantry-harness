#!/usr/bin/env python3
"""Remove orchestrator-related code from stateStore.ts"""
import re

with open('src/server/stateStore.ts', 'r') as f:
    content = f.read()

# Remove lifecycle_state from SQL
content = re.sub(r',\s*lifecycle_state TEXT NOT NULL DEFAULT \'idle\'', '', content)
content = re.sub(r',\s*lifecycle_state', '', content)
content = re.sub(r'lifecycle_state,\s*', '', content)

# Remove decision_card_json from SQL
content = re.sub(r',\s*decision_card_json TEXT', '', content)
content = re.sub(r',\s*decision_card_json', '', content)
content = re.sub(r'decision_card_json,\s*', '', content)

# Remove TypeScript types and references
content = re.sub(r'lifecycleState\?:\s*RunLifecycleState;?', '', content)
content = re.sub(r',\s*lifecycleState:', '', content)
content = re.sub(r'lifecycleState:\s*[^,\n}]+,?', '', content)
content = re.sub(r'const\s+updatedLifecycle[^;]+;', '', content)
content = re.sub(r'const\s+lifecycleState[^;]+;', '', content)
content = re.sub(r'updatedLifecycle,?\s*', '', content)

# Remove decisionCard
content = re.sub(r'decisionCard\?:[^;]+;', '', content)
content = re.sub(r',\s*decisionCard:', '', content)
content = re.sub(r'decisionCard:\s*[^,\n}]+,?', '', content)
content = re.sub(r'const\s+cardWithId[^;]+;', '', content)
content = re.sub(r'input\.decisionCard[^\n]*\n', '', content)

# Remove provider settings functions (lines 483-556 approximately)
# Find and remove the three provider functions
content = re.sub(
    r'  private writeRawSettings\(settings: ProviderSettingsInput\): void \{[^}]+\}',
    '',
    content,
    flags=re.DOTALL
)
content = re.sub(
    r'  public getRawProviderSettings\(\): ProviderSettingsInput \{[^}]+\}',
    '',
    content,
    flags=re.DOTALL
)
content = re.sub(
    r'  public updateProviderSettings\(input: ProviderSettingsInput\): SanitizedProviderSettings \{[^}]+\}',
    '',
    content,
    flags=re.DOTALL
)
content = re.sub(
    r'  public getSanitizedProviderSettings\(\): SanitizedProviderSettings \{[^}]+\}',
    '',
    content,
    flags=re.DOTALL
)

# Clean up multiple blank lines
content = re.sub(r'\n\n\n+', '\n\n', content)

with open('src/server/stateStore.ts', 'w') as f:
    f.write(content)

print("Cleaned stateStore.ts")
