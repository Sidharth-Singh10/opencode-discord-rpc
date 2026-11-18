import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/plugin"
import { inspectSession } from "../src/m0/probe.js"

const model = { id: "deepseek-v4.1-flash-free", providerID: "opencode" }
const older = { type: "assistant", model, agent: "build" }
const credential = { credentials: { token: "NEWEST_CREDENTIAL_CONTAINER" } }
function context(messages: unknown[]): Context {
  return {
    data: { session: {
      get: () => ({ model, agent: "build", cost: 0 }),
      status: () => "running",
      cost: () => 0,
      message: { list: () => messages, sync: async () => {} },
    } },
    ui: { model: { current: () => ({ modelID: model.id, providerID: model.providerID }) } },
  } as unknown as Context
}
for (const identity of [
  { name: "credential-container model", model: { ...model, id: credential }, agent: "plan", validModel: false, modelCode: "executed-model-unknown" },
  { name: "unsupported model", model: { ...model, id: "unsupported-newest-model" }, agent: "plan", validModel: false, modelCode: "executed-model-unknown" },
  { name: "credential-container provider", model: { ...model, providerID: credential }, agent: "plan", validModel: false, modelCode: "executed-provider-unknown" },
  { name: "unsupported provider", model: { ...model, providerID: "unsupported-newest-provider" }, agent: "plan", validModel: false, modelCode: "executed-provider-unknown" },
  { name: "credential-container variant", model: { ...model, variant: credential }, agent: "plan", validModel: false, modelCode: "executed-variant-unknown" },
  { name: "unsupported variant", model: { ...model, variant: "unsupported-newest-variant" }, agent: "plan", validModel: false, modelCode: "executed-variant-unknown" },
  { name: "credential-container agent", model, agent: credential, validModel: true, modelCode: null, invalidAgent: true },
  { name: "agent path", model, agent: "unsupported-newest-agent/bad", validModel: true, modelCode: null, invalidAgent: true },
  { name: "agent query", model, agent: "unsupported-newest-agent=bad", validModel: true, modelCode: null, invalidAgent: true },
] as const) {
  test(`newest assistant ${identity.name} never borrows a supported identity`, async () => {
    const inspection = await inspectSession(context([
      older,
      { type: "assistant", model: identity.model, agent: identity.agent },
      { type: "user", time: { created: 1_750_000_000_123 } },
    ]), "ses_newest", "salt")
    expect(inspection.executedModel).toEqual(identity.validModel ? model : null)
    expect(inspection.executedModelCode).toBe(identity.modelCode)
    expect(inspection.agent).toBe(identity.agent === "plan" ? "plan" : null)
    expect(inspection.agentCode).toBe(identity.agent === "plan" ? null : "executed-agent-unknown")
    expect(JSON.stringify(inspection)).not.toContain("NEWEST_CREDENTIAL_CONTAINER")
    expect(JSON.stringify(inspection)).not.toContain("unsupported-newest-")
  })
}

test("newest supported assistant supplies model, provider and agent together", async () => {
  const newest = { id: "deepseek-v4.1-flash", providerID: "opencode-go" }
  const inspection = await inspectSession(context([
    older,
    { type: "assistant", model: newest, agent: "plan" },
  ]), "ses_newest", "salt")
  expect(inspection.executedModel).toEqual(newest)
  expect(inspection.agent).toBe("plan")
  expect(inspection.selectedModel).toEqual(model)
})

test("no assistant means no executed identity even if the session has a selection", async () => {
  const inspection = await inspectSession(context([
    { type: "user", time: { created: 1_750_000_000_123 } },
  ]), "ses_newest", "salt")
  expect(inspection.executedModel).toBeNull()
  expect(inspection.agent).toBeNull()
})
