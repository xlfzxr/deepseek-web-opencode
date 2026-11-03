// Resolve the static dashboard directory for the API workspace.
import { fileURLToPath } from "node:url";

export const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
