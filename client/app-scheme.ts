import { Linking } from "react-native";

/**
 * The URL schemes this app answers to, most specific first.
 *
 * Upstream Paseo registers `paseo`. A fork that renames the scheme — this one ships as
 * `paseo-custom` so the official app and this build can be installed side by side — has to list its
 * own scheme here. `paseo` stays last as a fallback, so the same bundle still works when it runs
 * inside an unmodified Paseo build.
 */
const APP_SCHEMES = ["paseo-custom", "paseo"] as const;

interface LinkModule {
  canOpenURL?: (url: string) => Promise<boolean>;
  openURL?: (url: string) => Promise<unknown>;
}

function linkModule(): LinkModule {
  return (Linking ?? {}) as LinkModule;
}

async function canOpen(scheme: string): Promise<boolean> {
  const link = linkModule();
  if (typeof link.canOpenURL !== "function") {
    // No probe available: let the open attempt decide.
    return true;
  }
  try {
    return await link.canOpenURL(`${scheme}:`);
  } catch {
    return false;
  }
}

/**
 * Opens an in-app route — `/h/<serverId>/agent/<agentId>`, `/h/<serverId>/workspace/<id>?open=…` —
 * through whichever scheme this build registers. Resolves whether a scheme accepted it.
 */
export async function openAppRoute(route: string): Promise<boolean> {
  const link = linkModule();
  if (typeof link.openURL !== "function") {
    return false;
  }
  const path = route.startsWith("/") ? route : `/${route}`;
  // Prefer a scheme the platform confirms. When none does, try them anyway: a host that cannot
  // answer `canOpenURL` (some Android builds without a <queries> entry) would otherwise be skipped.
  const probed: string[] = [];
  for (const scheme of APP_SCHEMES) {
    if (await canOpen(scheme)) {
      probed.push(scheme);
    }
  }
  for (const scheme of probed.length > 0 ? probed : APP_SCHEMES) {
    try {
      await link.openURL(`${scheme}:${path}`);
      return true;
    } catch {
      // This scheme is not registered on this host; try the next one.
    }
  }
  return false;
}
