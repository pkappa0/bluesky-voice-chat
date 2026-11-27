#!/bin/zsh
set -eu
cd -- "${0:A:h}"
export PATH="/opt/homebrew/bin:$PATH"

if [[ "${1:-}" == "--api" && -z "${OPENAI_API_KEY:-}" ]]; then
  while true; do
    read -rs 'OPENAI_API_KEY?OpenAI APIキー（入力は表示されません）: '
    print
    if [[ "$OPENAI_API_KEY" == sk-* && "$OPENAI_API_KEY" != *[[:space:]]* && "$OPENAI_API_KEY" != *'*'* ]]; then
      break
    fi
    print -u2 '発行時にコピーしたシークレットキー全文を貼り付けてください（伏字や空白は入力できません）。'
  done
  export OPENAI_API_KEY
fi

exec mise exec node@26.12.1 -- node server.mjs
