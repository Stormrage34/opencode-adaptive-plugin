# Adaptive Plugin — Active Agent Enhancement MVP

## Architecture Tree

```
┌──────────────────────────────────────────────────────────────────┐
│                    ADAPTIVE PLUGIN v2.1.2                        │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐      │
│  │                    NOW (Passive)                        │      │
│  │                                                        │      │
│  │  telemetry_v2 (SQLite WAL)                             │      │
│  │  ├─ 50+ records, 13 columns                            │      │
│  │  ├─ queries: stats, trends, export, recent              │      │
│  │  └─ composite index: (agent, tool, confidence, ts)      │      │
│  │                                                        │      │
│  │  Hooks:                                                │      │
│  │  ├─ chat.message     → store sessionCtx (read-only)    │      │
│  │  ├─ tool.execute.after → observe + confidence score    │      │
│  │  └─ flush            → drain validations + close DB    │      │
│  │                                                        │      │
│  │  Data flow: tool executes → SQLite INSERT → sits there │      │
│  │  Agent impact: NONE — data is invisible to LLM         │      │
│  └────────────────────────────────────────────────────────┘      │
│                          │                                       │
│                          ▼                                       │
│  ┌────────────────────────────────────────────────────────┐      │
│  │               MVP (Active Enhancement)                  │      │
│  │                                                        │      │
│  │  New Hooks:                                            │      │
│  │  ├─ tool.definition ✓ (built, blocked on binary)       │      │
│  │  │   └─ Appends: "Read [85% success, 45 calls]"        │      │
│  │  │   └─ Agent sees richer tool descriptions             │      │
│  │  │   └─ Self-corrects tool choices without user input   │      │
│  │  │                                                      │      │
│  │  ├─ experimental.chat.system.transform (next)           │      │
│  │  │   └─ Injects: "Bash failed 3/5 times last session"   │      │
│  │  │   └─ New sessions start with context from old ones   │      │
│  │  │                                                      │      │
│  │  └─ experimental.session.compacting (next)              │      │
│  │      └─ Preserves telemetry hints during compaction     │      │
│  │      └─ Agent doesn't forget lessons mid-session        │      │
│  │                                                        │      │
│  │  Data flow: tool executes → SQLite → next LLM request  │      │
│  │  │                      → tool.description enriched    │      │
│  │  │                      → system prompt injected        │      │
│  │  Agent impact: SEES the data at every decision point    │      │
│  └────────────────────────────────────────────────────────┘      │
│                          │                                       │
│                          ▼                                       │
│  ┌────────────────────────────────────────────────────────┐      │
│  │            Phase 2 (Proactive Agent)                    │      │
│  │                                                        │      │
│  │  ├─ Scenario detection (file extension → agent hint)   │      │
│  │  │   └─ Sees ".cl" → "GPU kernel, use kernel-dev agt"  │      │
│  │  │                                                      │      │
│  │  ├─ Cross-session memory DB                            │      │
│  │  │   └─ "hipMalloc failed 3x → -lhipamd fixes it"      │      │
│  │  │   └─ Survival of lessons across restarts             │      │
│  │  │                                                      │      │
│  │  └─ Per-project telemetry scoping                       │      │
│  │      └─ Separate stats per project, not global          │      │
│  └────────────────────────────────────────────────────────┘      │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

## MVP Plan — 3 Phases

### Phase 1: tool.definition (1 day)

**What:** Enrich tool descriptions with success rates before LLM sees them.

**Status:** ✅ Code written. Blocked on OpenCode binary rebuild (needs SDK support).

**When agent benefits:**
- Sees: `"Bash (80% success, 45 calls)"` instead of `"Run a shell command"`
- Stops retrying tools that historically fail
- Naturally prefers reliable tools for critical tasks

**Lines of code:** 15 (hook) + 20 (queryToolStats in db.js)

---

### Phase 2: Cross-session system hints (2 days)

**What:** Inject last session's key learnings into the system prompt of new sessions.

**How:** Use `experimental.chat.system.transform` hook.

```
System prompt gets appended:
  "Note: last session on project 'compute-project' had recurring
   hipMalloc errors. The fix that worked was -lhipamd in LDFLAGS."
```

**Key design decisions:**
- Only inject if `confidence < 0.5` on a tool (meaning it failed significantly)
- Only inject the top 3 most-repeated failures per project
- TTL on stored hints: 7 days (so stale lessons fade)

**Lines of code:** ~50

---

### Phase 3: Scenario-aware agent suggestions (3 days)

**What:** Detect project type from file extensions and adjust agent behavior.

**How:** Watch `tool.execute.after` for `write`/`edit` calls with `.cl`, `.cu`, `.hip` files.

**Injection via system.transform:**
```
"Detected GPU kernel files (.cl) — consider using kernel-dev agent
 for ROCm-specific tooling."
```

**Simple algorithm:**
```
if >30% of recent writes are .cl or .hip files:
  inject "GPU kernel work detected" hint
if >30% of recent bash calls include "hipcc" or "rocminfo":
  inject "AMD ROCm toolchain detected" hint
```

**Lines of code:** ~80

---

## MVP Success Criteria

| Criterion | How to measure |
|-----------|---------------|
| Agent retries less | Same-tool repeat calls drop by 30%+ |
| Tool success rate improves | avgConfidence rises over session lifetime |
| Cross-session learning | Second session on same project starts faster |
| No user-facing changes | User never sees plugin output unless they run adaptive_* tools |

## What NOT to build (YAGNI)

- ❌ Auto-retry logic (recursive risk, undefined behavior)
- ❌ Agent switching (too invasive, complex)
- ❌ Training/ML models (overkill, data insufficient)
- ❌ UI components (no output channel, keep it invisible)
- ❌ Real-time alerts (no notification mechanism in SDK)
