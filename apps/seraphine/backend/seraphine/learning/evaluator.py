from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

logger = logging.getLogger(__name__)
LLMCall = Callable[[list[dict[str, str]]], Awaitable[str]]


@dataclass
class EvalResult:
    score: float
    per_case: list[dict[str, Any]] = field(default_factory=list)
    n: int = 0


def _parse_score(text: str) -> float:
    try:
        m = re.search(r"\{.*\}", text or "", re.S)
        if m:
            v = float(json.loads(m.group(0)).get("score"))
            return max(0.0, min(1.0, v))
    except Exception:
        pass
    m = re.search(r"(\d+(?:\.\d+)?)", text or "")
    if m:
        v = float(m.group(1))
        if v > 1.0:
            v = v / 10.0 if v <= 10 else 1.0
        return max(0.0, min(1.0, v))
    return 0.5


async def evaluate_policy(
    llm_call: LLMCall,
    *,
    behavior_addendum: str,
    tool_guidance: str,
    eval_cases: list[dict[str, Any]],
    base_instruction: str = "",
    concurrency: int = 3,
) -> EvalResult:
    if not eval_cases:
        return EvalResult(score=0.5, per_case=[], n=0)
    sem = asyncio.Semaphore(concurrency)

    async def _one(case: dict[str, Any]) -> dict[str, Any]:
        async with sem:
            sys = "\n\n".join(
                p
                for p in [base_instruction, behavior_addendum, tool_guidance]
                if p
            )
            try:
                answer = await llm_call(
                    [
                        {"role": "system", "content": sys or "You are Seraphine."},
                        {"role": "user", "content": case.get("input_text", "")},
                    ]
                )
            except Exception as e:  # noqa: BLE001
                logger.debug("eval responder failed: %s", e)
                return {"id": case.get("id"), "score": 0.5, "error": "responder"}
            judge_prompt = (
                "Score how well the ASSISTANT_ANSWER satisfies the RUBRIC, "
                "from 0.0 to 1.0. "
                'Reply with ONLY JSON: {"score": <number>}.\n\n'
                f"RUBRIC:\n{case.get('rubric', '')}\n\nASSISTANT_ANSWER:\n{answer}"
            )
            try:
                verdict = await llm_call(
                    [{"role": "user", "content": judge_prompt}]
                )
                score = _parse_score(verdict)
            except Exception as e:  # noqa: BLE001
                logger.debug("eval judge failed: %s", e)
                score = 0.5
            return {"id": case.get("id"), "score": score}

    per_case = await asyncio.gather(*[_one(c) for c in eval_cases])
    mean = sum(c["score"] for c in per_case) / len(per_case)
    return EvalResult(score=mean, per_case=list(per_case), n=len(per_case))
