import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ResolvedWeChatAccount } from "./types.js";
import type { WechatStabilityProfile } from "./stability.js";

export type PersistedPendingLoginState = {
  wId: string;
  qrCodeUrl: string;
  issuedAt: number;
  expiresAt: number;
  lastRenderedAt?: number;
  verifyUrl?: string;
};

type PersistedCircuitState = {
  consecutiveFailures: number;
  lastFailureAt?: number;
  lastError?: string;
  circuitOpenUntil?: number;
};

type PersistedWechatAccountState = {
  wcId?: string;
  nickName?: string;
  headUrl?: string;
  isLoggedIn?: boolean;
  lastLoginAt?: number;
  lastStatusAt?: number;
  lastQrIssuedAt?: number;
  lastQrExpiresAt?: number;
  pendingLogin?: PersistedPendingLoginState;
  startup?: PersistedCircuitState;
  outbound?: PersistedCircuitState;
};

type PersistedWechatState = {
  version: 1;
  accounts: Record<string, PersistedWechatAccountState>;
};

const DEFAULT_STATE: PersistedWechatState = {
  version: 1,
  accounts: {},
};
const ABORT_LIKE_ERROR_PATTERN = /流程已中止|登录流程已中止|aborted|abort/i;

function resolveStateFile(profile: WechatStabilityProfile): string {
  if (profile.stateFile?.trim()) {
    return profile.stateFile;
  }
  const home = process.env.HOME || process.cwd();
  return path.join(home, ".openclaw", "wechat-state.json");
}

function loadState(file: string): PersistedWechatState {
  if (!existsSync(file)) {
    return { ...DEFAULT_STATE, accounts: {} };
  }

  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as PersistedWechatState;
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || typeof parsed.accounts !== "object") {
      return { ...DEFAULT_STATE, accounts: {} };
    }
    return {
      version: 1,
      accounts: parsed.accounts || {},
    };
  } catch {
    return { ...DEFAULT_STATE, accounts: {} };
  }
}

function saveState(file: string, state: PersistedWechatState): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tempFile = `${file}.tmp`;
  writeFileSync(tempFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tempFile, file);
}

function sanitizeCircuitState(state: PersistedCircuitState | undefined): PersistedCircuitState {
  if (!state) {
    return { consecutiveFailures: 0 };
  }

  if (state.lastError && ABORT_LIKE_ERROR_PATTERN.test(state.lastError)) {
    return { consecutiveFailures: 0 };
  }

  if (state.circuitOpenUntil && state.circuitOpenUntil <= Date.now()) {
    return { consecutiveFailures: 0 };
  }

  return state;
}

function mutateAccountState<T>(
  account: ResolvedWeChatAccount,
  profile: WechatStabilityProfile,
  mutate: (state: PersistedWechatAccountState) => T
): T {
  const file = resolveStateFile(profile);
  const root = loadState(file);
  const state = root.accounts[account.accountId] ?? {};
  root.accounts[account.accountId] = state;
  const result = mutate(state);
  saveState(file, root);
  return result;
}

export function hydrateAccountFromPersistentState(
  account: ResolvedWeChatAccount,
  profile: WechatStabilityProfile
): void {
  const file = resolveStateFile(profile);
  const root = loadState(file);
  const state = root.accounts[account.accountId];
  if (!state) {
    return;
  }

  if (state.wcId && !account.wcId) {
    account.wcId = state.wcId;
    account.config.wcId = state.wcId;
  }
  if (state.nickName && !account.nickName) {
    account.nickName = state.nickName;
    account.config.nickName = state.nickName;
  }
  if (state.headUrl && !account.headUrl) {
    account.headUrl = state.headUrl;
  }
  if (typeof state.isLoggedIn === "boolean") {
    account.isLoggedIn = state.isLoggedIn;
  }
}

export function getPendingLoginState(
  account: ResolvedWeChatAccount,
  profile: WechatStabilityProfile
): PersistedPendingLoginState | null {
  const file = resolveStateFile(profile);
  const state = loadState(file).accounts[account.accountId];
  if (!state?.pendingLogin) {
    return null;
  }
  if (state.pendingLogin.expiresAt <= Date.now()) {
    clearPendingLoginState(account, profile);
    return null;
  }
  return state.pendingLogin;
}

export function recordPendingLoginState(
  account: ResolvedWeChatAccount,
  profile: WechatStabilityProfile,
  pendingLogin: PersistedPendingLoginState
): void {
  mutateAccountState(account, profile, (state) => {
    state.pendingLogin = pendingLogin;
    state.isLoggedIn = false;
    state.lastStatusAt = Date.now();
    state.lastQrIssuedAt = pendingLogin.issuedAt;
    state.lastQrExpiresAt = pendingLogin.expiresAt;
  });
  account.isLoggedIn = false;
}

export function getLastQrIssuedAt(account: ResolvedWeChatAccount, profile: WechatStabilityProfile): number | null {
  const file = resolveStateFile(profile);
  const state = loadState(file).accounts[account.accountId];
  return state?.lastQrIssuedAt ?? null;
}

export function markPendingLoginRendered(
  account: ResolvedWeChatAccount,
  profile: WechatStabilityProfile,
  renderedAt: number
): void {
  mutateAccountState(account, profile, (state) => {
    if (state.pendingLogin) {
      state.pendingLogin.lastRenderedAt = renderedAt;
    }
  });
}

export function markPendingLoginVerifyUrl(
  account: ResolvedWeChatAccount,
  profile: WechatStabilityProfile,
  verifyUrl: string
): void {
  mutateAccountState(account, profile, (state) => {
    if (state.pendingLogin) {
      state.pendingLogin.verifyUrl = verifyUrl;
    }
  });
}

export function clearPendingLoginState(account: ResolvedWeChatAccount, profile: WechatStabilityProfile): void {
  mutateAccountState(account, profile, (state) => {
    delete state.pendingLogin;
  });
}

export function recordLoginSuccessState(
  account: ResolvedWeChatAccount,
  profile: WechatStabilityProfile,
  payload: {
    wcId: string;
    nickName?: string;
    headUrl?: string;
  }
): void {
  mutateAccountState(account, profile, (state) => {
    state.wcId = payload.wcId;
    state.nickName = payload.nickName;
    state.headUrl = payload.headUrl;
    state.isLoggedIn = true;
    state.lastLoginAt = Date.now();
    state.lastStatusAt = Date.now();
    delete state.pendingLogin;
    state.startup = {
      consecutiveFailures: 0,
      lastFailureAt: state.startup?.lastFailureAt,
      lastError: undefined,
      circuitOpenUntil: undefined,
    };
  });
}

export function recordLoggedOutState(
  account: ResolvedWeChatAccount,
  profile: WechatStabilityProfile,
  reason?: string
): void {
  mutateAccountState(account, profile, (state) => {
    state.isLoggedIn = false;
    state.lastStatusAt = Date.now();
    delete state.pendingLogin;
    if (reason) {
      state.startup = {
        consecutiveFailures: state.startup?.consecutiveFailures ?? 0,
        lastFailureAt: Date.now(),
        lastError: reason,
        circuitOpenUntil: state.startup?.circuitOpenUntil,
      };
    }
  });
  account.isLoggedIn = false;
}

export function getStartupCircuitState(
  account: ResolvedWeChatAccount,
  profile: WechatStabilityProfile
): PersistedCircuitState {
  const file = resolveStateFile(profile);
  return sanitizeCircuitState(loadState(file).accounts[account.accountId]?.startup);
}

export function recordStartupFailureState(
  account: ResolvedWeChatAccount,
  profile: WechatStabilityProfile,
  reason: string
): PersistedCircuitState {
  return mutateAccountState(account, profile, (state) => {
    const nextFailures = (state.startup?.consecutiveFailures ?? 0) + 1;
    const circuitOpenUntil = nextFailures >= profile.startupCircuitBreakerThreshold
      ? Date.now() + profile.startupCircuitOpenMs
      : undefined;
    const nextState: PersistedCircuitState = {
      consecutiveFailures: nextFailures,
      lastFailureAt: Date.now(),
      lastError: reason,
      circuitOpenUntil,
    };
    state.startup = nextState;
    state.isLoggedIn = false;
    return nextState;
  });
}

export function recordStartupSuccessState(
  account: ResolvedWeChatAccount,
  profile: WechatStabilityProfile
): void {
  mutateAccountState(account, profile, (state) => {
    state.startup = {
      consecutiveFailures: 0,
      lastFailureAt: state.startup?.lastFailureAt,
      lastError: undefined,
      circuitOpenUntil: undefined,
    };
    state.lastStatusAt = Date.now();
  });
}

export function getOutboundCircuitState(
  account: ResolvedWeChatAccount,
  profile: WechatStabilityProfile
): PersistedCircuitState {
  const file = resolveStateFile(profile);
  return sanitizeCircuitState(loadState(file).accounts[account.accountId]?.outbound);
}

export function recordOutboundFailureState(
  account: ResolvedWeChatAccount,
  profile: WechatStabilityProfile,
  reason: string
): PersistedCircuitState {
  return mutateAccountState(account, profile, (state) => {
    const nextFailures = (state.outbound?.consecutiveFailures ?? 0) + 1;
    const circuitOpenUntil = nextFailures >= profile.outboundCircuitBreakerThreshold
      ? Date.now() + profile.outboundCircuitOpenMs
      : undefined;
    const nextState: PersistedCircuitState = {
      consecutiveFailures: nextFailures,
      lastFailureAt: Date.now(),
      lastError: reason,
      circuitOpenUntil,
    };
    state.outbound = nextState;
    state.lastStatusAt = Date.now();
    return nextState;
  });
}

export function recordOutboundSuccessState(
  account: ResolvedWeChatAccount,
  profile: WechatStabilityProfile
): void {
  mutateAccountState(account, profile, (state) => {
    state.outbound = {
      consecutiveFailures: 0,
      lastFailureAt: state.outbound?.lastFailureAt,
      lastError: undefined,
      circuitOpenUntil: undefined,
    };
    state.lastStatusAt = Date.now();
  });
}
