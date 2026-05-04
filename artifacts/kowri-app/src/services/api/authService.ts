import { apiFetch } from "@/lib/api";
import type { AuthUser } from "@/lib/auth";

export type AuthFastProviders = {
  googleEnabled: boolean;
  appleEnabled: boolean;
};

export type KycLimitStatus = {
  level: number;
  monthlyLimitXof: number;
  monthlyUsedXof: number;
  monthlyRemainingXof: number;
  nextLevelHint: string;
};

export type AuthMeta = {
  primaryMethod: string;
  suspicious: boolean;
  riskScore: number;
  deviceTrustScore: number;
  weakNetworkMode: boolean;
  kyc: KycLimitStatus;
};

export type AuthSuccessResponse = {
  token: string;
  expiresAt: string;
  user: AuthUser;
  authMeta?: AuthMeta;
};

export type OtpRequestResponse = {
  challengeId: string;
  expiresAt: string;
  delivery: "sms";
  debugOtp?: string;
  fastProviders: AuthFastProviders;
};

export function buildDeviceHeaders(deviceId: string | null): Record<string, string> {
  if (!deviceId) return {};
  return { "x-device-id": deviceId };
}

export async function requestOtp(input: {
  phone: string;
  purpose?: "login" | "register" | "pin_reset";
  deviceId?: string | null;
  deviceLabel?: string;
}): Promise<OtpRequestResponse> {
  return apiFetch<OtpRequestResponse>("/auth/otp/request", null, {
    method: "POST",
    headers: buildDeviceHeaders(input.deviceId ?? null),
    body: JSON.stringify({
      phone: input.phone,
      purpose: input.purpose ?? "login",
      deviceLabel: input.deviceLabel ?? "",
    }),
    policy: { retries: 0 },
  });
}

export async function verifyOtp(input: {
  challengeId: string;
  phone: string;
  otp: string;
  deviceId?: string | null;
  deviceLabel?: string;
}): Promise<AuthSuccessResponse> {
  return apiFetch<AuthSuccessResponse>("/auth/otp/verify", null, {
    method: "POST",
    headers: buildDeviceHeaders(input.deviceId ?? null),
    body: JSON.stringify({
      challengeId: input.challengeId,
      phone: input.phone,
      otp: input.otp,
      deviceLabel: input.deviceLabel ?? "",
    }),
    policy: { retries: 0 },
  });
}

export async function loginWithPin(input: {
  phone: string;
  pin: string;
  deviceId?: string | null;
  deviceLabel?: string;
}): Promise<AuthSuccessResponse> {
  return apiFetch<AuthSuccessResponse>("/auth/pin/login", null, {
    method: "POST",
    headers: buildDeviceHeaders(input.deviceId ?? null),
    body: JSON.stringify({
      phone: input.phone,
      pin: input.pin,
      deviceLabel: input.deviceLabel ?? "",
    }),
    policy: { retries: 0 },
  });
}

export async function loginWithSocial(input: {
  provider: "google" | "apple";
  phone: string;
  deviceId?: string | null;
  deviceLabel?: string;
}): Promise<AuthSuccessResponse> {
  return apiFetch<AuthSuccessResponse>("/auth/social/login", null, {
    method: "POST",
    headers: buildDeviceHeaders(input.deviceId ?? null),
    body: JSON.stringify({
      provider: input.provider,
      phone: input.phone,
      deviceLabel: input.deviceLabel ?? "",
    }),
    policy: { retries: 0 },
  });
}

export async function enableBiometric(input: {
  userId: string;
  unlockToken: string;
  deviceId?: string | null;
  deviceLabel?: string;
}): Promise<{ enabled: boolean; message: string }> {
  return apiFetch<{ enabled: boolean; message: string }>("/auth/biometric/enable", null, {
    method: "POST",
    headers: buildDeviceHeaders(input.deviceId ?? null),
    body: JSON.stringify({
      userId: input.userId,
      unlockToken: input.unlockToken,
      deviceLabel: input.deviceLabel ?? "",
    }),
    policy: { retries: 0 },
  });
}

export async function loginWithBiometric(input: {
  userId: string;
  unlockToken: string;
  deviceId?: string | null;
  deviceLabel?: string;
}): Promise<AuthSuccessResponse> {
  return apiFetch<AuthSuccessResponse>("/auth/biometric/login", null, {
    method: "POST",
    headers: buildDeviceHeaders(input.deviceId ?? null),
    body: JSON.stringify({
      userId: input.userId,
      unlockToken: input.unlockToken,
      deviceLabel: input.deviceLabel ?? "",
    }),
    policy: { retries: 0 },
  });
}
