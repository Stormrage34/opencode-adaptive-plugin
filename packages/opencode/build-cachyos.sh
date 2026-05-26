#!/usr/bin/env bash
set -euo pipefail

# CachyOS / Zen 3+ optimized build
# -march=znver3 emits AVX2 instructions, larger cache line optimizations
# -O3 enables auto-vectorization

echo "Building opencode for CachyOS (Zen 3+)..."

export BUN_CACHE_DIR=/tmp/bun-cache
mkdir -p "$BUN_CACHE_DIR"

# Build with Zen 3 optimizations
BUN_CONFIG_NATIVE_TARGET=znver3 \
  bun run build

echo ""
echo "Build complete. Binary: dist/opencode-linux-x64/bin/opencode"
echo ""
echo "Recommended runtime tuning for CachyOS:"
echo "  sudo sysctl -w vm.swappiness=1"
echo "  sudo sysctl -w vm.vfs_cache_pressure=50"
echo "  sudo sysctl -w kernel.numa_balancing=0"
echo "  sudo sysctl -w kernel.sched_energy_aware=0"
echo ""
echo "Launch with real-time priority:"
echo "  chrt -i 0 nice -n -5 ./dist/opencode-linux-x64/bin/opencode /path/to/project"