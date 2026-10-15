import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { keyRingFromParameter, type KeyRing } from "./crypto/blob.js";
import { dynamoUsageStore } from "./usage/dynamo.js";
import { memoryUsageStore } from "./usage/memory.js";
import type { UsageStore } from "./usage/store.js";

export interface Config {
  publicUrl: string;
  keys: KeyRing;
  userSalt: Buffer;
  /** Samply's REST API, `https://samply.app/api/v0`. */
  samplyBaseUrl: string;
  /** Where a user creates a personal access token; named on the consent page. */
  samplyTokenPageUrl: string;
  fetch: typeof fetch;
  usage: UsageStore;
}

export interface SsmLike {
  getParameters(names: string[]): Promise<Record<string, string>>;
}

/** No Samply app credentials: the user brings a personal access token, so we hold only our own keys. */
const PARAM_NAMES = ["signing_key", "user_salt"] as const;

export function ssmFromSdk(client = new SSMClient({})): SsmLike {
  return {
    async getParameters(names) {
      const out = await client.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
      const result: Record<string, string> = {};
      for (const p of out.Parameters ?? []) {
        if (p.Name && p.Value !== undefined) result[p.Name] = p.Value;
      }
      return result;
    },
  };
}

function saltFromHex(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("user_salt must be 64 hex characters");
  return Buffer.from(hex, "hex");
}

export async function loadConfig(deps: { env?: NodeJS.ProcessEnv; ssm?: SsmLike; fetch?: typeof fetch } = {}): Promise<Config> {
  const env = deps.env ?? process.env;
  const publicUrl = env.PUBLIC_URL?.replace(/\/+$/, "");
  if (!publicUrl) throw new Error("PUBLIC_URL is required");
  const usageTableName = env.USAGE_TABLE_NAME;
  if (!usageTableName) throw new Error("USAGE_TABLE_NAME is required");
  const prefix = env.PARAM_PREFIX ?? "/samply_mcp";
  const names = PARAM_NAMES.map((n) => `${prefix}/${n}`);
  const params = await (deps.ssm ?? ssmFromSdk()).getParameters(names);
  const get = (n: (typeof PARAM_NAMES)[number]) => {
    const v = params[`${prefix}/${n}`];
    if (!v) throw new Error(`missing parameter ${prefix}/${n}`);
    return v;
  };
  return {
    publicUrl,
    keys: keyRingFromParameter(get("signing_key")),
    userSalt: saltFromHex(get("user_salt")),
    samplyBaseUrl: "https://samply.app/api/v0",
    samplyTokenPageUrl: "https://samply.app/preferences/api",
    fetch: deps.fetch ?? globalThis.fetch,
    usage: dynamoUsageStore(DynamoDBDocumentClient.from(new DynamoDBClient({})), usageTableName),
  };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    publicUrl: "https://samply-mcp.test",
    keys: keyRingFromParameter(`t1:${"1".repeat(64)}`),
    userSalt: saltFromHex("2".repeat(64)),
    samplyBaseUrl: "https://samply.test/api/v0",
    samplyTokenPageUrl: "https://samply.test/preferences/api",
    fetch: async () => new Response("unexpected fetch", { status: 500 }),
    usage: memoryUsageStore(),
    ...overrides,
  };
}
