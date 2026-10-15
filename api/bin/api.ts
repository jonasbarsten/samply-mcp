import { App, Tags } from "aws-cdk-lib";
import { ApiStack } from "../lib/api-stack.js";
import { synthesizer } from "../lib/synthesizer.js";

const app = new App();
Tags.of(app).add("Project", "samply-mcp");
new ApiStack(app, "samply-mcp-api", { env: { account: "209479295726", region: "eu-west-1" }, synthesizer: synthesizer() });
