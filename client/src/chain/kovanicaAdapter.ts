export interface KovanicaNetworkConfig {
  chainId: 1 | 2;
  name: string;
  rpcUrl: string;
  explorerUrl: string;
  nativeSymbol: "KVNC";
  gameTokenSymbol: string;
}

export const KOVANICA_NETWORKS: Record<1 | 2, KovanicaNetworkConfig> = {
  2: {
    chainId: 2,
    name: "Kovanica Testnet (Chain 2)",
    rpcUrl: "https://rpc-testnet.kovanica.online/rpc",
    explorerUrl: "https://testnet.kovanica.online",
    nativeSymbol: "KVNC",
    gameTokenSymbol: "<GAME_TOKEN>",
  },
  1: {
    chainId: 1,
    name: "Kovanica Mainnet (Chain 1 · Jan 1, 2027)",
    rpcUrl: "https://rpc.kovanica.online/rpc",
    explorerUrl: "https://kovanica.online",
    nativeSymbol: "KVNC",
    gameTokenSymbol: "<GAME_TOKEN>",
  },
};

export interface WalletSessionState {
  connected: boolean;
  mode: "guest" | "extension" | "testnet-preview";
  address?: string;
  network: KovanicaNetworkConfig;
  sessionKeyActive: boolean;
  sessionKeyExpiry?: string;
  stealthPayoutEnabled: boolean;
  kvncBalance: string;
  gameTokenBalance: string;
}

interface InjectedKovanicaProvider {
  request?: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  connect?: () => Promise<{ address?: string } | string>;
  getAccounts?: () => Promise<string[]>;
}

declare global {
  interface Window {
    kovanica?: InjectedKovanicaProvider;
  }
}

export function getActiveNetwork(): KovanicaNetworkConfig {
  const envChain = Number(import.meta.env.VITE_KOVANICA_CHAIN_ID ?? 2);
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
        return {
          ...current,
          connected: true,
          mode: "extension",
          address,
          kvncBalance: "125.00",
          gameTokenBalance: "420",
        };
      }
    } catch {
      // Fall through to Testnet preview identity if user dismissed or provider lacks method
    }
  }

  // Local Testnet Chain 2 preview identity when window.kovanica extension is not present
  const randHex = Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  const prefix = current.network.chainId === 1 ? "kvnc1" : "tkvnc1";
  return {
    ...current,
    connected: true,
    mode: "testnet-preview",
    address: `${prefix}foundry${randHex}`,
    kvncBalance: "50.00 (Testnet)",
    gameTokenBalance: "180",
  };
}

export async function activateWaveCSessionKey(
  current: WalletSessionState
): Promise<WalletSessionState> {
  if (!current.connected) return current;
  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return {
    ...current,
    sessionKeyActive: true,
    sessionKeyExpiry: `24h (until ${expiry})`,
  };
}
