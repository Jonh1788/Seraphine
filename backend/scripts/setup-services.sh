#!/usr/bin/env bash
# Interactive service selector for Seraphine.
# Creates/updates services.json with which services to start.
# Usage: ./scripts/setup-services.sh
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$DIR/services.json"

# Colors
BOLD="\033[1m"
DIM="\033[2m"
GREEN="\033[32m"
YELLOW="\033[33m"
CYAN="\033[36m"
PURPLE="\033[35m"
RESET="\033[0m"

# Service definitions: key|label|description|default
SERVICES=(
  "ollama|Ollama (Embeddings)|Modelo de embeddings para memória|true"
  "backend|Backend (FastAPI)|Servidor principal da Seraphine|true"
  "frontend|Frontend (Vite)|Interface web React|true"
  "whatsapp|WhatsApp Bridge|Ponte WhatsApp Web — mensagens e tarefas|true"
  "tunnel|Cloudflare Tunnel|Acesso externo via sera.jonhdev.io|true"
)

# Load existing config if present
declare -A current
if [ -f "$CONFIG" ]; then
  while IFS='=' read -r key val; do
    key=$(echo "$key" | tr -d ' ",' | sed 's/^"//')
    val=$(echo "$val" | tr -d ' ",')
    if [ "$key" != "_comment" ] && [ -n "$key" ]; then
      current[$key]="$val"
    fi
  done < <(grep -E '^\s*"[a-z]' "$CONFIG" | sed 's/.*"\([^"]*\)"\s*:\s*\(.*\)/\1=\2/')
fi

echo ""
echo -e "${PURPLE}${BOLD}  ╔══════════════════════════════════════╗${RESET}"
echo -e "${PURPLE}${BOLD}  ║     Seraphine — Service Setup        ║${RESET}"
echo -e "${PURPLE}${BOLD}  ╚══════════════════════════════════════╝${RESET}"
echo ""
echo -e "  ${DIM}Selecione quais serviços iniciar com start-all.sh${RESET}"
echo -e "  ${DIM}Config salva em: scripts/services.json${RESET}"
echo ""

declare -A selected

for entry in "${SERVICES[@]}"; do
  IFS='|' read -r key label desc default <<< "$entry"

  # Use existing value if available, otherwise default
  prev="${current[$key]:-$default}"

  if [ "$prev" = "true" ]; then
    marker="${GREEN}●${RESET}"
    hint="[S/n]"
  else
    marker="${DIM}○${RESET}"
    hint="[s/N]"
  fi

  echo -e "  $marker ${BOLD}$label${RESET}"
  echo -e "    ${DIM}$desc${RESET}"
  printf "    Ativar? $hint: "
  read -r answer </dev/tty

  answer=$(echo "$answer" | tr '[:upper:]' '[:lower:]')

  if [ -z "$answer" ]; then
    # Enter = keep current
    selected[$key]="$prev"
  elif [ "$answer" = "s" ] || [ "$answer" = "y" ] || [ "$answer" = "sim" ]; then
    selected[$key]="true"
  else
    selected[$key]="false"
  fi

  if [ "${selected[$key]}" = "true" ]; then
    echo -e "    → ${GREEN}Ativado${RESET}"
  else
    echo -e "    → ${DIM}Desativado${RESET}"
  fi
  echo ""
done

# Write JSON
cat > "$CONFIG" << JSONEOF
{
  "_comment": "Seraphine services config — edit manually or run setup-services.sh",
  "ollama": ${selected[ollama]},
  "backend": ${selected[backend]},
  "frontend": ${selected[frontend]},
  "whatsapp": ${selected[whatsapp]},
  "tunnel": ${selected[tunnel]}
}
JSONEOF

echo -e "  ${GREEN}${BOLD}✓ Config salva em $CONFIG${RESET}"
echo ""
echo -e "  ${CYAN}Resumo:${RESET}"
for entry in "${SERVICES[@]}"; do
  IFS='|' read -r key label _ _ <<< "$entry"
  if [ "${selected[$key]}" = "true" ]; then
    echo -e "    ${GREEN}● $label${RESET}"
  else
    echo -e "    ${DIM}○ $label${RESET}"
  fi
done
echo ""
echo -e "  ${DIM}Execute ./scripts/start-all.sh pra iniciar.${RESET}"
echo ""
