import { createRequire as __createRequire } from "node:module";
import { dirname as __pathDirname } from "node:path";
import { fileURLToPath as __fileURLToPath } from "node:url";
const require = __createRequire(import.meta.url);
var __filename = __fileURLToPath(import.meta.url);
var __dirname = __pathDirname(__filename);
var l=Object.defineProperty;var s=(e,i)=>l(e,"name",{value:i,configurable:!0});function n(e){let i=e.providers.register({id:"pi-durable",displayName:"Pi Durable",icon:"./icons/pi-durable.svg",strings:{signInHint:"Run `pi` on the machine to sign in.",expiredHint:"Your Pi session expired. Run `pi`, then reload.",installUrl:"https://pi.dev",iconTint:{light:"#10B981",dark:"#10B981"}},maintenance:{health:!0,usage:!1,installation:!0},env:{passthrough:["BB_PI_DURABLE_BRIDGE_COMMAND","BB_PI_DURABLE_BRIDGE_ARGS"]},capabilities:{supportsServiceTier:!1,supportsNativeUserQuestion:!1,fork:"checkpoint",supportsManualCompaction:!0,supportsThreadArchive:!1,supportsThreadRename:!1,permissionModes:["full"],reasoningLevels:["none","low","medium","high","xhigh","max"]},reasoningLevels:[{id:"none",label:"None"},{id:"low",label:"Low"},{id:"medium",label:"Medium"},{id:"high",label:"High"},{id:"xhigh",label:"Extra High"},{id:"max",label:"Max"}],experimental_nativeSkillRoots:{user:[".pi/agent/skills",".agents/skills"],project:[".pi/skills",".agents/skills"]},experimental_resolvesNativeRoots:!0,composerActions:[]});e.onDispose?.(()=>{i.dispose?.()})}s(n,"plugin");export{n as default};
//# sourceMappingURL=server.js.map
