export type CameraFacingMode = 'environment' | 'user' | { ideal: 'environment' }

function isUserFacing(facingMode: CameraFacingMode): boolean {
  return facingMode === 'user'
}

function normalizedLabel(device: MediaDeviceInfo): string {
  return device.label.trim().toLowerCase()
}

function isFrontCameraLabel(label: string): boolean {
  return /\b(front|user|selfie)\b/.test(label)
}

function isRearCameraLabel(label: string): boolean {
  return /\b(back|rear|environment)\b/.test(label)
}

function isCameraZeroLabel(label: string): boolean {
  return /\bcamera\s*0\b|\bcamera0\b|\b0,\s*facing\b|\b0\b/.test(label)
}

export async function preferredCameraDeviceId(
  facingMode: CameraFacingMode = { ideal: 'environment' },
  explicitDeviceId?: string | null,
): Promise<string | null> {
  if (isUserFacing(facingMode)) return null
  if (explicitDeviceId) return explicitDeviceId

  try {
    const devices = await navigator.mediaDevices?.enumerateDevices?.()
    const videoInputs = devices?.filter(device => device.kind === 'videoinput') ?? []
    const labeledInputs = videoInputs.filter(device => normalizedLabel(device))

    const rearCameraZero = labeledInputs.find(device => {
      const label = normalizedLabel(device)
      return isCameraZeroLabel(label) && !isFrontCameraLabel(label)
    })
    if (rearCameraZero?.deviceId) return rearCameraZero.deviceId

    const rearCamera = labeledInputs.find(device => {
      const label = normalizedLabel(device)
      return isRearCameraLabel(label) && !isFrontCameraLabel(label)
    })
    if (rearCamera?.deviceId) return rearCamera.deviceId

    return null
  } catch {
    return null
  }
}
