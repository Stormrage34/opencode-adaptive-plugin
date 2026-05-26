# Adaptive Plugin — MVP Roadmap (v1.7.0)

**Chief Engineer Review:** RobotxR1 + Web Agents papers validated architecture, but oracle audit revealed 40% functional gap.

**Goal:** Ship MVP with honest capability matrix, working core features, documented limitations.

---

## Current State (v1.6.0) — Oracle Audit Summary

| Category | Count | Features |
|----------|-------|----------|
| ✅ Production-ready | 4 | maxTokens clamp, tools, SQLite telemetry, delta writes |
| ⚠️ Partial (needs wiring) | 2 | EventV2 (behind flag), composite reward (semantics drifted) |
| ❌ Stub/Placeholder | 4 | [REF] resolver, validation gate, resolveStrategy, traces |
| ❌ Vaporware | 1 | Model auto-switching (impossible by design) |

**Critical gaps:**
1. EventV2 events silently dead without `OPENCODE_EXPERIMENTAL_EVENT_SYSTEM=1`
2. [REF] resolver returns fake strings (`// TODO: Workspace FS read`)
3. Validation gate checks wrong field (always passes)
4. Composite reward range [-0.03, 0.9] doesn't match EMA target (0.75 for [0,1])

---

## MVP Definition (v1.7.0)

**Must Have (P0):**
- [ ] EventV2 works OR plugin gracefully degrades with clear warning
- [ ] Validation gate reads correct data field
- [ ] Composite reward recalibrated for actual range
- [ ] Honest README with capability matrix
- [ ] [REF] resolver either works or removed

**Should Have (P1):**
- [ ] Dead code removed (traces, unused exports)
- [ ] Plugin auto-enabled in default config
- [ ] Local inference documented with copy-paste config

**Nice to Have (P2):**
- [ ] Variance guard implemented (σ < 0.05 freeze)
- [ ] Positive/negative traces exported via tool

---

## Implementation Plan

### Phase MVP.1: Critical Fixes (P0) — ~40 lines

#### 1. Fix Validation Gate — Read Correct Field (~12 lines)

**File:** `adaptive.ts:338-351`

**Current (broken):** Reads `properties.structured` (metadata object) or `properties.content` (array), passes to validateOutput which always scores ~1.0.

**Fix:** Extract text from `properties.content` array of Part objects, then validate the actual text output.

---

#### 2. Fix [REF] Resolver — Actual File Reads (~15 lines)

**File:** `adaptive.ts:313-325`

**Current (stub):** `// TODO: Workspace FS read — for now placeholder`

**Fix:** Use `Bun.file(path.join(ctx.directory, file)).text()` to read actual file content, cache snippet in LRU.

**Option B (simpler MVP):** Delete lines 306-332, mark as "v1.8.0 feature".

---

#### 3. Recalibrate Composite Reward (~3 lines)

**File:** `adaptive.ts:1061-1078`

**Problem:** Reward range [-0.03, 0.9], but EMA target = 0.75 (designed for [0,1]).

**Fix:** Add normalization: `const normalizedReward = clamp((reward + 0.03) / 0.93, 0.0, 1.0)` before passing to updateEMA.

---

#### 4. Add EventV2 Warning + Graceful Degradation (~8 lines)

**File:** `adaptive.ts:827-829`

**Current:** Only logs if debug=true or --print-logs. Silent failure for most users.

**Fix:** Use console.warn (always visible) to alert users EventV2 is disabled, provide exact env var to set.

---

### Phase MVP.2: Dead Code Removal (P1) — ~10 lines removed

#### 5. Remove Traces Arrays

**File:** `adaptive.ts:298-300, 1090-1098`

**Delete:** positiveTraces/negativeTraces arrays and population code. Never read, pure memory overhead.

---

#### 6. Remove resolveStrategy Export

**File:** `adaptive.ts:871, 1157`

**Delete:** Exposed but never consumed (zero references outside adaptive.ts).

---

### Phase MVP.3: Documentation (P1)

#### 7. Update README with Honest Capability Matrix

**File:** `README.md`

**Add table:**
| Feature | Status | Requires |
|---------|--------|----------|
| maxOutputTokens clamp | ✅ Works | None |
| Tools (4) | ✅ Works | None |
| SQLite telemetry | ✅ Works | None |
| EventV2 auto-adaptation | ⚠️ Needs flag | `OPENCODE_EXPERIMENTAL_EVENT_SYSTEM=1` |
| [REF] resolver | ❌ Stub | v1.8.0 |
| Validation gate | ❌ Broken | MVP.1 fix |
| Model auto-switch | ❌ Impossible | User config required |

---

#### 8. Local Inference Config Template

**File:** `README.md`

**Add copy-paste config:**
```jsonc
{
  "provider": {
    "ollama": {
      "name": "Ollama",
      "api": "http://localhost:11434",
      "models": {
        "qwen3-0.6b-q4_k_m": {
          "name": "Qwen3 0.6B Q4_K_M",
          "limit": { "context": 2048, "output": 2048 },
          "cost": { "input": 0, "output": 0 }
        }
      }
    }
  }
}
```

---

## Timeline

| Phase | Tasks | Est. Lines | Est. Time |
|-------|-------|------------|-----------|
| MVP.1 | 4 critical fixes | ~40 | 1-2 hours |
| MVP.2 | 2 dead code removals | -10 | 15 min |
| MVP.3 | 2 docs updates | +50 | 30 min |
| **Total** | **8 tasks** | **~80** | **~3 hours** |

---

## Post-MVP (v1.8.0)

- [ ] Variance guard (σ < 0.05 freeze)
- [ ] [REF] resolver with actual file reads (if not done in MVP)
- [ ] Cross-session vector memory
- [ ] LoRA-SFT export pipeline
- [ ] ML complexity classifier

---

## Success Criteria

**MVP ships when:**
1. EventV2 warning visible to all users (no silent failure)
2. Validation gate reads actual tool output text
3. Composite reward normalized for EMA compatibility
4. README has honest capability matrix
5. Dead code removed (traces, unused exports)
6. Local inference config documented

**Version:** `1.7.0-mvp`
