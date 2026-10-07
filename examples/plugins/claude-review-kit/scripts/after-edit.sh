#!/bin/sh
# PostToolUse hook of the claude-review-kit example: after a file edit, remind the agent to review the change.
cat > /dev/null
printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"A file changed: review it with /review-kit:review before you finish."}}'
