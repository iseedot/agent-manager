import { z } from "zod";

/**
 * What the daemon stores on discovery and hands back to `fetch()`: the path to pi's login store on
 * the daemon host. It is the only input the usage source has.
 */
export const usageInputSchema = z.object({ path: z.string().min(1) }).strict();
export type UsageInput = z.infer<typeof usageInputSchema>;
