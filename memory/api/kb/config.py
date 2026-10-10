import os
from dataclasses import dataclass, field


def _list(name, default):
    return [s.strip() for s in os.environ.get(name, default).split(",") if s.strip()]


@dataclass(frozen=True)
class Config:
    database_url: str = field(default_factory=lambda: os.environ.get("DATABASE_URL", "postgresql://kb:kb@localhost:5432/kb"))
    token: str = field(default_factory=lambda: os.environ.get("KB_TOKEN", ""))
    ollama_url: str = field(default_factory=lambda: os.environ.get("OLLAMA_URL", "http://localhost:11434"))
    embed_model: str = field(default_factory=lambda: os.environ.get("EMBED_MODEL", "bge-m3"))
    # Arms a new session can draw. Phase 0 serves A0 and A1; A2 and A3 join in Phase 1.
    arms: list = field(default_factory=lambda: _list("KB_ARMS", "A0,A1"))
    packet_items: int = 8
    packet_tokens: int = 1500
    candidates: int = 50


config = Config()
