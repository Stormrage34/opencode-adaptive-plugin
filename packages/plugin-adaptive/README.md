# opencode-plugin-adaptive

Self-improving plugin for OpenCode that automatically adapts its strategy based on your acceptance patterns and tracks token usage/cost.

## Features

- **Auto-adaptation**: Switches between `fast`, `balanced`, and `verified` strategies based on your acceptance rate
- **Token Tracking**: Records input/output tokens, model used, and estimated cost per task
- **Cost Analysis**: Tracks wasted spend on rejected suggestions, per-model breakdown
- **Error learning**: Detects repeated error patterns and adjusts strategy to avoid them
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

- **Accept rate ≥ 65%** → `fast` strategy (fast, 2K tokens max)
- **Accept rate < 65%** → `verified` strategy (4K tokens, full context)
- **Default by task type**: `coding`→fast, `reasoning`→balanced, `debug`→verified

### Manual Feedback

Track acceptance/rejection with token usage:

```bash
# After accepting a suggestion
opencode run adaptive_record \
  --task_id refactor-auth \
  --accepted true \
  --latency_ms 1200 \
  --input_tokens 1500 \
  --output_tokens 450 \
  --model qwen3.5-plus \
  --strategy_used fast

# After rejecting a suggestion
opencode run adaptive_record \
  --task_id add-tests \
  --accepted false \
  --latency_ms 800 \
  --input_tokens 2000 \
  --output_tokens 200 \
  --model qwen3.5-plus \
  --error "TypeError: Cannot read property 'map'"
```

### Check Current State

```bash
# Show strategy metrics
opencode run adaptive_strategy

# Show token usage and cost stats
opencode run adaptive_strategy --tokens true
```

Output (strategy):
```json
{
  "strategies": {
    "coding": {
      "strategy": "fast",
      "acceptRate": "0.78",
      "calls": 35,
      "accepts": 27,
      "rejects": 8,
      "avgLatencyMs": 1200,
      "avgTokens": 1850,
      "overridden": false
    }
  },
  "aggregate": {
    "totalInteractions": 45,
    "overallAcceptRate": "0.78",
    "threshold": 0.65,
    "lastAdaptation": "2026-05-24T15:30:00.000Z"
  }
}
```

Output (tokens):
```json
{
  "tokenUsage": {
    "total": 85000,
    "input": 62000,
    "output": 23000,
    "inputOutputRatio": "0.73"
  },
  "cost": {
    "total": "0.042500",
    "accepted": "0.035200",
    "rejected": "0.007300",
    "wasteRate": "0.17"
  },
  "byModel": {
    "qwen3.5-plus": {
      "calls": 42,
      "tokens": 78000,
      "cost": "0.038500"
    },
    "o4-mini": {
      "calls": 3,
      "tokens": 7000,
      "cost": "0.004000"
    }
  },
  "recentLogs": [
    {
      "taskId": "refactor-auth",
      "model": "qwen3.5-plus",
      "tokens": 1950,
      "cost": "0.000570",
      "accepted": true
    }
  ]
}
```

### Reset State

```bash
opencode run adaptive_strategy --reset true
```

### Manual Override

Force a specific strategy for a task type:

```bash
# Override coding tasks to use verified strategy
opencode run adaptive_set --type coding --strategy verified

# Global override for all task types
opencode run adaptive_set --global --strategy fast

# Remove override and resume auto-adaptation
opencode run adaptive_set --type coding --reset
```

## Strategies

| Strategy | When | Max Tokens | Behavior |
|----------|------|------------|----------|
| `fast` | Accept rate ≥ 65% | 2048 | Fast responses, low context |
| `balanced` | Default for reasoning tasks | 3072 | Balanced context and speed |
| `verified` | Accept rate < 65% or repeated errors | 4096 | Full context, thorough |

## How It Works

1. **Track**: Records acceptance/rejection for each task
2. **Analyze**: Computes running accept rate per task type (coding/reasoning/debug)
3. **Adapt**: Adjusts strategy and token budget based on:
   - Accept rate vs threshold (default 0.65)
   - Repeated error patterns (≥2 occurrences trigger escalation to verified)
   - Task type classification (keyword-based heuristic)
4. **Persist**: Saves state to disk after each adaptation (debounced 10s coalescing)

## State File

Location: `.opencode_adaptive_state.json` (or custom `statePath`)

```json
{
  "activeStrategy": {
    "coding": "fast",
    "reasoning": "balanced",
    "debug": "verified"
  },
  "metrics": {
    "coding": {
      "calls": 45,
      "accepts": 35,
      "rejects": 10,
      "avgLatencyMs": 1200,
      "avgTokens": 1850
    },
    "reasoning": {
      "calls": 12,
      "accepts": 10,
      "rejects": 2,
      "avgLatencyMs": 2300,
      "avgTokens": 2800
    },
    "debug": {
      "calls": 8,
      "accepts": 7,
      "rejects": 1,
      "avgLatencyMs": 1800,
      "avgTokens": 3200
    }
  },
  "errorWeights": {
    "coding": {
      "TypeError": 1
    },
    "reasoning": {},
    "debug": {}
  },
  "contextBudgetTokens": {
    "fast": 2048,
    "balanced": 3072,
    "verified": 4096
  },
  "acceptThreshold": 0.65,
  "overrides": {
    "coding": false,
    "reasoning": false,
    "debug": false
  },
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
