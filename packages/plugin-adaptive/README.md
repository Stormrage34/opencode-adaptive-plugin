# opencode-plugin-adaptive

Self-improving plugin for OpenCode that automatically adapts its strategy based on your acceptance patterns.

## Features

- **Auto-adaptation**: Switches between `minimal`, `context_rich`, and `verified` strategies based on your acceptance rate
- **Error learning**: Detects repeated error patterns and adjusts strategy to avoid them
- **Resource awareness**: Detects low-memory (<2GB) or CPU-constrained (≤2 cores) systems and adapts accordingly
- **Persistent state**: Saves metrics to `.opencode_adaptive_state.json` — survives IDE restarts
- **Zero external deps**: Uses only OpenCode plugin API + Node.js standard library

## Installation

```bash
opencode plugin add opencode-plugin-adaptive
```

Or for local development:

```bash
opencode plugin add ./packages/plugin-adaptive
```

## Configuration

Add to your `opencode.jsonc`:

```jsonc
{
  "plugin": [
    ["opencode-plugin-adaptive", {
      "statePath": ".opencode_adaptive_state.json",  // Optional: custom state path
      "debug": false  // Optional: enable debug logging
    }]
  ]
}
```

## Usage

### Automatic Adaptation

The plugin automatically adjusts LLM parameters based on your acceptance patterns:

- **Accept rate ≥ 65%** → `minimal` strategy (fast, 2K tokens max)
- **Resource constrained** → `context_rich` strategy (3K tokens, pruned context)
- **Accept rate < 65%** → `verified` strategy (4K tokens, full context)

### Manual Feedback

Track acceptance/rejection manually:

```bash
# After accepting a suggestion
opencode run adaptive_record --task_id refactor-auth --accepted true --latency_ms 1200 --diff_size 450

# After rejecting a suggestion
opencode run adaptive_record --task_id add-tests --accepted false --error "TypeError: Cannot read property 'map'"
```

### Check Current State

```bash
opencode run adaptive_strategy
```

Output:
```json
{
  "strategy": "minimal",
  "acceptRate": "0.78",
  "contextBudget": 4000,
  "threshold": 0.65,
  "tasksTracked": 12,
  "totalInteractions": 45,
  "lastAdaptation": "2026-05-24T15:30:00.000Z"
}
```

### Reset State

```bash
opencode run adaptive_strategy --reset true
```

### Manual Override

Force a specific strategy:

```bash
opencode run adaptive_set --strategy verified --budget 8000
```

## Strategies

| Strategy | When | Max Tokens | Behavior |
|----------|------|------------|----------|
| `minimal` | Accept rate ≥ 65% | 2048 | Fast responses, low context |
| `context_rich` | Resource constrained | 3072 | Pruned context, focused |
| `verified` | Accept rate < 65% or repeated errors | 4096 | Full context, thorough |

## How It Works

1. **Track**: Records acceptance/rejection for each task ID
2. **Analyze**: Computes running accept rate per session
3. **Adapt**: Adjusts strategy and token budget based on:
   - Accept rate vs threshold (default 0.65)
   - System resources (memory, CPU)
   - Repeated error patterns (≥2 occurrences trigger strategy change)
4. **Persist**: Saves state to disk after each adaptation

## State File

Location: `.opencode_adaptive_state.json` (or custom `statePath`)

```json
{
  "activeStrategy": "minimal",
  "metrics": {
    "refactor-auth": {
      "calls": 5,
      "accepts": 4,
      "rejects": 1,
      "avgLatencyMs": 1200,
      "avgDiffSize": 450
    }
  },
  "errorWeights": {
    "TypeError": 1
  },
  "contextBudgetTokens": 4000,
  "acceptThreshold": 0.65,
  "lastAdaptation": 1716567000000
}
```

## Development

```bash
cd packages/plugin-adaptive
bun run typecheck
```

## License

MIT
