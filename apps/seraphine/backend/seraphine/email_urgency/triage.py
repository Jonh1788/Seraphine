"""Anti-manipulation urgency triage for incoming email.

Classifies the *genuine* urgency of an email for the user, explicitly
ignoring marketing urgency, newsletter clickbait, and phishing-style fake
urgency. Real urgency comes from people and businesses the user actually
deals with. Forces a single structured tool call (temperature is fixed by
``tool_call_json``'s tool_choice) and normalizes the result.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

URGENCY_TOOL: dict[str, Any] = {
    "name": "classify_urgency",
    "description": "Classifica a urgência real de um email para o usuário.",
    "input_schema": {
        "type": "object",
        "required": ["urgency", "reason"],
        "properties": {
            "urgency": {
                "type": "string",
                "enum": ["high", "medium", "low"],
                "description": (
                    "high = exige atenção/ação em breve, de uma pessoa ou "
                    "empresa com quem o usuário realmente lida; medium = "
                    "relevante mas não imediato; low = newsletter, marketing, "
                    "promoção, massa ou phishing."
                ),
            },
            "reason": {
                "type": "string",
                "maxLength": 200,
                "description": "Justificativa curta em pt-br (uma frase).",
            },
        },
    },
}

TRIAGE_SYSTEM = (
    "Você é um assistente de triagem de urgência de emails. Decida o quão "
    "urgente um email é PARA O USUÁRIO, e seja ESTRITO.\n\n"
    "IGNORE urgência de marketing (\"Oferta por tempo limitado!\", \"Últimas "
    "horas!\"), clickbait de newsletter e urgência falsa de phishing. "
    "Urgência REAL vem de pessoas e empresas com quem o usuário de fato faz "
    "negócio.\n\n"
    "high (urgente) — APENAS quando algo legítimo exige atenção ou ação em "
    "breve:\n"
    "- faturas, boletos, recibos, cobranças endereçados ao usuário, com "
    "vencimento próximo;\n"
    "- alertas de segurança sobre as PRÓPRIAS contas do usuário (login "
    "suspeito, troca de senha);\n"
    "- mensagens de pessoas reais ou empresas com quem o usuário lida, sobre "
    "assuntos sensíveis ao tempo (trabalho, dinheiro, pessoal, "
    "agendamentos).\n\n"
    "medium — relevante mas não imediato.\n\n"
    "low (NÃO urgente) — newsletters genéricas semanais/mensais, promoções, "
    "marketing, divulgação, redes sociais, qualquer coisa em massa, e "
    "phishing/golpe.\n\n"
    "Na dúvida entre high e medium, escolha medium. Na dúvida entre medium e "
    "low para conteúdo promocional/massa, escolha low. Responda chamando a "
    "ferramenta classify_urgency."
)

_VALID = {"high", "medium", "low"}


async def classify_urgency(
    llm: Any,
    *,
    sender: str,
    subject: str,
    snippet: str,
) -> dict[str, str]:
    """Return ``{"urgency": "high|medium|low", "reason": "<pt-br>"}``.

    Defensive: returns ``low`` on a missing LLM, an LLM error, or an
    out-of-enum value, so a failed classification never produces a push.
    """
    if llm is None:
        return {"urgency": "low", "reason": "sem classificador"}

    user = (
        f"De: {(sender or '')[:200]}\n"
        f"Assunto: {(subject or '')[:300]}\n"
        f"Trecho: {(snippet or '')[:800]}"
    )
    try:
        data = await llm.tool_call_json(
            system=TRIAGE_SYSTEM,
            user=user,
            tool=URGENCY_TOOL,
            cache_system=True,
            max_tokens=200,
        )
    except Exception:
        logger.exception("email urgency: classify failed")
        return {"urgency": "low", "reason": "falha na classificação"}

    urgency = str((data or {}).get("urgency", "low")).strip().lower()
    if urgency not in _VALID:
        urgency = "low"
    reason = str((data or {}).get("reason", ""))[:200]
    return {"urgency": urgency, "reason": reason}
