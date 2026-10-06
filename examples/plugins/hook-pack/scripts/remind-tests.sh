#!/bin/sh
# PostToolUse hook of the hook-pack example: after a file edit, remind the agent to run the tests.
cat > /dev/null
printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"A file changed: run the project tests before you finish."}}'
