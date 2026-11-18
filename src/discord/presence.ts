/**
 * One fixed M0 presence payload. No templates, reducer, rotation or config.
 * The asset object is native Discord `assets`; `largeImageKey` is never sent.
 */
export const CLIENT_ID = "1572459187873783838"
export const M0_DETAILS = "M0 transmission test"
export const M0_STATE = "M0 · events observed"
export const M0_LARGE_IMAGE = "state-working"
export const M0_LARGE_TEXT = "OpenCode — Working"
export const M0_SMALL_IMAGE = "badge-model"

export interface PresenceModel {
  id: string
  providerID: string
}

export interface PresenceActivity {
  details: "M0 transmission test"
  state: "M0 · events observed"
  assets: {
    large_image: "state-working"
    large_text: "OpenCode — Working"
    small_image: "badge-model"
    small_text: string
  }
  timestamps: {
    start: number
  }
}

export interface TimestampProvenance {
  seconds: number
  sourceField: string
  originalValue: number
  originalUnit: "milliseconds since Unix epoch"
  conversion: "floor(ms / 1000)"
}

export function buildActivity(model: PresenceModel, timestampSeconds: number): PresenceActivity {
  if (!Number.isSafeInteger(timestampSeconds)) {
    throw new Error(`timestamps.start must be an integer Unix second, got ${String(timestampSeconds)}`)
  }
  if (!model.providerID || !model.id) {
    throw new Error("model provider and id are required for small_text")
  }
  return {
    details: M0_DETAILS,
    state: M0_STATE,
    assets: {
      large_image: M0_LARGE_IMAGE,
      large_text: M0_LARGE_TEXT,
      small_image: M0_SMALL_IMAGE,
      small_text: `Model: ${model.providerID}/${model.id}`,
    },
    timestamps: { start: timestampSeconds },
  }
}

export interface ActivityValidation {
  ok: boolean
  problems: string[]
}

export function validateActivity(value: unknown): ActivityValidation {
  const problems: string[] = []
  if (!value || typeof value !== "object") return { ok: false, problems: ["activity is not an object"] }
  const activity = value as Record<string, unknown>

  if (activity.details !== M0_DETAILS) problems.push(`details must be exactly ${JSON.stringify(M0_DETAILS)}`)
  if (activity.state !== M0_STATE) problems.push(`state must be exactly ${JSON.stringify(M0_STATE)}`)
  if ("largeImageKey" in activity || "smallImageKey" in activity) problems.push("non-native image key field present")

  const assets = activity.assets
  if (!assets || typeof assets !== "object") {
    problems.push("assets is missing")
  } else {
    const record = assets as Record<string, unknown>
    if (record.large_image !== M0_LARGE_IMAGE) problems.push(`assets.large_image must be ${M0_LARGE_IMAGE}`)
    if (record.large_text !== M0_LARGE_TEXT) problems.push(`assets.large_text must be ${M0_LARGE_TEXT}`)
    if (record.small_image !== M0_SMALL_IMAGE) problems.push(`assets.small_image must be ${M0_SMALL_IMAGE}`)
    if (typeof record.small_text !== "string" || !/^Model: [^/]+\/.+$/.test(record.small_text)) {
      problems.push("assets.small_text must read 'Model: <provider>/<model>'")
    }
  }

  const timestamps = activity.timestamps
  if (!timestamps || typeof timestamps !== "object") {
    problems.push("timestamps is missing")
  } else {
    const start = (timestamps as Record<string, unknown>).start
    if (!Number.isSafeInteger(start)) problems.push("timestamps.start must be an integer Unix second")
    else if ((start as number) < 1_000_000_000) problems.push("timestamps.start is not a plausible Unix second")
  }

  return { ok: problems.length === 0, problems }
}
