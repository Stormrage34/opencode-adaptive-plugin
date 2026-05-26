#!/usr/bin/env bun

import { $ } from "bun"
import { readFileSync } from "node:fs"
import { join } from "node:path"

console.log("🚀 Starting opencode pre-flight checks...\n")

// 1. Check Bun version
const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"))
const requiredBun = pkg.packageManager?.split("@")[1]
const currentBun = (await $`bun --version`.text()).trim()

if (requiredBun && currentBun !== requiredBun) {
  console.warn(`⚠️  Bun version mismatch. Expected ${requiredBun}, got ${currentBun}.`)
} else {
  console.log(`✅ Bun version: ${currentBun}`)
}

// 2. Check for linked issue
const branch = (await $`git branch --show-current`.text()).trim()
const hasIssueInBranch = /\d+/.test(branch)
const lastCommitMsg = (await $`git log -1 --pretty=%B`.text()).trim()
const hasIssueInCommit = /(Fixes|Closes) #\d+/.test(lastCommitMsg)

if (!hasIssueInBranch && !hasIssueInCommit) {
  console.warn("⚠️  No linked issue found in branch name or last commit message.")
  console.warn("   (Maintainers require PRs to be linked to an issue)")
} else {
  console.log("✅ Linked issue found.")
}

// 3. Run Lint (Oxlint)
console.log("\n🔍 Running oxlint...")
try {
  await $`bun run lint`
  console.log("✅ Lint passed.")
} catch (_e) {
  console.error("❌ Lint failed.")
  process.exit(1)
}

// 4. Slop Check (basic)
console.log("\n🧹 Checking for slop (casts to any)...")
const slopFiles = (await $`grep -lE "as any|: any" --include="*.ts" --include="*.tsx" -r packages | grep -v "node_modules" | grep -v "sdk.gen.ts"`.text())
  .trim()
  .split("\n")
  .filter(Boolean)

if (slopFiles.length > 0) {
  console.warn(`⚠️  Found ${slopFiles.length} files with 'any' casts. Consider refining types.`)
  // Don't fail yet, just warn as some might be legitimate
} else {
  console.log("✅ No 'any' casts found.")
}

console.log("\n✨ Pre-flight complete! You are ready to PR.")
