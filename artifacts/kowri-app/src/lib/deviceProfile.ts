export interface DeviceProfile {
  isLowDevice: boolean;
  isSlowNetwork: boolean;
  shouldReduceEffects: boolean;
  reducedMotion: boolean;
}

function readDeviceMemory(): number {
  if (typeof navigator === "undefined") return 8;
  const value = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return Number.isFinite(Number(value)) ? Number(value) : 8;
}

function readHardwareConcurrency(): number {
  if (typeof navigator === "undefined") return 8;
  const value = navigator.hardwareConcurrency;
  return Number.isFinite(Number(value)) ? Number(value) : 8;
}

function readNetworkInfo(): { effectiveType: string; saveData: boolean } {
  if (typeof navigator === "undefined") return { effectiveType: "4g", saveData: false };
  const connection = (
    navigator as Navigator & {
      connection?: { effectiveType?: string; saveData?: boolean };
    }
  ).connection;
  return {
    effectiveType: connection?.effectiveType ?? "4g",
    saveData: Boolean(connection?.saveData),
  };
}

export function getDeviceProfile(): DeviceProfile {
  const memory = readDeviceMemory();
  const cores = readHardwareConcurrency();
  const network = readNetworkInfo();
  const slowNetwork = network.saveData || network.effectiveType === "2g" || network.effectiveType === "slow-2g";
  const isLowDevice = memory <= 2 || cores <= 4;

  return {
    isLowDevice,
    isSlowNetwork: slowNetwork,
    shouldReduceEffects: isLowDevice || slowNetwork,
    reducedMotion: isLowDevice || slowNetwork,
  };
}

export function useDeviceProfile(): DeviceProfile {
  return getDeviceProfile();
}

