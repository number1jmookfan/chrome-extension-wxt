export class RecorderService {
  // Recording state for Playwright replay (starts recording by default)
  private recordingActive = true
  private recordedSteps: RecordedStep[] = []

  async recorderEvent(payload: RecorderEvent): Promise<boolean> {
    const { kind, selector, xpath, url, value, description } = payload
    remoteLog("recorder:event, " + kind, "info")
    if (this.recordingActive) {
      const base = {
        selector,
        xpath,
        pageUrl: url,
        timestamp: Date.now(),
        description
      }
      if (kind === "click") {
        this.recordedSteps.push({ type: "click", ...base })
        return true
      } else if (kind === "fill") {
        this.recordedSteps.push({ type: "fill", ...base, value })
        return true
      } else if (kind === "select") {
        this.recordedSteps.push({ type: "select", ...base, value })
        return true
      }
    }
    return false
  }
}
