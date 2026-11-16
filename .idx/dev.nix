# Firebase Studio workspace for clyde harness (Tiers 1 and 2) and memory (Tier 3).
# Run `scripts/idx-tier3.sh` for the full Tier 3 suite, or pass one test path like
# `scripts/idx-tier3.sh test/memory/entitlement.test.ts` for a fast single-file run.
{ pkgs, ... }: {
  channel = "stable-25.05";

  packages = [
    pkgs.nodejs_24
    pkgs.deno
    pkgs.chromium
    pkgs.postgresql_17
    pkgs.python3
    pkgs.jq
    pkgs.openssl
    pkgs.curl
    pkgs.git
  ];

  services.docker.enable = true;

  env = {
    CHROME = "${pkgs.chromium}/bin/chromium";
    CHROME_BIN = "${pkgs.chromium}/bin/chromium";
    MEMORY_REQUIRE_DENO = "1";
  };

  idx = {
    workspace = {
      onCreate = {
        harness-deps = "npm --prefix harness ci --ignore-scripts";
        deno-cache = "deno cache --node-modules-dir=none harness/test/memory/edge.ts harness/test/memory/database.ts";
      };
    };
  };
}
