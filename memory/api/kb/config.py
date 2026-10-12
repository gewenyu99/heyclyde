import os
from dataclasses import dataclass, field


def _list(name, default):
    return [s.strip() for s in os.environ.get(name, default).split(",") if s.strip()]


@dataclass(frozen=True)
class Config:
    database_url: str = field(default_factory=lambda: os.environ.get("DATABASE_URL", "postgresql://kb:kb@localhost:5432/kb"))
    # Every agent session holds KB_TOKEN. Only clyde-flow holds KB_RUNTIME_TOKEN, the one that writes above draft.
    token: str = field(default_factory=lambda: os.environ.get("KB_TOKEN", ""))
    # SHA-256 hex of the token. When set it replaces KB_TOKEN, so the server never stores the token itself.
    token_sha256: str = field(default_factory=lambda: os.environ.get("KB_TOKEN_SHA256", "").strip().lower())
    # The console's own token, never the agents'. /api/v1 takes it and nothing else. Unset, the console is off.
    admin_token: str = field(default_factory=lambda: os.environ.get("KB_ADMIN_TOKEN", ""))
    admin_token_sha256: str = field(default_factory=lambda: os.environ.get("KB_ADMIN_TOKEN_SHA256", "").strip().lower())
    runtime_token: str = field(default_factory=lambda: os.environ.get("KB_RUNTIME_TOKEN", ""))
    # SHA-256 hex of the runtime token, the way KB_TOKEN_SHA256 stands in for KB_TOKEN.
    runtime_token_sha256: str = field(default_factory=lambda: os.environ.get("KB_RUNTIME_TOKEN_SHA256", "").strip().lower())
    ollama_url: str = field(default_factory=lambda: os.environ.get("OLLAMA_URL", "http://localhost:11434"))
    embed_model: str = field(default_factory=lambda: os.environ.get("EMBED_MODEL", "bge-m3"))
    # How often the background sync looks for entries without an embedding, like a write whose embedding failed.
    embed_sync_seconds: float = field(default_factory=lambda: float(os.environ.get("KB_EMBED_SYNC_SECONDS", "300")))
    # Arms a new session can draw. Phase 0 serves index and hybrid. spreading and hindsight join in Phase 1.
    arms: list = field(default_factory=lambda: _list("KB_ARMS", "index,hybrid"))
    packet_items: int = 8
    packet_tokens: int = 1500
    candidates: int = 50
    # Ranking knobs, tuned on the train split only (eval/retrieval_eval.py --split train). hybrid holds 91% on train
    # for k 5 to 10 and vector weight 1 to 3, so these sit mid-plateau. Demoting drafts cost hybrid a hit, so only index does it.
    rrf_k: float = field(default_factory=lambda: float(os.environ.get("KB_RRF_K", "10")))
    vec_weight: float = field(default_factory=lambda: float(os.environ.get("KB_VEC_WEIGHT", "1.5")))
    index_draft_factor: float = field(default_factory=lambda: float(os.environ.get("KB_INDEX_DRAFT_FACTOR", "0.5")))
    # A scoped recall multiplies its own scope's scores by this, so a run's handoff notes lead the packet.
    scope_boost: float = field(default_factory=lambda: float(os.environ.get("KB_SCOPE_BOOST", "3.0")))


config = Config()
