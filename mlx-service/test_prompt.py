#!/usr/bin/env python3
"""Lightweight tests that do not need mlx Metal. Run: python test_prompt.py"""

from __future__ import annotations

import unittest
from pathlib import Path

from catalog import default_model_id, get_model
from prompt import DEFAULT_SYSTEM_PROMPT, build_chatml, mock_portuguese_reply


class PromptTests(unittest.TestCase):
    def test_default_matches_canonical_preset(self) -> None:
        preset = Path(__file__).resolve().parents[1] / "prompts" / "conversa-natural.txt"
        self.assertEqual(DEFAULT_SYSTEM_PROMPT, preset.read_text().strip())

    def test_default_system_is_portuguese(self) -> None:
        self.assertIn("português", DEFAULT_SYSTEM_PROMPT.lower())
        self.assertIn("WhatsApp", DEFAULT_SYSTEM_PROMPT)

    def test_chatml_order(self) -> None:
        prompt = build_chatml(
            "sys",
            [
                {"role": "user", "text": "oi"},
                {"role": "assistant", "text": "olá"},
                {"role": "user", "text": "tudo bem?"},
            ],
        )
        self.assertIn("<|im_start|>system\nsys", prompt)
        self.assertTrue(prompt.endswith("<|im_start|>assistant\n"))
        self.assertIn("tudo bem?", prompt)

    def test_mock_reply(self) -> None:
        text = mock_portuguese_reply("bom dia", 3)
        self.assertIn("bom dia", text)
        self.assertIn("português", text.lower())

    def test_catalog_default(self) -> None:
        mid = default_model_id()
        self.assertEqual(mid, "qwen2.5-7b-instruct-4bit")
        self.assertIsNotNone(get_model(mid))
        self.assertIsNotNone(get_model("qwen2.5-3b-instruct-4bit"))


if __name__ == "__main__":
    unittest.main()
