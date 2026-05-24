import * as rpc from "@/util/rpc"
import {
  bootstrapSessionData,
  createSessionData,
  flushInterrupted,
  reduceSessionData,
} from "./session-data"
import {
  bootstrapSubagentCalls,
  bootstrapSubagentData,
  clearFinishedSubagents,
  createSubagentData,
  listSubagentPermissions,
  listSubagentQuestions,
  listSubagentTabs,
  reduceSubagentData,
  snapshotSelectedSubagentData,
} from "./subagent-data"
import type { Event } from "@opencode-ai/sdk/v2"

let sessionData = createSessionData({ includeUserText: false })
let subagentData = createSubagentData()

export const api = {
  async flushInterrupted() {
    const commits: any[] = []
    flushInterrupted(sessionData, commits)
    return commits
  },
  async bootstrap(input: {
    messages: any[]
    permissions: any[]
    questions: any[]
    children: any[]
  }) {
    bootstrapSessionData({
      data: sessionData,
      messages: input.messages,
      permissions: input.permissions,
      questions: input.questions,
    })
    bootstrapSubagentData({
      data: subagentData,
      messages: input.messages,
      children: input.children,
      permissions: input.permissions,
      questions: input.questions,
    })
  },

  async bootstrapSubagentCalls(input: {
    sessionID: string
    messages: any[]
    thinking: boolean
    limits: Record<string, number>
  }) {
    return bootstrapSubagentCalls({
      data: subagentData,
      sessionID: input.sessionID,
      messages: input.messages,
      thinking: input.thinking,
      limits: input.limits,
    })
  },

  async reduce(input: {
    event: Event
    sessionID: string
    thinking: boolean
    limits: Record<string, number>
  }) {
    const next = reduceSessionData({
      data: sessionData,
      event: input.event,
      sessionID: input.sessionID,
      thinking: input.thinking,
      limits: input.limits,
    })
    sessionData = next.data

    const subagentChanged = reduceSubagentData({
      data: subagentData,
      event: input.event,
      sessionID: input.sessionID,
      thinking: input.thinking,
      limits: input.limits,
    })

    return {
      commits: next.commits,
      footer: next.footer,
      subagentChanged,
      permissions: sessionData.permissions,
      questions: sessionData.questions,
      subagentPermissions: listSubagentPermissions(subagentData),
      subagentQuestions: listSubagentQuestions(subagentData),
      subagentTabs: listSubagentTabs(subagentData),
      activeTools: [...sessionData.tools],
      announced: sessionData.announced,
    }
  },

  async snapshotSubagents(input: { selectedSessionID: string | undefined }) {
    return snapshotSelectedSubagentData(subagentData, input.selectedSessionID)
  },

  async clearFinishedSubagents() {
    const changed = clearFinishedSubagents(subagentData)
    return {
      changed,
      subagentTabs: listSubagentTabs(subagentData),
      subagentPermissions: listSubagentPermissions(subagentData),
      subagentQuestions: listSubagentQuestions(subagentData),
    }
  },

  async getTools() {
    return [...sessionData.tools]
  },

  async setAnnounced(input: { announced: boolean }) {
    sessionData.announced = input.announced
  },

  async isAnnounced() {
    return sessionData.announced
  },
}

rpc.listen(api)
