export interface KovanicaNetworkConfig {
  chainId: 1 | 2;
  networkTag: string;
  name: string;
  rpcUrl: string;
  explorerUrl: string;
  nativeSymbol: "KVNC";
  gameTokenSymbol: string;
}

export const KOVANICA_NETWORKS: Record<1 | 2, KovanicaNetworkConfig> = {
  2: {
    chainId: 2,
    networkTag: "2-24cdb5fadd98b207",
    name: "Kovanica Testnet (Chain 2)",
    rpcUrl: "https://rpc-testnet.kovanica.online/rpc",
    explorerUrl: "https://testnet.kovanica.online",
    nativeSymbol: "KVNC",
    gameTokenSymbol: "FORGE",
  },
  1: {
    chainId: 1,
    networkTag: "1-f35df34c92001436",
    name: "Kovanica Mainnet (Chain 1 · Jan 1, 2027)",
    rpcUrl: "https://rpc.kovanica.online/rpc",
    explorerUrl: "https://kovanica.online",
    nativeSymbol: "KVNC",
    gameTokenSymbol: "FORGE",
  },
};

export interface WaveCSessionPolicy {
  app: "KOVANICA: FOUNDRY";
  chainId: 1 | 2;
  networkTag: string;
  scope: "match-attestation+rewards";
  maxSpendKvnc: number;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
}

export interface WalletSessionState {
  connected: boolean;
  mode: "guest" | "extension" | "wallet-web" | "testnet-preview";
  address?: string;
  network: KovanicaNetworkConfig;
  sessionKeyActive: boolean;
  sessionKeyExpiry?: string;
  sessionKeySignature?: string;
  stealthPayoutEnabled: boolean;
  stealthMetaAddress?: string;
  kvncBalance: string;
  gameTokenBalance: string;
  rpcHeight?: number;
  rpcHealthy?: boolean;
}

interface InjectedKovanicaProvider {
  request?: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  connect?: () => Promise<{ address?: string } | string>;
  getAccounts?: () => Promise<string[]>;
  signMessage?: (message: string) => Promise<{ signature?: string } | string>;
}

declare global {
  interface Window {
    kovanica?: InjectedKovanicaProvider;
  }
}

const PRO21_REGEX = /^(kvnc|tknc)[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{57}dag$/;
const STEALTH_META_REGEX = /^st:(kvnc|tknc):[a-zA-Z0-9_-]{32,160}$/;
const ATOMS_PER_KVNC = 1_000_000_000;

export function validatePro21Address(address: string): boolean {
  return PRO21_REGEX.test(address.trim());
}

export function validateStealthMetaAddress(meta: string): boolean {
  return STEALTH_META_REGEX.test(meta.trim());
}

export function formatAtomsToKvnc(atomsRaw: string | number | bigint): string {
  try {
    const val = typeof atomsRaw === "bigint" ? atomsRaw : BigInt(String(atomsRaw));
    const whole = val / BigInt(ATOMS_PER_KVNC);
    const frac = Number(val % BigInt(ATOMS_PER_KVNC)) / ATOMS_PER_KVNC;
    return (Number(whole) + frac).toFixed(2);
  } catch {
    return "0.00";
  }
}

export function getActiveNetwork(): KovanicaNetworkConfig {
  const envChain = Number(import.meta.env?.VITE_KOVANICA_CHAIN_ID ?? 2);
  return envChain === 1 ? KOVANICA_NETWORKS[1] : KOVANICA_NETWORKS[2];
}

export function createInitialWalletState(): WalletSessionState {
  return {
    connected: false,
    mode: "guest",
    network: getActiveNetwork(),
    sessionKeyActive: false,
    stealthPayoutEnabled: false,
    kvncBalance: "0.00",
    gameTokenBalance: "0",
  };
}

export function shortAddress(addr?: string): string {
  if (!addr) return "GUEST";
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[] = []): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: T; error?: unknown };
    if (json.error || json.result === undefined) return null;
    return json.result;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchLiveChainTelemetry(
  network: KovanicaNetworkConfig,
  address?: string
): Promise<{ rpcHealthy: boolean; rpcHeight?: number; kvncBalance?: string }> {
  const sync = await rpcCall<{ committed_height?: number; height?: number }>(
    network.rpcUrl,
    "kovanica_syncStatus"
  );
  const rpcHeight = sync?.committed_height ?? sync?.height;
  let kvncBalance: string | undefined;

  if (address && validatePro21Address(address)) {
    const bal = await rpcCall<string | number | { balance?: string | number }>(
      network.rpcUrl,
      "kovanica_getBalance",
      [address]
    );
    if (bal !== null) {
      const raw = typeof bal === "object" ? bal.balance ?? 0 : bal;
      kvncBalance = formatAtomsToKvnc(raw);
    }
  }

  return {
    rpcHealthy: sync !== null,
    rpcHeight,
    kvncBalance,
  };
}

export async function connectKovanicaWallet(
  current: WalletSessionState
): Promise<WalletSessionState> {
  const provider = window.kovanica;
  if (provider) {
    try {
      let address: string | undefined;
      if (typeof provider.connect === "function") {
        const res = await provider.connect();
        address = typeof res === "string" ? res : res?.address;
      } else if (typeof provider.request === "function") {
        const accounts = (await provider.request({ method: "kovanica_requestAccounts" })) as string[];
        address = accounts?.[0];
      } else if (typeof provider.getAccounts === "function") {
        const accounts = await provider.getAccounts();
        address = accounts?.[0];
      }

      if (address) {
        const telemetry = await fetchLiveChainTelemetry(current.network, address);
        return {
          ...current,
          connected: true,
          mode: "extension",
          address,
          kvncBalance: telemetry.kvncBalance ?? "0.00",
          rpcHeight: telemetry.rpcHeight ?? current.rpcHeight,
          rpcHealthy: telemetry.rpcHealthy,
        };
      }
    } catch {
      // Fall through to Testnet preview identity if user dismissed or provider lacks method
    }
  }

  // Local Testnet Chain 2 preview identity when window.kovanica extension is not present
  const randHex = Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  const prefix = current.network.chainId === 1 ? "kvnc1" : "tknc1";
  const telemetry = await fetchLiveChainTelemetry(current.network);
  return {
    ...current,
    connected: true,
    mode: "testnet-preview",
    address: `${prefix}foundry${randHex}`,
    kvncBalance: "0.00 (Preview)",
    rpcHeight: telemetry.rpcHeight ?? current.rpcHeight,
    rpcHealthy: telemetry.rpcHealthy,
  };
}

export async function connectManualPro21Address(
  current: WalletSessionState,
  rawAddress: string
): Promise<{ ok: boolean; state: WalletSessionState; error?: string }> {
  const address = rawAddress.trim();
  if (!validatePro21Address(address)) {
    return {
      ok: false,
      state: current,
      error: "Invalid PRO-21 address (expected 64-char kvnc...dag or tknc...dag).",
    };
  }
  const telemetry = await fetchLiveChainTelemetry(current.network, address);
  return {
    ok: true,
    state: {
      ...current,
      connected: true,
      mode: "wallet-web",
      address,
      kvncBalance: telemetry.kvncBalance ?? "0.00",
      rpcHeight: telemetry.rpcHeight ?? current.rpcHeight,
      rpcHealthy: telemetry.rpcHealthy,
    },
  };
}

export function buildWaveCSessionPolicy(network: KovanicaNetworkConfig): WaveCSessionPolicy {
  const now = Date.now();
  const nonce = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return {
    app: "KOVANICA: FOUNDRY",
    chainId: network.chainId,
    networkTag: network.networkTag,
    scope: "match-attestation+rewards",
    maxSpendKvnc: 0,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
    nonce,
  };
}

export async function activateWaveCSessionKey(
  current: WalletSessionState
): Promise<WalletSessionState> {
  if (!current.connected) return current;
  const policy = buildWaveCSessionPolicy(current.network);
  const message = `KOVANICA_WAVE_C_SESSION_KEY\n${JSON.stringify(policy)}`;
  let signature = `preview_${policy.nonce}`;

  const provider = window.kovanica;
  if (current.mode === "extension" && provider) {
    try {
      if (typeof provider.signMessage === "function") {
        const res = await provider.signMessage(message);
        signature = typeof res === "string" ? res : res?.signature ?? signature;
      } else if (typeof provider.request === "function") {
        const res = (await provider.request({
          method: "kovanica_signMessage",
          params: [message],
        })) as { signature?: string } | string;
        signature = typeof res === "string" ? res : res?.signature ?? signature;
      }
    } catch {
      // Keep session inactive if extension user explicitly rejected signing
      return current;
    }
  }

  const expiry = new Date(policy.expiresAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return {
    ...current,
    sessionKeyActive: true,
    sessionKeyExpiry: `24h (until ${expiry})`,
    sessionKeySignature: signature,
  };
}
