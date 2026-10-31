import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMagpie } from "./src/extension.ts";

export default async function (pi: ExtensionAPI) {
  await registerMagpie(pi, join(getAgentDir(), "magpie.json"));
}
