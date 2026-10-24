import {
  defineTranslations as defineTranslationsFromSdk,
  useTranslation as useTranslationFromSdk,
} from "@getpaseo/plugin/client";
import type { PluginText } from "@getpaseo/plugin/client";

import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

type Resource = typeof en;
export type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The subset of the 0.13 translation API this module needs, kept optional for older hosts. */
interface Messages {
  readonly resources: { en: Resource };
  message(key: string): PluginText;
}

interface SdkMessages {
  message(key: string): PluginText;
}

interface SdkTranslationApi {
  defineTranslations?: (input: { resources: Record<string, unknown> }) => SdkMessages;
  useTranslation?: (messages: unknown) => { locale: string; t: Translate };
}

// The app supplies its own copy of the SDK, so a 0.12 app simply has no translation exports. The
// fallback keeps the settings screen working there instead of failing the whole client bundle.
const sdk = {
  defineTranslations: defineTranslationsFromSdk,
  useTranslation: useTranslationFromSdk,
} as unknown as SdkTranslationApi;

function lookup(key: string): string | undefined {
  const value = (en as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function translateEnglish(key: string, options: Record<string, unknown> = {}): string {
  const count = options.count;
  const plural =
    typeof count === "number" ? lookup(`${key}_${count === 1 ? "one" : "other"}`) : undefined;
  const template = plural ?? lookup(key);
  if (template === undefined) {
    return key;
  }
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, name: string) => {
    const value = options[name];
    return value === undefined ? "" : String(value);
  });
}

const fallbackMessages: Messages = {
  resources: { en },
  message: (key) => translateEnglish(key),
};

const sdkMessages =
  typeof sdk.defineTranslations === "function"
    ? sdk.defineTranslations({ resources: { en, "zh-CN": zhCN } })
    : null;

/** Persistent labels (the settings screen title) and the runtime translation hook. */
export const messages: Messages = sdkMessages
  ? { resources: { en }, message: (key) => sdkMessages.message(key) }
  : fallbackMessages;

export interface PluginMessages {
  locale: string;
  t: Translate;
}

export const useMessages: () => PluginMessages =
  typeof sdk.useTranslation === "function" && sdkMessages
    ? () => sdk.useTranslation!(sdkMessages) as PluginMessages
    : () => ({ locale: "en", t: translateEnglish });
